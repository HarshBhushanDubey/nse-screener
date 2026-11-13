"""Zerodha Kite Connect: daily login + live prices over the Kite WebSocket.

For the owner's personal use on this Mac only: exchange rules do not allow
passing Kite market data on to other people, so app.py serves it only to
requests from this computer. Credentials and the daily access token live in
.kite/ (git-ignored) and never leave this machine except to api.kite.trade.

Uses the documented Kite Connect v3 REST API and WebSocket streaming API:
https://kite.trade/docs/connect/v3/
"""

import csv
import hashlib
import io
import json
import logging
import struct
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

try:
    import websocket  # websocket-client
except ImportError:  # live streaming disabled until installed
    websocket = None

log = logging.getLogger(__name__)

KITE_DIR = Path(__file__).resolve().parent / ".kite"
CONFIG_FILE = KITE_DIR / "config.json"      # {"api_key", "api_secret"}
SESSION_FILE = KITE_DIR / "session.json"    # {"access_token", "user", "expires"}
INSTR_FILE = KITE_DIR / "instruments.json"  # {"date", "tokens": {symbol: token}}

API = "https://api.kite.trade"
LOGIN_URL = "https://kite.zerodha.com/connect/login?v=3&api_key={key}"
WS_URL = "wss://ws.kite.trade?api_key={key}&access_token={token}"
IST = timezone(timedelta(hours=5, minutes=30))
MAX_TOKENS = 3000  # Kite allows up to 3000 instruments per WebSocket connection


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path, data):
    KITE_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _next_expiry(now=None):
    """Kite access tokens expire at 6:00 AM IST the next morning."""
    now = (now or datetime.now(IST)).astimezone(IST)
    expiry = now.replace(hour=6, minute=0, second=0, microsecond=0)
    if now >= expiry:
        expiry += timedelta(days=1)
    return expiry


def parse_ticks(payload):
    """Decode a binary Kite WebSocket message into [{token, ltp, open, high, low, close, volume}].

    Layout (big-endian): 2-byte packet count, then per packet a 2-byte length and the packet.
    Equity packets: 8 bytes (LTP mode), 44 bytes (quote) or 184 bytes (full); prices in paise.
    """
    if len(payload) < 4:
        return []  # 1-byte heartbeat
    ticks = []
    count = struct.unpack(">H", payload[0:2])[0]
    pos = 2
    for _ in range(count):
        if pos + 2 > len(payload):
            break
        size = struct.unpack(">H", payload[pos:pos + 2])[0]
        pkt = payload[pos + 2:pos + 2 + size]
        pos += 2 + size
        if len(pkt) < 8:
            continue
        token = struct.unpack(">I", pkt[0:4])[0]
        segment = token & 0xFF
        div = 10_000_000.0 if segment == 3 else 100.0  # 3 = currency derivatives
        tick = {"token": token, "ltp": struct.unpack(">i", pkt[4:8])[0] / div}
        if len(pkt) >= 44:
            f = struct.unpack(">11i", pkt[0:44])
            tick.update(volume=f[4], open=f[7] / div, high=f[8] / div, low=f[9] / div, close=f[10] / div)
        ticks.append(tick)
    return ticks


