"""Market data + indicator calculations for the NSE strategy screener.

The server computes raw metrics for every stock (moving averages, RSI,
52-week high, volume spike, P/E, P/B, ROE, D/E). The browser applies the
strategy thresholds, so rules can be tuned without re-downloading data.
"""

import itertools
import json
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pandas as pd
import yfinance as yf

import universes

log = logging.getLogger(__name__)

FUND_TTL = 12 * 3600        # fundamentals change slowly; cache 12 hours
PRICE_BATCH = 50            # tickers per yf.download call
FUND_WORKERS = 6            # parallel fundamentals requests
SPARK_SESSIONS = 126        # ~6 months of daily closes for the sparkline
TF_BARS = 60                # candles sent to the browser for pivot / range checks

# Chart timeframes for the Pivot Cross and Range Breakout strategies.
# pivot="day": intraday charts use the previous trading day's H/L/C (standard
# floor pivots); pivot="prev": the previous candle of the same timeframe.
# ttl: how long a finished scan on this timeframe is reused.
TIMEFRAMES = {
    "5m":  {"label": "5 min",   "short": "5m",  "interval": "5m",  "period": "5d",  "pivot": "day",  "basis": "previous day", "ttl": 3 * 60},
    "15m": {"label": "15 min",  "short": "15m", "interval": "15m", "period": "10d", "pivot": "day",  "basis": "previous day", "ttl": 5 * 60},
    "30m": {"label": "30 min",  "short": "30m", "interval": "30m", "period": "1mo", "pivot": "day",  "basis": "previous day", "ttl": 10 * 60},
    "1h":  {"label": "1 hour",  "short": "1h",  "interval": "60m", "period": "2mo", "pivot": "day",  "basis": "previous day", "ttl": 10 * 60},
    "1d":  {"label": "Daily",   "short": "1D",  "interval": "1d",  "period": "2y",  "pivot": "prev", "basis": "previous day", "ttl": 15 * 60},
    "1wk": {"label": "Weekly",  "short": "1W",  "interval": "1wk", "period": "5y",  "pivot": "prev", "basis": "previous week", "ttl": 30 * 60},
    "1mo": {"label": "Monthly", "short": "1M",  "interval": "1mo", "period": "10y", "pivot": "prev", "basis": "previous month", "ttl": 60 * 60},
}


def list_timeframes():
    return [{"id": k, "label": v["label"], "short": v["short"], "basis": v["basis"]} for k, v in TIMEFRAMES.items()]

CACHE_DIR = Path(__file__).resolve().parent / ".cache"
FUND_FILE = CACHE_DIR / "fundamentals.json"

_yf_lock = threading.Lock()   # yf.download is not safe to run concurrently


# --------------------------------------------------------------------------
# helpers

def _num(x, nd=2):
    """Round to nd places; NaN/inf/None -> None (keeps JSON valid)."""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x):
        return None
    return round(x, nd)


