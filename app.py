"""NSE Strategy Screener - Flask web app.

Run:  .venv/bin/python app.py   then open http://127.0.0.1:8000
Share: ./share.sh               (prints a public link others can open)
"""

import logging
import os
import warnings

warnings.filterwarnings("ignore", message=".*OpenSSL.*")  # macOS system-Python noise

from flask import Flask, jsonify, redirect, render_template, request  # noqa: E402

import screener  # noqa: E402
import universes  # noqa: E402
from kite_live import kite  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

app = Flask(__name__)


@app.get("/")
def index():
    return render_template("index.html")


def is_local_request():
    """True only for a browser on this Mac (not a visitor through a tunnel or proxy).
    Kite data is for the account owner's personal use and must not be passed on."""
    if request.headers.get("Cf-Connecting-Ip") or request.headers.get("X-Forwarded-For"):
        return False
    return request.remote_addr in ("127.0.0.1", "::1")


def _local_only():
    if not is_local_request():
        return jsonify(error="Live Kite data is only available on the account owner's own computer."), 403
    return None


# ---------------------------------------------------------------- Zerodha Kite (owner only)

@app.get("/api/kite/status")
def api_kite_status():
    if not is_local_request():
        return jsonify(local=False)
    return jsonify(local=True, **kite.status())


@app.post("/api/kite/config")
def api_kite_config():
    denied = _local_only()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    key, secret = str(body.get("api_key", "")).strip(), str(body.get("api_secret", "")).strip()
    if not key or not secret:
        return jsonify(error="Enter both the API key and the API secret."), 400
    kite.save_config(key, secret)
    return jsonify(ok=True, login_url="/kite/login")


@app.get("/kite/login")
def kite_login():
    denied = _local_only()
    if denied:
        return denied
    url = kite.login_url()
    return redirect(url) if url else redirect("/?kite=setup")


@app.get("/kite/callback")
def kite_callback():
    denied = _local_only()
    if denied:
        return denied
    token = request.args.get("request_token", "")
    if request.args.get("status") != "success" or not token:
        return redirect("/?kite=cancelled")
    try:
        kite.complete_login(token)
    except Exception as exc:
        logging.warning("Kite login failed: %s", exc)
        return redirect("/?kite=failed")
    return redirect("/?kite=connected")


@app.post("/api/kite/logout")
def api_kite_logout():
    denied = _local_only()
    if denied:
        return denied
    kite.logout()
    return jsonify(ok=True)


@app.post("/api/live")
def api_live():
    """Latest Kite prices for an index (plus searched stocks), changed since `since`."""
    denied = _local_only()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    uid = body.get("universe", "niftylargemidcap250")
    symbols = [m["symbol"] for m in universes.load(uid)] if uid in universes.LISTED else []
    symbols += [str(s) for s in (body.get("extra") or [])][:50]
    try:
        known = kite.watch(symbols)
    except Exception as exc:
        logging.warning("Kite watch failed: %s", exc)
        return jsonify(error=f"Kite: {exc}", **kite.status()), 502
    snap = kite.snapshot(symbols, since=int(body.get("since", -1)))
    return jsonify(known=known, **snap, **kite.status())


@app.get("/api/universes")
def api_universes():
    return jsonify(universes.list_universes())


@app.get("/api/timeframes")
def api_timeframes():
    return jsonify(screener.list_timeframes())


def _tf(value):
    return value if value in screener.TIMEFRAMES else None


@app.post("/api/scan")
def api_scan_start():
    body = request.get_json(silent=True) or {}
    uid = body.get("universe", "niftylargemidcap250")
    tf = _tf(body.get("tf", "1d"))
    if uid not in universes.LISTED:
        return jsonify(error=f"Unknown index '{uid}'"), 400
    if tf is None:
        return jsonify(error="Unknown timeframe"), 400
    scan = screener.start_scan(uid, tf, force=bool(body.get("force")))
    snap = scan.snapshot()
    snap.pop("stocks")
    return jsonify(snap)


@app.get("/api/scan/<uid>")
def api_scan_status(uid):
    scan = screener.get_scan(uid, _tf(request.args.get("tf", "1d")) or "1d")
    if scan is None:
        return jsonify(error="No scan has been started for this index"), 404
    return jsonify(scan.snapshot(since=request.args.get("since", default=-1, type=int)))


@app.get("/api/candles")
def api_candles():
    uid = request.args.get("universe", "niftylargemidcap250")
    tf = _tf(request.args.get("tf", "1d"))
    if uid not in universes.LISTED or tf is None:
        return jsonify(error="Unknown index or timeframe"), 400
    return jsonify(screener.candles(uid, tf))


@app.get("/api/lookup")
def api_lookup():
    q = request.args.get("q", "").strip()
    tf = _tf(request.args.get("tf", "1d")) or "1d"
    if not q:
        return jsonify(error="Type a stock name or symbol"), 400
    try:
        return jsonify(screener.lookup(q, tf))
    except LookupError as exc:
        return jsonify(error=str(exc)), 404
    except Exception as exc:
        logging.exception("Lookup failed for %r", q)
        return jsonify(error=f"Lookup failed: {exc}"), 502


@app.get("/api/suggest")
def api_suggest():
    return jsonify(universes.suggest(request.args.get("q", ""), limit=8))


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))  # 5000 is taken by AirPlay on macOS
    print(f"\n  NSE Strategy Screener running at http://127.0.0.1:{port}\n")
    kite.start()  # resume live prices if today's Kite login is still valid
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=12)
    except ImportError:
        app.run(host=host, port=port, debug=False, threaded=True)
