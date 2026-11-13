"""Screener signals for your own Python algo: the same rules as the website.

    from signals import signals, buy_list, sell_list, breakout_watch

    for s in buy_list(timeframe="15m", strong_only=True):
        print(s["symbol"], s["label"], s["score"], s["price"], [r["label"] for r in s["reasons"]])

Prices come from Yahoo Finance; when you are logged in to Kite today (via the website's
"Log in to Kite" button) they are replaced by live Kite prices and every signal is recalculated.
Run `python signals.py` to print today's lists.
"""

import time
import warnings
from datetime import datetime, timedelta, timezone

warnings.filterwarnings("ignore", message=".*OpenSSL.*")

import screener  # noqa: E402
import universes  # noqa: E402
from kite_live import kite  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))

# Same defaults as "Adjust strategy rules" on the website.
DEFAULT_RULES = {
    "cross_within": 20,      # golden / death cross counts as fresh within N sessions
    "oversold": 30, "overbought": 70,
    "near_high": 5, "near_low": 5, "vol_spike": 1.5,
    "max_pe": 20, "max_pb": 3, "min_roe": 15, "max_de": 1,
    "pivot_within": 1,
    "range_lookback": 20, "range_within": 3, "max_range_width": 0,
    "squeeze_ratio": 0.8, "near_edge": 20,
    "strong_at": 3,
}
LEVELS = {"strongbuy": "Strong Buy", "buy": "Buy", "hold": "Hold", "sell": "Sell", "strongsell": "Strong Sell"}
CAP_SETS = {"largemid": {"large", "mid"}, "large": {"large"}, "mid": {"mid"}, "small": {"small"},
            "all": {"large", "mid", "small"}}


def market_open(now=None):
    """True during NSE cash-market hours (09:15-15:30 IST, Monday-Friday; holidays not checked)."""
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.weekday() < 5 and (9, 15) <= (now.hour, now.minute) < (15, 30)


def _clamp(v, lo, hi):
    return max(lo, min(hi, int(round(v))))


def _pct(a, b):
    return None if a is None or b in (None, 0) else (a / b - 1) * 100


def _level(score, R):
    strong = max(1, R["strong_at"])
    if score >= strong:
        return "strongbuy"
    if score > 0:
        return "buy"
    if score == 0:
        return "hold"
    return "sell" if score > -strong else "strongsell"


def _tag(strategy, direction, points, kind, label, detail):
    return {"strategy": strategy, "direction": direction, "points": points, "kind": kind,
            "label": label, "detail": detail}


