"""NSE index constituent lists (Nifty 50, Nifty 500, ...).

Lists are downloaded from niftyindices.com (the official NSE index site) and
cached in ./data for a week. If the download fails, the last saved copy is used.
"""

import csv
import io
import logging
import threading
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data"
BASE_URL = "https://niftyindices.com/IndexConstituent/"
MAX_AGE = 7 * 24 * 3600  # refresh index lists weekly
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh) stock-screener"}

# id -> (label, file name on niftyindices.com)
INDICES = {
    "niftylargemidcap250": ("Large + Mid caps (LargeMidcap 250)", "ind_niftylargemidcap250list.csv"),
    "nifty100": ("Large caps (Nifty 100)", "ind_nifty100list.csv"),
    "niftymidcap150": ("Mid caps (Midcap 150)", "ind_niftymidcap150list.csv"),
    "niftysmallcap250": ("Small caps (Smallcap 250)", "ind_niftysmallcap250list.csv"),
    "nifty500": ("All caps (Nifty 500)", "ind_nifty500list.csv"),
    "nifty50": ("Nifty 50", "ind_nifty50list.csv"),
    "niftynext50": ("Nifty Next 50", "ind_niftynext50list.csv"),
    "niftymidcap100": ("Nifty Midcap 100", "ind_niftymidcap100list.csv"),
    "niftybank": ("Nifty Bank", "ind_niftybanklist.csv"),
    "nifty200": ("Nifty 200", "ind_nifty200list.csv"),
}
# Indexes offered in the dropdown.
LISTED = list(INDICES)

# SEBI market-cap categories: top 100 companies = large cap (Nifty 100),
# next 150 = mid cap (Nifty Midcap 150), everything else = small cap.
LARGE_INDEX, MID_INDEX = "nifty100", "niftymidcap150"

_lock = threading.Lock()
_master = {"t": 0.0, "rows": []}
_caps = {"t": 0.0, "map": {}}


def list_universes():
    return [{"id": uid, "label": INDICES[uid][0]} for uid in LISTED]


def cap_of(symbol):
    """'large', 'mid' or 'small' for an NSE symbol."""
    if not _caps["map"] or time.time() - _caps["t"] > 24 * 3600:
        caps = {}
        for uid, cap in ((MID_INDEX, "mid"), (LARGE_INDEX, "large")):
            try:
                for row in load(uid):
                    caps[row["symbol"]] = cap
            except RuntimeError as exc:
                log.warning("%s", exc)
        if caps:
            _caps["map"], _caps["t"] = caps, time.time()
    return _caps["map"].get(symbol, "small")


def label_of(uid):
    return INDICES[uid][0]


def _parse(text):
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        sym = (r.get("Symbol") or "").strip()
        if not sym or sym.upper().startswith("DUMMY"):  # NSE placeholder during corporate actions
            continue
        rows.append({
            "symbol": sym,
            "name": (r.get("Company Name") or sym).strip(),
            "industry": (r.get("Industry") or "").strip(),
        })
    return rows


def load(uid):
    """Return [{symbol, name, industry}, ...] for an index id."""
    label, fname = INDICES[uid]
    path = DATA_DIR / f"{uid}.csv"
    with _lock:
        fresh = path.exists() and time.time() - path.stat().st_mtime < MAX_AGE
        if not fresh:
            try:
                resp = requests.get(BASE_URL + fname, headers=HEADERS, timeout=15)
                resp.raise_for_status()
                if _parse(resp.text):
                    DATA_DIR.mkdir(exist_ok=True)
                    path.write_text(resp.text, encoding="utf-8")
            except Exception as exc:  # network down, site changed, ...
                log.warning("Could not download %s list: %s", label, exc)
        if not path.exists():
            raise RuntimeError(
                f"Couldn't download the {label} constituent list and no saved copy exists."
            )
        return _parse(path.read_text(encoding="utf-8"))


def _master_list():
    """All known NSE stocks (Nifty 500 + every saved index list), for search."""
    if _master["rows"] and time.time() - _master["t"] < 24 * 3600:
        return _master["rows"]
    seen = {}
    try:
        for row in load("nifty500"):
            seen[row["symbol"]] = row
    except RuntimeError as exc:
        log.warning("%s", exc)
    for uid in INDICES:
        path = DATA_DIR / f"{uid}.csv"
        if path.exists():
            for row in _parse(path.read_text(encoding="utf-8")):
                seen.setdefault(row["symbol"], row)
    _master["rows"] = sorted(seen.values(), key=lambda r: r["symbol"])
    _master["t"] = time.time()
    return _master["rows"]


def suggest(query, limit=8):
    """Rank known stocks by how well their symbol or name matches the query."""
    q = (query or "").strip().lower()
    if not q:
        return []
    scored = []
    for row in _master_list():
        sym, name = row["symbol"].lower(), row["name"].lower()
        if sym == q:
            score = 0
        elif sym.startswith(q):
            score = 1
        elif any(word.startswith(q) for word in name.split()):
            score = 2
        elif q in name or q in sym:
            score = 3
        else:
            continue
        scored.append((score, len(sym), row))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [r for _, _, r in scored[:limit]]


def resolve(query):
    """Best local match for a free-text query, or None."""
    hits = suggest(query, limit=1)
    return hits[0] if hits else None