def rsi(close, period=14):
    """Wilder's RSI."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(avg_loss != 0, 100.0)


def compute_technicals(df):
    """Indicator snapshot from a daily OHLCV frame, or None if too little data."""
    if df is None or df.empty or "Close" not in df:
        return None
    df = df.dropna(subset=["Close"])
    if len(df) < 30:
        return None

    close, high = df["Close"], df["High"]
    volume = df["Volume"].fillna(0)
    n = len(close)
    price = float(close.iloc[-1])
    prev = float(close.iloc[-2])

    sma50 = close.rolling(50).mean()
    sma200 = close.rolling(200).mean()
    s50, s200 = sma50.iloc[-1], sma200.iloc[-1]

    # Sessions since the 50-day SMA last crossed the 200-day.
    # gc_days: crossed above (golden cross); dc_days: crossed below (death cross).
    # None when the cross happened before the data window (long-standing trend).
    gc_days = dc_days = None
    if pd.notna(s50) and pd.notna(s200):
        above_now = bool(s50 > s200)
        valid = sma200.notna().to_numpy()
        above = (sma50 > sma200).to_numpy()
        opposite = valid & (above != above_now)
        idx = np.flatnonzero(opposite)
        if idx.size:
            days = int(n - 1 - (idx[-1] + 1))
            if above_now:
                gc_days = days
            else:
                dc_days = days

    window = df.iloc[-252:]                      # ~52 weeks of sessions
    high52 = float(window["High"].max())
    low52 = float(window["Low"].min())

    # Volume spike: biggest of the last 3 sessions vs. the 20 sessions before.
    # (Using 3 sessions keeps the signal stable while today's bar is still forming.)
    vol_ratio = None
    if n >= 23:
        base = volume.iloc[-23:-3].mean()
        if base > 0:
            vol_ratio = float(volume.iloc[-3:].max() / base)

    spark = close.iloc[-SPARK_SESSIONS:]
    return {
        "price": _num(price),
        "change_pct": _num((price / prev - 1) * 100) if prev else None,
        "sma50": _num(s50),
        "sma200": _num(s200),
        "gc_days": gc_days,
        "dc_days": dc_days,
        "rsi": _num(rsi(close).iloc[-1], 1),
        "high52": _num(high52),
        "low52": _num(low52),
        "pct_from_high": _num((price / high52 - 1) * 100) if high52 else None,
        "pct_from_low": _num((price / low52 - 1) * 100) if low52 else None,
        "vol_ratio": _num(vol_ratio),
        "as_of": df.index[-1].strftime("%Y-%m-%d"),
        "spark": {
            "d": [d.strftime("%Y-%m-%d") for d in spark.index],
            "c": [_num(v) for v in spark.to_numpy()],
        },
    }


def _frame_for(data, ysym):
    if data is None or data.empty:
        return None
    if isinstance(data.columns, pd.MultiIndex):
        if ysym not in data.columns.get_level_values(0):
            return None
        return data[ysym]
    return data


def download_prices(ysyms, interval="1d", period="2y"):
    with _yf_lock:
        return yf.download(
            tickers=list(ysyms), period=period, interval=interval, group_by="ticker",
            auto_adjust=True, threads=True, progress=False,
        )


def tf_payload(df, tf):
    """Last TF_BARS candles (high/low/close) plus the pivot that applies to each
    candle, for the browser's Pivot Cross and Range Breakout checks."""
    if df is None or df.empty:
        return None
    df = df.dropna(subset=["High", "Low", "Close"])
    if len(df) < 25:
        return None
    spec = TIMEFRAMES[tf]
    h = df["High"].to_numpy(dtype=float)
    l = df["Low"].to_numpy(dtype=float)
    c = df["Close"].to_numpy(dtype=float)
    idx = df.index
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_convert("Asia/Kolkata")

    if spec["pivot"] == "day":
        # every intraday candle uses the previous trading day's high / low / close
        days = pd.Index(idx.date)
        daily = (pd.DataFrame({"h": h, "l": l, "c": c, "d": days})
                 .groupby("d").agg(h=("h", "max"), l=("l", "min"), c=("c", "last")))
        prev = daily.shift(1)
        bh = prev["h"].reindex(days).to_numpy(dtype=float)
        bl = prev["l"].reindex(days).to_numpy(dtype=float)
        bc = prev["c"].reindex(days).to_numpy(dtype=float)
    else:
        # each candle uses the previous candle of the same timeframe
        bh = np.r_[np.nan, h[:-1]]
        bl = np.r_[np.nan, l[:-1]]
        bc = np.r_[np.nan, c[:-1]]
    piv = (bh + bl + bc) / 3

    P, H, L = piv[-1], bh[-1], bl[-1]
    levels = {}
    if np.isfinite(P):
        levels = {"P": _num(P), "R1": _num(2 * P - L), "S1": _num(2 * P - H),
                  "R2": _num(P + (H - L)), "S2": _num(P - (H - L))}

    last = idx[-1]
    if spec["interval"] in ("5m", "15m", "30m", "60m"):
        last_label = last.strftime("%d %b, %H:%M")
    elif tf == "1wk":
        last_label = "week of " + last.strftime("%d %b %Y")
    elif tf == "1mo":
        last_label = last.strftime("%b %Y")
    else:
        last_label = last.strftime("%d %b %Y")

    k = slice(-TF_BARS, None)
    return {
        "h": [_num(x) for x in h[k]],
        "l": [_num(x) for x in l[k]],
        "c": [_num(x) for x in c[k]],
        "p": [_num(x) for x in piv[k]],
        "lv": levels,
        "last": last_label,
    }


