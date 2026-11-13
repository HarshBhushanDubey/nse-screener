"""Template: trade the screener's signals through Kite. Starts in PAPER mode.

    python example_algo.py          # run during market hours, checks every 5 minutes
    python example_algo.py --once   # one check, then exit (good for testing)

Copy the parts you need into your own algo, or call your own logic in my_rules() below.
This is a template, not trading advice: test it in paper mode first, keep the limits small,
and only set LIVE = True when you understand every order it will place.
"""

import sys
import time
from datetime import datetime

from signals import IST, breakout_watch, buy_list, market_open, sell_list
from trader import KiteTrader, OrderRejected

LIVE = False                       # True = real orders (needs Kite login + whitelisted static IP)
UNIVERSE = "niftylargemidcap250"   # large + mid caps
TIMEFRAME = "15m"                  # chart timeframe for pivot cross / range breakout
CAPITAL_PER_TRADE = 5_000          # ₹ per new position
MAX_OPEN_POSITIONS = 3
CHECK_EVERY_SECONDS = 300
SQUARE_OFF_AT = (15, 10)           # exit intraday (MIS) positions at 15:10 IST


def my_rules(candidate):
    """Your extra filter on top of the screener. Return True to allow the trade."""
    return candidate["score"] >= 3 and (candidate["rsi"] or 50) < 75


def check(trader, open_positions):
    now = datetime.now(IST)
    if (now.hour, now.minute) >= SQUARE_OFF_AT:
        for sym, qty in list(open_positions.items()):
            trader.sell(sym, qty)
            open_positions.pop(sym)
        return

    # exits: anything we hold that now has a Sell / Strong Sell signal
    sells = {s["symbol"] for s in sell_list(universe=UNIVERSE, timeframe=TIMEFRAME, cap="all")}
    for sym, qty in list(open_positions.items()):
        if sym in sells:
            trader.sell(sym, qty)
            open_positions.pop(sym)

    # entries: Strong Buy stocks, preferring those also near a range breakout
    near_breakout = {x["symbol"] for x in breakout_watch(universe=UNIVERSE, timeframes=(TIMEFRAME,))["breakout"]}
    candidates = buy_list(universe=UNIVERSE, timeframe=TIMEFRAME, strong_only=True)
    candidates.sort(key=lambda s: (s["symbol"] not in near_breakout, -s["score"]))
    for s in candidates:
        if len(open_positions) >= MAX_OPEN_POSITIONS:
            break
        if s["symbol"] in open_positions or not my_rules(s):
            continue
        qty = int(CAPITAL_PER_TRADE // s["price"])
        if qty < 1:
            continue
        print(f"[algo] {s['symbol']} {s['label']} {s['score']:+d}: " + ", ".join(r["label"] for r in s["reasons"]))
        try:
            trader.buy(s["symbol"], qty)
            open_positions[s["symbol"]] = qty
        except OrderRejected as exc:
            print(f"[algo] skipped {s['symbol']}: {exc}")


def main():
    once = "--once" in sys.argv
    trader = KiteTrader(live=LIVE, product="MIS", max_order_value=CAPITAL_PER_TRADE * 1.1,
                        max_orders_per_day=2 * MAX_OPEN_POSITIONS + 4,
                        allow_outside_market_hours=once and not LIVE)   # paper test runs any time
    open_positions = {p["tradingsymbol"]: p["quantity"] for p in trader.positions() if p["quantity"] > 0}
    while True:
        if market_open() or (once and not LIVE):
            try:
                check(trader, open_positions)
            except OrderRejected as exc:
                print(f"[algo] {exc}")
        else:
            print("[algo] market closed; waiting")
        if once:
            break
        time.sleep(CHECK_EVERY_SECONDS)


if __name__ == "__main__":
    main()