class KiteLive:
    def __init__(self):
        self.lock = threading.Lock()
        self.quotes = {}          # symbol -> quote dict
        self.version = 0
        self.tokens = {}          # symbol -> instrument token
        self.ticks = {}           # symbol -> tick size (minimum price step)
        self.by_token = {}        # token -> symbol
        self.wanted = set()       # tokens we want streamed
        self.ws = None
        self.thread = None
        self.connected = False
        self.error = None
        self.last_tick = None

    # ---------------------------------------------------------------- config / session
    def config(self):
        return _read(CONFIG_FILE) or {}

    def save_config(self, api_key, api_secret):
        _write(CONFIG_FILE, {"api_key": api_key.strip(), "api_secret": api_secret.strip()})

    def session(self):
        s = _read(SESSION_FILE)
        if not s or not s.get("access_token"):
            return None
        if datetime.fromisoformat(s["expires"]) <= datetime.now(IST):
            return None
        return s

    def login_url(self):
        key = self.config().get("api_key")
        return LOGIN_URL.format(key=key) if key else None

    def _headers(self, session=None):
        session = session or self.session()
        return {"X-Kite-Version": "3",
                "Authorization": f"token {self.config()['api_key']}:{session['access_token']}"}

    def complete_login(self, request_token):
        cfg = self.config()
        if not cfg.get("api_key") or not cfg.get("api_secret"):
            raise RuntimeError("Save your Kite API key and secret first.")
        checksum = hashlib.sha256((cfg["api_key"] + request_token + cfg["api_secret"]).encode()).hexdigest()
        resp = requests.post(f"{API}/session/token", headers={"X-Kite-Version": "3"}, timeout=20,
                             data={"api_key": cfg["api_key"], "request_token": request_token, "checksum": checksum})
        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        if resp.status_code != 200 or body.get("status") != "success":
            raise RuntimeError(body.get("message") or f"Kite login failed ({resp.status_code})")
        data = body["data"]
        _write(SESSION_FILE, {"access_token": data["access_token"],
                              "user": data.get("user_name") or data.get("user_id", ""),
                              "expires": _next_expiry().isoformat()})
        self.error = None
        self.restart()

    def logout(self):
        s = self.session()
        if s:
            try:
                requests.delete(f"{API}/session/token", headers=self._headers(s), timeout=10,
                                params={"api_key": self.config()["api_key"], "access_token": s["access_token"]})
            except requests.RequestException:
                pass
        try:
            SESSION_FILE.unlink()
        except OSError:
            pass
        self.stop()
        with self.lock:
            self.quotes.clear()
            self.version += 1

    def status(self):
        cfg, s = self.config(), self.session()
        return {
            "available": websocket is not None,
            "configured": bool(cfg.get("api_key") and cfg.get("api_secret")),
            "api_key_hint": (cfg.get("api_key", "")[:4] + "…") if cfg.get("api_key") else "",
            "logged_in": bool(s),
            "user": s.get("user") if s else None,
            "expires": s.get("expires") if s else None,
            "streaming": self.connected,
            "last_tick": self.last_tick,
            "error": self.error,
        }

    # ---------------------------------------------------------------- instruments + snapshot quotes
    def _load_instruments(self, session):
        today = datetime.now(IST).date().isoformat()
        cached = _read(INSTR_FILE)
        if cached and cached.get("date") == today and "ticks" in cached:
            tokens, ticks = cached["tokens"], cached["ticks"]
        else:
            resp = requests.get(f"{API}/instruments/NSE", headers=self._headers(session), timeout=60)
            resp.raise_for_status()
            tokens, ticks = {}, {}
            for row in csv.DictReader(io.StringIO(resp.text)):
                if row.get("segment") == "NSE" and row.get("instrument_type") == "EQ":
                    tokens[row["tradingsymbol"]] = int(row["instrument_token"])
                    ticks[row["tradingsymbol"]] = float(row.get("tick_size") or 0.05)
            _write(INSTR_FILE, {"date": today, "tokens": tokens, "ticks": ticks})
        with self.lock:
            self.tokens = tokens
            self.ticks = ticks
            self.by_token = {t: s for s, t in tokens.items()}

    def _snapshot(self, symbols, session):
        """Fill prices immediately (also outside market hours) with the REST quote API."""
        for i in range(0, len(symbols), 500):
            chunk = symbols[i:i + 500]
            resp = requests.get(f"{API}/quote/ohlc", headers=self._headers(session), timeout=20,
                                params=[("i", f"NSE:{s}") for s in chunk])
            if resp.status_code != 200:
                log.info("Kite quote snapshot failed: %s", resp.text[:200])
                return
            now = time.time()
            with self.lock:
                for key, q in (resp.json().get("data") or {}).items():
                    ohlc = q.get("ohlc") or {}
                    self._store(key.split(":", 1)[1], q.get("last_price"), ohlc.get("open"), ohlc.get("high"),
                                ohlc.get("low"), ohlc.get("close"), None, now)
            time.sleep(1.1)  # quote API: 1 request per second

    def _store(self, symbol, ltp, o, h, l, c, volume, ts):
        if ltp is None:
            return
        prev = self.quotes.get(symbol, {})
        self.version += 1
        self.quotes[symbol] = {
            "ltp": round(ltp, 2),
            "open": o if o is not None else prev.get("open"),
            "high": h if h is not None else prev.get("high"),
            "low": l if l is not None else prev.get("low"),
            "close": c if c is not None else prev.get("close"),
            "volume": volume if volume is not None else prev.get("volume"),
            "change_pct": round((ltp / c - 1) * 100, 2) if c else prev.get("change_pct"),
            "ts": ts,
            "v": self.version,
        }

    # ---------------------------------------------------------------- streaming
    def watch(self, symbols):
        """Make sure these NSE symbols are streamed; returns how many are known to Kite."""
        session = self.session()
        if not session or websocket is None:
            return 0
        if not self.tokens:
            self._load_instruments(session)
        new_syms = [s for s in symbols if s in self.tokens and self.tokens[s] not in self.wanted]
        if new_syms:
            with self.lock:
                for s in new_syms:
                    if len(self.wanted) < MAX_TOKENS:
                        self.wanted.add(self.tokens[s])
            threading.Thread(target=self._snapshot, args=(new_syms, session), daemon=True).start()
            if self.ws is None:
                self.start()
            elif self.connected:
                self._subscribe([self.tokens[s] for s in new_syms])
        return sum(1 for s in symbols if s in self.tokens)

    def _subscribe(self, tokens):
        if not tokens or not self.ws:
            return
        try:
            self.ws.send(json.dumps({"a": "subscribe", "v": tokens}))
            self.ws.send(json.dumps({"a": "mode", "v": ["quote", tokens]}))
        except Exception as exc:  # socket closed; on_open resubscribes everything
            log.info("Kite subscribe failed: %s", exc)

    def start(self):
        session = self.session()
        if not session or websocket is None or self.thread:
            return
        url = WS_URL.format(key=self.config()["api_key"], token=session["access_token"])

        def on_open(ws):
            self.connected = True
            self.error = None
            log.info("Kite WebSocket connected")
            self._subscribe(sorted(self.wanted))

        def on_message(ws, message):
            if isinstance(message, str):
                try:
                    msg = json.loads(message)
                    if msg.get("type") == "error":
                        self.error = msg.get("data")
                except ValueError:
                    pass
                return
            now = time.time()
            ticks = parse_ticks(message)
            if not ticks:
                return
            with self.lock:
                for t in ticks:
                    sym = self.by_token.get(t["token"])
                    if sym:
                        self._store(sym, t["ltp"], t.get("open"), t.get("high"), t.get("low"),
                                    t.get("close"), t.get("volume"), now)
                self.last_tick = now

        def on_error(ws, err):
            self.error = str(err)
            log.info("Kite WebSocket error: %s", err)

        def on_close(ws, *args):
            self.connected = False

        def run():
            while self.ws is not None and self.session():
                self.ws.run_forever(ping_interval=30, ping_timeout=10)
                self.connected = False
                if self.ws is not None:
                    time.sleep(5)  # reconnect after a drop
            self.thread = None

        self.ws = websocket.WebSocketApp(url, on_open=on_open, on_message=on_message,
                                         on_error=on_error, on_close=on_close)
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        ws, self.ws = self.ws, None
        if ws:
            try:
                ws.close()
            except Exception:
                pass
        self.connected = False
        self.wanted.clear()

    def restart(self):
        self.stop()
        time.sleep(0.5)
        self.thread = None
        self.start()

    # ---------------------------------------------------------------- REST helpers for algos
    def request(self, method, path, **kwargs):
        """Call the Kite REST API with today's session; returns the `data` field or raises KiteError."""
        session = self.session()
        if not session:
            raise KiteError("Not logged in to Kite today. Open http://127.0.0.1:8000 and click Log in to Kite.")
        resp = requests.request(method, f"{API}{path}", headers=self._headers(session), timeout=20, **kwargs)
        try:
            body = resp.json()
        except ValueError:
            raise KiteError(f"Kite returned {resp.status_code}: {resp.text[:200]}")
        if resp.status_code != 200 or body.get("status") != "success":
            raise KiteError(body.get("message") or f"Kite error {resp.status_code}")
        return body.get("data")

    def quotes(self, symbols):
        """{symbol: {ltp, open, high, low, close, change_pct}} straight from Kite (REST, 500 per call)."""
        out = {}
        symbols = list(dict.fromkeys(symbols))
        for i in range(0, len(symbols), 500):
            if i:
                time.sleep(1.1)  # quote API allows about 1 request per second
            data = self.request("GET", "/quote/ohlc", params=[("i", f"NSE:{s}") for s in symbols[i:i + 500]]) or {}
            for key, q in data.items():
                ohlc = q.get("ohlc") or {}
                ltp, close = q.get("last_price"), ohlc.get("close")
                out[key.split(":", 1)[1]] = {
                    "ltp": ltp, "open": ohlc.get("open"), "high": ohlc.get("high"), "low": ohlc.get("low"),
                    "close": close, "change_pct": round((ltp / close - 1) * 100, 2) if ltp and close else None,
                }
        return out

    def tick_size(self, symbol):
        session = self.session()
        if session and not self.ticks:
            self._load_instruments(session)
        return self.ticks.get(symbol, 0.05)

    def snapshot(self, symbols, since=-1):
        with self.lock:
            return {
                "version": self.version,
                "quotes": {s: q for s in symbols if (q := self.quotes.get(s)) and q["v"] > since},
            }


class KiteError(RuntimeError):
    """An error message from Kite (login expired, IP not whitelisted, order rejected, ...)."""


kite = KiteLive()