def evaluate(r, R=None, tf_short="1D"):
    """Score one stock record. Returns (tags, score, level); score is None without price data."""
    R = {**DEFAULT_RULES, **(R or {})}
    tags = []
    price = r.get("price")
    if price is None:
        return tags, None, None

    # golden cross / moving-average trend
    s50, s200 = r.get("sma50"), r.get("sma200")
    if s50 is not None and s200 is not None:
        if s50 > s200 and price > s200:
            gc = r.get("gc_days")
            fresh = gc is not None and gc <= R["cross_within"]
            tags.append(_tag("ma", 1, 2 if fresh else 1, "gc" if fresh else "up",
                             f"Golden Cross · {gc}d ago" if fresh else "MA Uptrend",
                             f"50-day {s50:.2f} > 200-day {s200:.2f}, price above the 200-day"))
        elif s50 < s200 and price < s200:
            dc = r.get("dc_days")
            fresh = dc is not None and dc <= R["cross_within"]
            tags.append(_tag("ma", -1, -2 if fresh else -1, "dc" if fresh else "down",
                             f"Death Cross · {dc}d ago" if fresh else "MA Downtrend",
                             f"50-day {s50:.2f} < 200-day {s200:.2f}, price below the 200-day"))

    # RSI
    rsi = r.get("rsi")
    if rsi is not None:
        if rsi <= R["oversold"]:
            tags.append(_tag("rsi", 1, 1, "oversold", f"RSI Oversold · {rsi:.0f}", f"RSI(14) {rsi:.1f} <= {R['oversold']}"))
        elif rsi >= R["overbought"]:
            tags.append(_tag("rsi", -1, -1, "overbought", f"RSI Overbought · {rsi:.0f}", f"RSI(14) {rsi:.1f} >= {R['overbought']}"))

    # 52-week high breakout / low breakdown (with a volume spike)
    vol = r.get("vol_ratio")
    if vol is not None and vol >= R["vol_spike"]:
        fh, fl = r.get("pct_from_high"), r.get("pct_from_low")
        if fh is not None and fh >= -R["near_high"]:
            tags.append(_tag("high", 1, 1, "breakout", f"52W High Breakout · {vol:.1f}× vol",
                             f"{abs(fh):.1f}% below the 52-week high {r.get('high52')}"))
        elif fl is not None and fl <= R["near_low"]:
            tags.append(_tag("high", -1, -1, "breakdown", f"52W Low Breakdown · {vol:.1f}× vol",
                             f"{fl:.1f}% above the 52-week low {r.get('low52')}"))

    # value fundamentals (buy side only)
    f = r.get("fund") or {}
    if f:
        fin = f.get("sector") == "Financial Services"
        pe, pb, roe, de = f.get("pe"), f.get("pb"), f.get("roe"), f.get("de")
        if (pe is not None and 0 < pe <= R["max_pe"] and pb is not None and pb <= R["max_pb"]
                and roe is not None and roe >= R["min_roe"] and (fin or (de is not None and de <= R["max_de"]))):
            tags.append(_tag("value", 1, 1, "value", f"Value · P/E {pe:.1f}", f"P/E {pe}, P/B {pb}, ROE {roe}%"))

    # pivot cross + range breakout on the chart timeframe
    t = r.get("tfd")
    if t and t.get("c") and len(t["c"]) > 2:
        h, l, c, p = t["h"], t["l"], t["c"], t["p"]
        n = len(c)
        for i in range(n - 1, max(1, n - _clamp(R["pivot_within"], 1, 10)) - 1, -1):
            if None in (c[i], c[i - 1], p[i], p[i - 1]):
                continue
            up = c[i - 1] <= p[i - 1] and c[i] > p[i]
            down = c[i - 1] >= p[i - 1] and c[i] < p[i]
            if up or down:
                tags.append(_tag("pivot", 1 if up else -1, 1 if up else -1, "up" if up else "down",
                                 f"Pivot Cross {'Up' if up else 'Down'} · {tf_short}",
                                 f"closed {'above' if up else 'below'} pivot {p[i]} {n - 1 - i} candles ago"))
                break
        rw = _clamp(R["range_within"], 1, 10)
        look = _clamp(R["range_lookback"], 5, min(50, n - rw))
        i = n - 1
        while i >= n - rw and i - look >= 0:
            if c[i] is not None:
                hs = [x for x in h[i - look:i] if x is not None]
                ls = [x for x in l[i - look:i] if x is not None]
                if hs and ls and min(ls) > 0:
                    hi, lo = max(hs), min(ls)
                    width = (hi - lo) / lo * 100
                    if not (R["max_range_width"] > 0 and width > R["max_range_width"]):
                        up, down = c[i] > hi, c[i] < lo
                        if up or down:
                            if (c[-1] > hi) if up else (c[-1] < lo):
                                tags.append(_tag("range", 1 if up else -1, 1 if up else -1,
                                                 "breakout" if up else "breakdown",
                                                 f"Range {'Breakout' if up else 'Breakdown'} · {tf_short}",
                                                 f"closed {'above' if up else 'below'} the {look}-candle range {lo}-{hi}"))
                            break
            i -= 1

    score = sum(x["points"] for x in tags)
    return tags, score, _level(score, R)


