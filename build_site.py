"""Build the static, free-hosted version of the site (GitHub Pages) with fresh market data.

    python build_site.py <output-dir>

Writes index.html + static/ + data/*.json. The browser code detects data/meta.json and runs
without the Flask server. GitHub Actions runs this on a schedule (.github/workflows/site.yml).
"""

import json
import logging
import shutil
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import screener  # noqa: E402
import universes  # noqa: E402

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("build")


def write_json(path, obj):
    path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    log.info("wrote %s (%.0f KB)", path.name, path.stat().st_size / 1024)


def main(out):
    t0 = time.time()
    out = Path(out)
    if out.exists():
        shutil.rmtree(out)
    (out / "static").mkdir(parents=True)
    data_dir = out / "data"
    data_dir.mkdir()
    shutil.copy(ROOT / "templates" / "index.html", out / "index.html")
    for name in ("app.js", "style.css"):
        shutil.copy(ROOT / "static" / name, out / "static" / name)
    (out / ".nojekyll").write_text("")

    # index lists: try a fresh download, fall back to the copies saved in data/
    universes.MAX_AGE = 0
    lists = {}
    for uid in universes.LISTED:
        try:
            lists[uid] = universes.load(uid)
        except RuntimeError as exc:
            log.warning("%s", exc)
    members = {}
    for rows in lists.values():
        for m in rows:
            members.setdefault(m["symbol"], m)
    syms = sorted(members)
    ysyms = [s + ".NS" for s in syms]
    log.info("%d stocks across %d indexes", len(syms), len(lists))

    # daily prices -> technicals + daily pivot/range candles
    stocks = {}
    for done, batch, data in screener._batched_download(ysyms):
        for ysym in batch:
            m = members[ysym[:-3]]
            frame = screener._frame_for(data, ysym)
            rec = {"ysym": ysym, "symbol": m["symbol"], "name": m["name"], "industry": m["industry"],
                   "cap": universes.cap_of(m["symbol"])}
            tech = screener.compute_technicals(frame)
            if tech:
                rec.update(tech)
                rec["error"] = None
                rec["tfd"] = screener.tf_payload(frame, "1d")
            else:
                rec["error"] = "No price data from Yahoo Finance"
                rec["tfd"] = None
            stocks[m["symbol"]] = rec
        log.info("daily prices %d/%d", done, len(ysyms))

    # fundamentals (cached for 12 h in .cache/, which the workflow keeps between runs)
    def fund(sym):
        try:
            return sym, screener.fetch_fundamentals(sym + ".NS"), "ok"
        except Exception:
            return sym, None, "error"

    with ThreadPoolExecutor(max_workers=screener.FUND_WORKERS) as pool:
        for sym, f, status in pool.map(fund, syms):
            stocks[sym]["fund"] = f
            stocks[sym]["fund_status"] = status
    screener._save_fund_cache()
    log.info("fundamentals: %d ok", sum(r["fund_status"] == "ok" for r in stocks.values()))
    write_json(data_dir / "stocks.json", stocks)

    # candles for every other chart timeframe
    for tf, spec in screener.TIMEFRAMES.items():
        if tf == "1d":
            continue
        payload = {}
        for _, batch, data in screener._batched_download(ysyms, spec["interval"], spec["period"]):
            for ysym in batch:
                p = screener.tf_payload(screener._frame_for(data, ysym), tf)
                if p:
                    payload[ysym[:-3]] = p
        log.info("%s candles: %d stocks", tf, len(payload))
        write_json(data_dir / f"tf-{tf}.json", payload)

    write_json(data_dir / "meta.json", {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universes": [{"id": uid, "label": universes.label_of(uid), "symbols": [m["symbol"] for m in lists[uid]]}
                      for uid in universes.LISTED if uid in lists],
        "timeframes": screener.list_timeframes(),
    })
    log.info("done in %.0fs", time.time() - t0)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    main(sys.argv[1] if len(sys.argv) > 1 else "site")
