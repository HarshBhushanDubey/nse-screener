# NSE Strategy Screener

A small website that searches Indian (NSE) stocks with six strategies, writes the
strategy signals each stock triggers right after its name, and gives every stock an
overall **Buy / Sell** signal.

| Strategy | ▲ Buy signal | ▼ Sell signal |
|---|---|---|
| **Golden Cross / MA Trend** | 50-day SMA > 200-day SMA and price > 200-day (*MA Uptrend*, +1). Crossed within 20 sessions: *Golden Cross*, +2. | 50-day < 200-day and price < 200-day (*MA Downtrend*, −1). Crossed within 20 sessions: *Death Cross*, −2. |
| **RSI** | RSI(14) ≤ 30, oversold (+1) | RSI(14) ≥ 70, overbought (−1) |
| **52-Week High / Low** | Within 5% of the 52-week high with a volume spike ≥ 1.5× the 20-day average in the last 3 sessions (+1) | Within 5% of the 52-week low with the same volume spike (−1) |
| **Value Fundamentals** | P/E ≤ 20 (and > 0), P/B ≤ 3, ROE ≥ 15%, D/E ≤ 1 (D/E skipped for banks & finance) (+1) | none |
| **Pivot Cross** *(any timeframe)* | Latest candle closes above the pivot (+1) | Latest candle closes below the pivot (−1) |
| **Range Breakout** *(any timeframe)* | Close above the highest high of the previous 20 candles within the last 3, still holding (+1) | Close below the lowest low of the previous 20 candles (−1) |

Pivot = (high + low + close) ÷ 3 of the previous period: the previous **day** on 5 / 15 / 30-min and 1-hour
charts, and the previous day / week / month on daily / weekly / monthly charts. R1, S1, R2, S2 are shown
in the tag tooltip. Pick the chart timeframe with the **Timeframe** dropdown; the other four strategies
always use daily data.

**Signal** = sum of the points: score ≥ 3 *Strong Buy*, 1–2 *Buy*, 0 *Hold*, −1 to −2 *Sell*,
≤ −3 *Strong Sell*. Every threshold, including the "strong" cut-off, is adjustable on the page.

## Run it

```bash
cd ~/Documents/stock_search
python3 -m venv .venv                     # first time only
.venv/bin/pip install -r requirements.txt # first time only
.venv/bin/python app.py
```

Then open <http://127.0.0.1:8000>. (Set `PORT=8080` before the command to use another port.)

## Using it

- **Large and mid caps only**: the default index is *Large + Mid caps* (Nifty LargeMidcap 250). Large cap =
  top 100 companies (Nifty 100), mid cap = the next 150 (Nifty Midcap 150), as per SEBI. Each stock is tagged
  *Large cap*, *Mid cap* or *Small cap*. The **Market cap** filter offers Large + Mid, Large only, Mid only,
  Small only (251+) and All caps; choosing small or all caps switches the index to *Small caps (Smallcap 250)*
  or *All caps (Nifty 500)* automatically. Other indexes: Nifty 50, Next 50, Midcap 100, Bank and 200.
  A first load of 250 stocks takes about half a minute; Nifty 500 about a minute.
- **Buy & Sell lists** (default view): two frames side by side, *Stocks to buy* (Strong Buy first) and
  *Stocks to sell* (Strong Sell first), following all filters, each with a *Strong only* checkbox.
  *Full table* shows every stock, including Hold, with all the numbers. Results are cached (prices 15 min, fundamentals 12 h).
- **Timeframe**: 5 min, 15 min, 30 min, 1 hour, daily, weekly or monthly candles for Pivot Cross and
  Range Breakout (intraday data refreshes every 3–10 minutes).
- **Signal tiles**: counts of Strong Buy / Buy / Hold / Sell / Strong Sell; click one to filter.
- **Strategy cards**: buy and sell counts per strategy; click a count to filter by it.
- **Filter stocks**: one dropdown per strategy (Golden Cross / MA, RSI, 52-week high/low, Value,
  Pivot cross, Range breakout)
  plus an *All-in-one signal* dropdown. Use one for a single strategy or several together;
  *All must match* / *Any can match* sets how the strategy filters combine.
- **Signal column**: sortable by score; hover the badge to see which strategies added or removed points.
- **Search**: type a name or symbol to filter the table. Pick a suggestion or press Enter to
  look up any NSE stock, even outside the chosen index; it's pinned to the top of the table.
- **Adjust strategy rules**: change thresholds; results update instantly.
- Hover a strategy tag for the exact numbers behind it, or the 6-month sparkline for prices by date.

## FII & DII Buying

The **FII & DII Buying** button at the top right opens Moneycontrol's
[DII & FII Buying scan](https://www.moneycontrol.com/stock-scanner/fundamental/mc-curated-scans/dii-buying-fii-buying/CID1-SID176/)
in a new tab.

## Online version (free, works when your Mac is off)

**https://harshbhushandubey.github.io/nse-screener/**

Hosted free on GitHub Pages. A GitHub Actions workflow (`.github/workflows/site.yml`) runs
`build_site.py` every 15 minutes from 08:30 to 16:15 IST on weekdays and once each evening: it downloads
fresh prices, candles for every timeframe and fundamentals for all Nifty 500 stocks, writes them as JSON
files and publishes the site. The page reads those files, so no server is needed. Search covers the
Nifty 500. To rebuild immediately: GitHub → Actions → *Update data and publish site* → *Run workflow*.

GitHub may delay scheduled runs by a few minutes, and pauses schedules in repositories with no commits
for 60 days (re-enable them from the Actions tab).

To share straight from your Mac instead, run `./share.sh` (needs `brew install cloudflared` once); that
link works only while the Mac is on and changes each time.

## How it works

- `universes.py` downloads official index constituent lists from niftyindices.com (cached in `data/`).
- `screener.py` pulls 2 years of daily prices and key ratios from Yahoo Finance (`yfinance`),
  computes SMA 50/200, golden/death-cross age, Wilder RSI(14), 52-week high/low and volume spike,
  and the last 60 candles + pivot levels for the chosen timeframe.
- `app.py` is the Flask API for running locally; `build_site.py` builds the static online version.
- `static/app.js` applies the strategy rules in the browser and works with either.

Data comes from Yahoo Finance's free feed and can be delayed or incomplete (some ratios,
like D/E for banks, are often missing). Signals are simple rule-based scores for learning and screening, not investment advice.