def range_setup(t, R=None):
    """Tight range with price near its top (direction 1) or bottom (-1); None otherwise."""
    R = {**DEFAULT_RULES, **(R or {})}
    if not t or not t.get("c"):
        return None
    h, l, c = t["h"], t["l"], t["c"]
    n = len(c)
    N = _clamp(R["range_lookback"], 5, (n - 1) // 2)

    def win(end):
        hs, ls = h[end - N:end], l[end - N:end]
        return None if None in hs or None in ls else (max(hs), min(ls))

    cur, price = win(n - 1), c[-1]
    if not cur or price is None:
        return None
    hi, lo = cur
    if lo <= 0 or hi <= lo or price > hi or price < lo:
        return None
    widths = sorted((w[0] - w[1]) / w[1] for i in range(N, n - N) if (w := win(i)))
    if len(widths) < 3:
        return None
    width = (hi - lo) / lo
    ratio = width / widths[len(widths) // 2]
    if ratio > R["squeeze_ratio"]:
        return None
    pos = (price - lo) / (hi - lo)
    edge = R["near_edge"] / 100
    base = {"range_high": hi, "range_low": lo, "width_pct": round(width * 100, 2), "squeeze": round(ratio, 2),
            "price": price, "as_of": t.get("last")}
    if pos >= 1 - edge:
        return {**base, "direction": 1, "distance_pct": round((hi - price) / price * 100, 2), "level": hi}
    if pos <= edge:
        return {**base, "direction": -1, "distance_pct": round((price - lo) / price * 100, 2), "level": lo}
    return None


# --------------------------------------------------------------------------- live prices

def _patch_candles(t, ltp):
    if not t or not t.get("c") or ltp is None:
        return t
    c, h, l = list(t["c"]), list(t["h"]), list(t["l"])
    c[-1] = ltp
    h[-1] = max(h[-1] if h[-1] is not None else ltp, ltp)
    l[-1] = min(l[-1] if l[-1] is not None else ltp, ltp)
    return {**t, "c": c, "h": h, "l": l}


def _rsi(closes, period=14):
    v = [x for x in closes if x is not None]
    if len(v) <= period + 1:
        return None
    g = sum(max(v[i] - v[i - 1], 0) for i in range(1, period + 1)) / period
    lo = sum(max(v[i - 1] - v[i], 0) for i in range(1, period + 1)) / period
    for i in range(period + 1, len(v)):
        d = v[i] - v[i - 1]
        g = (g * (period - 1) + max(d, 0)) / period
        lo = (lo * (period - 1) + max(-d, 0)) / period
    return 100.0 if lo == 0 else round(100 - 100 / (1 + g / lo), 1)


def with_live(r, q):
    """Fold a live Kite quote into a stock record (same as the website does)."""
    ltp = (q or {}).get("ltp")
    if ltp is None or r.get("price") is None:
        return r
    out = {**r, "price": ltp, "live": True}
    if q.get("change_pct") is not None:
        out["change_pct"] = q["change_pct"]
    if r.get("high52") is not None:
        out["high52"] = max(r["high52"], q.get("high") or ltp, ltp)
        out["pct_from_high"] = _pct(ltp, out["high52"])
    if r.get("low52") is not None:
        out["low52"] = min(r["low52"], q.get("low") or ltp, ltp)
        out["pct_from_low"] = _pct(ltp, out["low52"])
    spark = r.get("spark") or {}
    if spark.get("c"):
        closes = list(spark["c"])
        closes[-1] = ltp
        rsi = _rsi(closes)
        if rsi is not None:
            out["rsi"] = rsi
    if r.get("tfd"):
        out["tfd"] = _patch_candles(r["tfd"], ltp)
    return out


def live_quotes(symbols):
    """Live Kite quotes if logged in to Kite today, else {}."""
    if not kite.session():
        return {}
    try:
        return kite.quotes(symbols)
    except Exception as exc:
        print(f"[signals] Kite quotes unavailable, using Yahoo prices: {exc}")
        return {}


# --------------------------------------------------------------------------- public API

def _records(universe, timeframe):
    if universe not in universes.LISTED:
        raise ValueError(f"Unknown universe {universe!r}; choose from {universes.LISTED}")
    if timeframe not in screener.TIMEFRAMES:
        raise ValueError(f"Unknown timeframe {timeframe!r}; choose from {list(screener.TIMEFRAMES)}")
    scan = screener.start_scan(universe, timeframe)
    while scan.state == "running":
        time.sleep(0.5)
    if scan.state == "error":
        raise RuntimeError(f"Scan failed: {scan.error}")
    return scan.snapshot()["stocks"]


def signals(universe="niftylargemidcap250", timeframe="1d", cap="largemid", live=True, rules=None):
    """Every stock in the universe with its signal, best score first.

    universe:  "niftylargemidcap250", "nifty100", "niftymidcap150", "niftysmallcap250", "nifty500",
               "nifty50", "niftynext50", "niftymidcap100", "niftybank", "nifty200"
    timeframe: chart timeframe for Pivot Cross and Range Breakout: 5m 15m 30m 1h 1d 1wk 1mo
    cap:       "largemid" (default), "large", "mid", "small" or "all"
    live:      use live Kite prices when logged in to Kite today
    rules:     dict overriding DEFAULT_RULES, e.g. {"oversold": 25, "strong_at": 2}
    """
    R = {**DEFAULT_RULES, **(rules or {})}
    caps = CAP_SETS.get(cap, CAP_SETS["largemid"])
    recs = [r for r in _records(universe, timeframe) if r.get("cap") in caps]
    quotes = live_quotes([r["symbol"] for r in recs]) if live else {}
    tf_short = screener.TIMEFRAMES[timeframe]["short"]
    out = []
    for r0 in recs:
        r = with_live(r0, quotes.get(r0["symbol"]))
        tags, score, level = evaluate(r, R, tf_short)
        if level is None:
            continue
        out.append({
            "symbol": r["symbol"], "name": r.get("name"), "cap": r.get("cap"),
            "price": r.get("price"), "change_pct": r.get("change_pct"), "live": bool(r.get("live")),
            "level": level, "label": LEVELS[level], "score": score,
            "reasons": tags, "rsi": r.get("rsi"), "timeframe": timeframe,
        })
    out.sort(key=lambda s: (-s["score"], -len(s["reasons"])))
    return out


def buy_list(strong_only=False, **kwargs):
    """Stocks with a Buy or Strong Buy signal, strongest first. Same arguments as signals()."""
    keep = {"strongbuy"} if strong_only else {"strongbuy", "buy"}
    return [s for s in signals(**kwargs) if s["level"] in keep]


def sell_list(strong_only=False, **kwargs):
    """Stocks with a Sell or Strong Sell signal, weakest first. Same arguments as signals()."""
    keep = {"strongsell"} if strong_only else {"strongsell", "sell"}
    return sorted((s for s in signals(**kwargs) if s["level"] in keep), key=lambda s: (s["score"], -len(s["reasons"])))


def breakout_watch(universe="niftylargemidcap250", timeframes=("15m", "1h", "1d", "1wk"), cap="largemid",
                   live=True, rules=None):
    """Stocks in a tight range near the top (about to break out) or bottom (about to break down).

    Returns {"breakout": [...], "breakdown": [...]}, each item:
    {symbol, name, cap, price, setups: {timeframe: {level, distance_pct, range_high, range_low, ...}}}
    sorted by how many timeframes agree, then by distance to the level.
    """
    R = {**DEFAULT_RULES, **(rules or {})}
    caps = CAP_SETS.get(cap, CAP_SETS["largemid"])
    members = {m["symbol"]: m for m in universes.load(universe)}
    syms = [s for s in members if universes.cap_of(s) in caps]
    quotes = live_quotes(syms) if live else {}
    candles = {tf: screener.candles(universe, tf) for tf in timeframes}
    result = {"breakout": [], "breakdown": []}
    for sym in syms:
        q = quotes.get(sym)
        found = {1: {}, -1: {}}
        for tf, data in candles.items():
            t = data.get(sym)
            if q and t:
                t = _patch_candles(t, q["ltp"])
            s = range_setup(t, R)
            if s:
                found[s["direction"]][tf] = s
        for direction, key in ((1, "breakout"), (-1, "breakdown")):
            if found[direction]:
                any_setup = next(iter(found[direction].values()))
                result[key].append({
                    "symbol": sym, "name": members[sym]["name"], "cap": universes.cap_of(sym),
                    "price": q["ltp"] if q else any_setup["price"], "live": bool(q),
                    "setups": found[direction],
                })
    for key in result:
        result[key].sort(key=lambda x: (-len(x["setups"]), min(s["distance_pct"] for s in x["setups"].values())))
    return result


if __name__ == "__main__":
    import sys
    tf = sys.argv[1] if len(sys.argv) > 1 else "1d"
    print(f"Signals on {tf} ({'live Kite prices' if kite.session() else 'Yahoo prices'}):")
    for title, rows in (("BUY", buy_list(timeframe=tf)), ("SELL", sell_list(timeframe=tf))):
        print(f"\n{title} ({len(rows)})")
        for s in rows[:10]:
            reasons = ", ".join(r["label"] for r in s["reasons"])
            print(f"  {s['symbol']:12} {s['label']:11} {s['score']:+d}  ₹{s['price']:<10} {reasons}")
    w = breakout_watch()
    for key in ("breakout", "breakdown"):
        print(f"\nABOUT TO {key.upper()} ({len(w[key])})")
        for x in w[key][:8]:
            print(f"  {x['symbol']:12} ₹{x['price']:<10} " + ", ".join(
                f"{tf} {s['distance_pct']}% to ₹{s['level']}" for tf, s in x["setups"].items()))