# --------------------------------------------------------------------------
# fundamentals (cached in memory and on disk)

_fund_lock = threading.Lock()
_fund_cache: Dict[str, dict] = {}


def _load_fund_cache():
    try:
        _fund_cache.update(json.loads(FUND_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass


def _save_fund_cache():
    with _fund_lock:
        payload = json.dumps(_fund_cache)
    try:
        CACHE_DIR.mkdir(exist_ok=True)
        FUND_FILE.write_text(payload, encoding="utf-8")
    except OSError as exc:
        log.warning("Could not save fundamentals cache: %s", exc)


def cached_fundamentals(ysym) -> Optional[dict]:
    with _fund_lock:
        hit = _fund_cache.get(ysym)
    if hit and time.time() - hit["t"] < FUND_TTL:
        return hit["data"]
    return None


def fetch_fundamentals(ysym) -> dict:
    hit = cached_fundamentals(ysym)
    if hit is not None:
        return hit
    info = yf.Ticker(ysym).info or {}
    roe = info.get("returnOnEquity")
    de = info.get("debtToEquity")        # Yahoo reports D/E as a percentage
    data = {
        "pe": _num(info.get("trailingPE")),
        "pb": _num(info.get("priceToBook")),
        "roe": _num(roe * 100 if roe is not None else None, 1),
        "de": _num(de / 100 if de is not None else None),
        "mcap": _num(info.get("marketCap"), 0),
        "sector": info.get("sector") or "",
        "name": info.get("longName") or info.get("shortName") or "",
    }
    with _fund_lock:
        _fund_cache[ysym] = {"t": time.time(), "data": data}
    return data


_load_fund_cache()


# --------------------------------------------------------------------------
# scans (run in a background thread; the browser polls for progress)

_scan_ids = itertools.count(1)


class Scan:
    def __init__(self, uid, tf):
        self.id = next(_scan_ids)
        self.uid = uid
        self.tf = tf
        self.label = universes.label_of(uid)
        self.state = "running"
        self.phase = "Loading index list"
        self.step = 0
        self.steps = 2 if tf == "1d" else 3
        self.done = 0
        self.total = 0
        self.error = None
        self.started = time.time()
        self.finished = None
        self.version = 0
        self.stocks: Dict[str, dict] = {}
        self.lock = threading.Lock()

    def put(self, ysym, patch):
        with self.lock:
            self.version += 1
            rec = self.stocks.setdefault(ysym, {"ysym": ysym})
            rec.update(patch)
            rec["v"] = self.version

    def progress(self, phase=None, done=None, total=None):
        with self.lock:
            if phase is not None:
                self.phase = phase
                self.step += 1
            if done is not None:
                self.done = done
            if total is not None:
                self.total = total

    def snapshot(self, since=-1):
        with self.lock:
            return {
                "id": self.id,
                "universe": self.uid,
                "tf": self.tf,
                "label": self.label,
                "state": self.state,
                "phase": self.phase,
                "step": self.step,
                "steps": self.steps,
                "done": self.done,
                "total": self.total,
                "error": self.error,
                "started": _iso(self.started),
                "finished": _iso(self.finished),
                "version": self.version,
                "count": len(self.stocks),
                "stocks": [dict(r) for r in self.stocks.values() if r["v"] > since],
            }

    def fresh(self):
        ttl = TIMEFRAMES[self.tf]["ttl"]
        return self.state == "done" and time.time() - (self.finished or 0) < ttl


def _iso(ts):
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds") if ts else None


_scans: Dict[str, Scan] = {}
_scans_lock = threading.Lock()


def get_scan(uid, tf="1d") -> Optional[Scan]:
    with _scans_lock:
        return _scans.get(f"{uid}:{tf}")


def start_scan(uid, tf="1d", force=False) -> Scan:
    key = f"{uid}:{tf}"
    with _scans_lock:
        cur = _scans.get(key)
        just_finished = cur and cur.finished and time.time() - cur.finished < 60
        # reuse a running or fresh scan; a forced refresh runs at most once a minute
        if cur and (cur.state == "running" or (cur.fresh() and not force) or (force and just_finished and cur.state == "done")):
            return cur
        scan = Scan(uid, tf)
        _scans[key] = scan
    threading.Thread(target=_run_scan, args=(scan,), daemon=True).start()
    return scan


def _batched_download(ysyms, interval="1d", period="2y"):
    """Yield (batch, data) pairs; data is None when a batch download fails."""
    for i in range(0, len(ysyms), PRICE_BATCH):
        batch = ysyms[i:i + PRICE_BATCH]
        try:
            data = download_prices(batch, interval=interval, period=period)
        except Exception as exc:
            log.warning("%s download failed for batch %d: %s", interval, i, exc)
            data = None
        yield i + len(batch), batch, data


def _run_scan(scan: Scan):
    tf = scan.tf
    spec = TIMEFRAMES[tf]
    try:
        members = universes.load(scan.uid)
        by_ysym = {m["symbol"] + ".NS": m for m in members}
        ysyms = list(by_ysym)

        # 1) daily prices + technicals (and the daily pivot/range candles)
        scan.progress("Downloading daily prices", 0, len(ysyms))
        for done, batch, data in _batched_download(ysyms):
            for ysym in batch:
                m = by_ysym[ysym]
                frame = _frame_for(data, ysym)
                rec = {"symbol": m["symbol"], "name": m["name"], "industry": m["industry"], "tf": tf,
                       "cap": universes.cap_of(m["symbol"])}
                tech = compute_technicals(frame)
                if tech:
                    rec.update(tech)
                    rec["error"] = None
                else:
                    rec["error"] = "No price data from Yahoo Finance"
                if tf == "1d":
                    rec["tfd"] = tf_payload(frame, tf)
                    rec["tf_status"] = "ok" if rec["tfd"] else "error"
                else:
                    rec["tfd"], rec["tf_status"] = None, "pending"
                fund = cached_fundamentals(ysym)
                rec["fund"] = fund
                rec["fund_status"] = "ok" if fund is not None else "pending"
                scan.put(ysym, rec)
            scan.progress(done=done)

        # 2) candles for the chosen chart timeframe
        if tf != "1d":
            scan.progress(f"Downloading {spec['label']} candles", 0, len(ysyms))
            for done, batch, data in _batched_download(ysyms, spec["interval"], spec["period"]):
                for ysym in batch:
                    payload = tf_payload(_frame_for(data, ysym), tf)
                    scan.put(ysym, {"tfd": payload, "tf_status": "ok" if payload else "error"})
                scan.progress(done=done)

        # 3) fundamentals for anything not cached
        todo = [y for y in ysyms if scan.stocks[y]["fund_status"] == "pending"]
        scan.progress("Fetching fundamentals", 0, len(todo))
        with ThreadPoolExecutor(max_workers=FUND_WORKERS) as pool:
            futures = {pool.submit(fetch_fundamentals, y): y for y in todo}
            for k, fut in enumerate(as_completed(futures), 1):
                ysym = futures[fut]
                try:
                    scan.put(ysym, {"fund": fut.result(), "fund_status": "ok"})
                except Exception as exc:
                    log.info("Fundamentals failed for %s: %s", ysym, exc)
                    scan.put(ysym, {"fund": None, "fund_status": "error"})
                scan.progress(done=k)
        _save_fund_cache()

        with scan.lock:
            scan.state = "done"
            scan.phase = "Done"
            scan.finished = time.time()
    except Exception as exc:
        log.exception("Scan of %s failed", scan.uid)
        with scan.lock:
            scan.state = "error"
            scan.error = str(exc)
            scan.finished = time.time()


# --------------------------------------------------------------------------
# single-stock lookup (for stocks outside the selected index)

_lookup_cache: Dict[str, dict] = {}


def _yahoo_search(query) -> Optional[str]:
    try:
        quotes = yf.Search(query, max_results=10, news_count=0).quotes
    except Exception as exc:
        log.info("Yahoo search failed for %r: %s", query, exc)
        return None
    indian = [q for q in quotes
              if str(q.get("symbol", "")).endswith((".NS", ".BO"))
              and q.get("quoteType", "EQUITY") == "EQUITY"]
    indian.sort(key=lambda q: 0 if q["symbol"].endswith(".NS") else 1)
    return indian[0]["symbol"] if indian else None


def lookup(query, tf="1d") -> dict:
    q = query.strip()
    upper = q.upper()
    meta = {}
    if upper.endswith((".NS", ".BO")):
        ysym = upper
    else:
        hit = universes.resolve(q)
        if hit:
            ysym = hit["symbol"] + ".NS"
            meta = {"symbol": hit["symbol"], "name": hit["name"], "industry": hit["industry"]}
        else:
            ysym = _yahoo_search(q)
            if not ysym and re.fullmatch(r"[A-Z0-9&\-]{1,20}", upper):
                ysym = upper + ".NS"
    if not ysym:
        raise LookupError(f"No Indian stock found for “{q}”.")

    spec = TIMEFRAMES[tf]
    cache_key = f"{ysym}|{tf}"
    cached = _lookup_cache.get(cache_key)
    if cached and time.time() - cached["t"] < min(spec["ttl"], 10 * 60):
        return cached["rec"]

    candidates = [ysym]
    if ysym.endswith(".NS"):
        candidates.append(ysym[:-3] + ".BO")   # fall back to BSE listing
    tech = frame = None
    for cand in candidates:
        frame = _frame_for(download_prices([cand]), cand)
        tech = compute_technicals(frame)
        if tech:
            ysym = cand
            break
    if not tech:
        raise LookupError(
            f"Yahoo Finance has no price history for {' or '.join(candidates)}."
        )

    try:
        fund, fund_status = fetch_fundamentals(ysym), "ok"
        _save_fund_cache()
    except Exception:
        fund, fund_status = None, "error"

    rec = {
        "ysym": ysym,
        "symbol": meta.get("symbol") or ysym[:-3],
        "name": meta.get("name") or (fund or {}).get("name") or ysym[:-3],
        "industry": meta.get("industry") or (fund or {}).get("sector", ""),
        "exchange": "BSE" if ysym.endswith(".BO") else "NSE",
        "cap": universes.cap_of(meta.get("symbol") or ysym[:-3]),
        "error": None,
        "fund": fund,
        "fund_status": fund_status,
        **tech,
    }
    if tf == "1d":
        tfd = tf_payload(frame, tf)
    else:
        try:
            tfd = tf_payload(_frame_for(download_prices([ysym], spec["interval"], spec["period"]), ysym), tf)
        except Exception as exc:
            log.info("%s candles failed for %s: %s", tf, ysym, exc)
            tfd = None
    rec.update({"tf": tf, "tfd": tfd, "tf_status": "ok" if tfd else "error"})
    _lookup_cache[cache_key] = {"t": time.time(), "rec": rec}
    return rec
