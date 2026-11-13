"""Place orders in your Zerodha account from your algo, with safety limits.

    from trader import KiteTrader
    trader = KiteTrader(live=False)          # PAPER mode: logs orders, sends nothing
    trader.buy("INFY", 5)                    # limit order a little above the live price
    trader.sell("INFY", 5)
    print(trader.positions())

Set live=True only after testing in paper mode. Live orders need:
  * today's Kite login (open http://127.0.0.1:8000 and click "Log in to Kite"), and
  * a static IP whitelisted in your Kite Connect developer account: since 1 April 2026
    SEBI/NSE rules reject API orders from other IP addresses.
Paper orders are logged to .kite/paper_orders.jsonl.
"""

import json
import math
import time
from datetime import datetime

from kite_live import IST, KITE_DIR, KiteError, kite
from signals import market_open

PAPER_LOG = KITE_DIR / "paper_orders.jsonl"
COUNT_FILE = KITE_DIR / "orders_today.json"


class OrderRejected(RuntimeError):
    """Raised when a safety limit blocks an order, or Kite rejects it."""


class KiteTrader:
    def __init__(self, live=False, product="MIS", max_order_value=10_000, max_orders_per_day=10,
                 limit_buffer_pct=0.5, allow_outside_market_hours=False, tag="nsescreener"):
        """
        live:               False = paper trading (default). True = real orders on Zerodha.
        product:            "MIS" (intraday) or "CNC" (delivery).
        max_order_value:    refuse any single order worth more than this (₹).
        max_orders_per_day: refuse orders after this many today (counted per mode).
        limit_buffer_pct:   default orders are LIMIT orders this % beyond the live price
                            (above for buys, below for sells) so they fill like market orders
                            but can never fill at a wild price.
        """
        self.live = bool(live)
        self.product = product
        self.max_order_value = max_order_value
        self.max_orders_per_day = max_orders_per_day
        self.limit_buffer_pct = limit_buffer_pct
        self.allow_outside_market_hours = allow_outside_market_hours
        self.tag = str(tag)[:20]
        self.mode = "live" if self.live else "paper"
        print(f"[trader] {self.mode.upper()} mode, product {product}, max ₹{max_order_value:,.0f} per order, "
              f"max {max_orders_per_day} orders per day")

    # ------------------------------------------------------------------ orders
    def buy(self, symbol, quantity, **kwargs):
        return self.place_order(symbol, "BUY", quantity, **kwargs)

    def sell(self, symbol, quantity, **kwargs):
        return self.place_order(symbol, "SELL", quantity, **kwargs)

    def place_order(self, symbol, side, quantity, order_type="LIMIT", price=None, trigger_price=None,
                    product=None, validity="DAY", **extra):
        """Place a NSE cash order. Returns {"order_id", "mode", "symbol", "side", "quantity", "price", ...}.

        order_type: "LIMIT" (default; price = live price ± limit_buffer_pct if not given),
                    "MARKET", "SL" (needs price and trigger_price) or "SL-M" (needs trigger_price).
        extra:      any other Kite order field, passed through unchanged.
        """
        symbol, side = symbol.upper().strip(), side.upper()
        product = product or self.product
        if side not in ("BUY", "SELL"):
            raise OrderRejected(f"side must be BUY or SELL, not {side!r}")
        if not isinstance(quantity, int) or quantity <= 0:
            raise OrderRejected(f"quantity must be a whole number above 0, not {quantity!r}")
        if not self.allow_outside_market_hours and not market_open():
            raise OrderRejected("Market is closed (09:15-15:30 IST, Mon-Fri). Order not placed.")
        if self._count_today() >= self.max_orders_per_day:
            raise OrderRejected(f"Daily limit of {self.max_orders_per_day} {self.mode} orders reached.")

        ltp = self.last_price(symbol)
        if order_type == "LIMIT" and price is None:
            buf = self.limit_buffer_pct / 100
            price = self._round_tick(symbol, ltp * (1 + buf if side == "BUY" else 1 - buf), side)
        value = quantity * (price or trigger_price or ltp)
        if value > self.max_order_value:
            raise OrderRejected(f"Order value ₹{value:,.0f} is above max_order_value ₹{self.max_order_value:,.0f}.")

        order = {"symbol": symbol, "side": side, "quantity": quantity, "order_type": order_type,
                 "price": price, "trigger_price": trigger_price, "product": product, "ltp": ltp,
                 "value": round(value, 2), "mode": self.mode,
                 "time": datetime.now(IST).isoformat(timespec="seconds")}

        if not self.live:
            order["order_id"] = f"PAPER-{int(time.time() * 1000)}"
            KITE_DIR.mkdir(exist_ok=True)
            with PAPER_LOG.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(order) + "\n")
        else:
            fields = {"tradingsymbol": symbol, "exchange": "NSE", "transaction_type": side,
                      "order_type": order_type, "quantity": quantity, "product": product,
                      "validity": validity, "tag": self.tag, **extra}
            if price is not None and order_type in ("LIMIT", "SL"):
                fields["price"] = price
            if trigger_price is not None:
                fields["trigger_price"] = trigger_price
            try:
                data = kite.request("POST", "/orders/regular", data=fields)
            except KiteError as exc:
                raise OrderRejected(f"Kite rejected the order: {exc}") from exc
            order["order_id"] = data["order_id"]
        self._count_today(add=1)
        print(f"[trader] {self.mode.upper()} {side} {quantity} {symbol} {order_type}"
              f"{f' @ ₹{price}' if price else ''} (LTP ₹{ltp}) -> order {order['order_id']}")
        return order

    def cancel(self, order_id, variety="regular"):
        if not self.live:
            print(f"[trader] PAPER cancel {order_id}")
            return {"order_id": order_id, "mode": "paper"}
        return kite.request("DELETE", f"/orders/{variety}/{order_id}")

    # ------------------------------------------------------------------ account
    def orders(self):
        """Today's orders (live) or today's paper orders."""
        if self.live:
            return kite.request("GET", "/orders")
        if not PAPER_LOG.exists():
            return []
        today = datetime.now(IST).date().isoformat()
        rows = [json.loads(x) for x in PAPER_LOG.read_text(encoding="utf-8").splitlines() if x.strip()]
        return [o for o in rows if o["time"].startswith(today)]

    def positions(self):
        """Live: Kite net positions. Paper: net quantity per symbol from today's paper orders."""
        if self.live:
            return (kite.request("GET", "/portfolio/positions") or {}).get("net", [])
        net = {}
        for o in self.orders():
            net[o["symbol"]] = net.get(o["symbol"], 0) + (o["quantity"] if o["side"] == "BUY" else -o["quantity"])
        return [{"tradingsymbol": s, "quantity": q} for s, q in net.items() if q]

    def holdings(self):
        return kite.request("GET", "/portfolio/holdings") if self.live else []

    def margins(self):
        return kite.request("GET", "/user/margins/equity") if self.live else {}

    # ------------------------------------------------------------------ helpers
    def last_price(self, symbol):
        """Live Kite price if logged in; otherwise (paper mode only) the latest Yahoo price."""
        if kite.session():
            q = kite.quotes([symbol]).get(symbol)
            if q and q.get("ltp"):
                return q["ltp"]
            raise OrderRejected(f"Kite has no price for NSE:{symbol}; check the symbol.")
        if self.live:
            raise OrderRejected("Not logged in to Kite today: open http://127.0.0.1:8000 and click Log in to Kite.")
        import screener
        rec = screener.lookup(symbol)
        return rec["price"]

    def _round_tick(self, symbol, price, side):
        tick = kite.tick_size(symbol) if kite.session() else 0.05
        steps = price / tick
        steps = math.ceil(steps) if side == "BUY" else math.floor(steps)
        return round(steps * tick, 2)

    def _count_today(self, add=0):
        today = datetime.now(IST).date().isoformat()
        try:
            data = json.loads(COUNT_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if data.get("date") != today:
            data = {"date": today}
        data[self.mode] = data.get(self.mode, 0) + add
        if add:
            KITE_DIR.mkdir(exist_ok=True)
            COUNT_FILE.write_text(json.dumps(data), encoding="utf-8")
        return data[self.mode]
