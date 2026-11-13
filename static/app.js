/* NSE Strategy Screener - browser side.
 * The server sends raw metrics; this file applies the strategy rules, scores
 * buy/sell signals and filters, so everything updates instantly. */
(() => {
  'use strict';

  // ------------------------------------------------------------ utilities
  const $ = (sel, el = document) => el.querySelector(sel);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
  };

  const fmt = {};
  const nf = (d) => (fmt[d] ||= new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const num = (v, d = 1) => (v == null ? '—' : nf(d).format(v));
  const inr = (v) => (v == null ? '—' : '₹' + nf(2).format(v));
  const signed = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + nf(d).format(Math.abs(v)) + '%');
  const signedInt = (v) => (v > 0 ? '+' + v : v < 0 ? '−' + Math.abs(v) : '0');
  const pctDiff = (a, b) => (a == null || b == null || !b ? null : (a / b - 1) * 100);
  const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const UP = '<span class="arr up" aria-hidden="true">▲</span>';
  const DOWN = '<span class="arr down" aria-hidden="true">▼</span>';

  async function api(url, opts = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
    let body = null;
    try { body = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
    return body;
  }

  // ------------------------------------------------------------ static mode (GitHub Pages)
  // When data/meta.json exists the site runs without a server: build_site.py pre-computes
  // every stock's metrics on a schedule and the browser reads those files.
  const STATIC = { on: false, meta: null, stocks: null, tf: {} };

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Couldn’t load ${url.split('?')[0]} (${res.status})`);
    return res.json();
  }

  async function detectStatic() {
    try {
      const res = await fetch('data/meta.json', { cache: 'no-cache' });
      if (!res.ok) return false;
      STATIC.meta = await res.json();
      STATIC.on = true;
    } catch (e) { /* no static data: use the Flask API */ }
    return STATIC.on;
  }

  async function staticLoad(force) {
    if (force) {
      STATIC.meta = await getJSON(`data/meta.json?t=${Date.now()}`);
      STATIC.stocks = null;
      STATIC.tf = {};
    }
    const v = `?v=${encodeURIComponent(STATIC.meta.updated)}`;
    if (!STATIC.stocks) STATIC.stocks = await getJSON(`data/stocks.json${v}`);
    if (state.tf !== '1d' && !STATIC.tf[state.tf]) STATIC.tf[state.tf] = await getJSON(`data/tf-${state.tf}.json${v}`);
  }

  function staticRecord(sym) {
    const r = STATIC.stocks && STATIC.stocks[sym];
    if (!r) return null;
    const t = state.tf === '1d' ? r.tfd : (STATIC.tf[state.tf] || {})[sym];
    return { ...r, tf: state.tf, tfd: t || null, tf_status: t ? 'ok' : 'error' };
  }

  async function staticScan(token, force) {
    const label = universeLabel();
    state.scan = { state: 'running', label, phase: 'Loading data' };
    render();
    try {
      await staticLoad(force);
      if (token !== state.pollToken) return;
      const uni = STATIC.meta.universes.find((u) => u.id === state.universe) || STATIC.meta.universes[0];
      state.stocks = new Map();
      for (const sym of uni.symbols) {
        const rec = staticRecord(sym);
        if (rec) state.stocks.set(rec.ysym, rec);
      }
      state.scan = { state: 'done', label: uni.label, count: state.stocks.size, finished: STATIC.meta.updated };
    } catch (e) {
      state.scan = { state: 'error', error: e.message, label };
    }
    render();
  }

  function staticSuggest(query, limit = 8) {
    const q = query.trim().toLowerCase();
    if (!q || !STATIC.stocks) return [];
    const scored = [];
    for (const r of Object.values(STATIC.stocks)) {
      const sym = r.symbol.toLowerCase(), name = (r.name || '').toLowerCase();
      let score;
      if (sym === q) score = 0;
      else if (sym.startsWith(q)) score = 1;
      else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
      else if (name.includes(q) || sym.includes(q)) score = 3;
      else continue;
      scored.push([score, sym.length, r]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, limit).map(([, , r]) => ({ symbol: r.symbol, name: r.name, industry: r.industry }));
  }

  async function staticLookup(q) {
    await staticLoad(false);
    const key = q.trim().toUpperCase().replace(/\.(NS|BO)$/, '');
    const sym = STATIC.stocks[key] ? key : (staticSuggest(q)[0] || {}).symbol;
    const rec = sym && staticRecord(sym);
    if (!rec) throw new Error(`“${q}” isn’t in the Nifty 500, which the online version covers.`);
    return rec;
  }

  const lookupRecord = (q) => (STATIC.on ? staticLookup(q)
    : api(`/api/lookup?q=${encodeURIComponent(q)}&tf=${encodeURIComponent(state.tf)}`));

  // ------------------------------------------------------------ strategies
  const STRATEGIES = [
    {
      key: 'ma', name: 'Golden Cross / MA Trend', short: 'Golden Cross / MA', color: 'var(--s1)',
      buy: (R) => `50-day average above the 200-day and price above the 200-day. A cross within ${R.crossWithin} sessions is a fresh Golden Cross (+2).`,
      sell: (R) => `50-day below the 200-day and price below it. A cross within ${R.crossWithin} sessions is a fresh Death Cross (−2).`,
    },
    {
      key: 'rsi', name: 'RSI Oversold / Overbought', short: 'RSI', color: 'var(--s2)',
      buy: (R) => `RSI(14) at or below ${R.oversold}: oversold, possible bounce.`,
      sell: (R) => `RSI(14) at or above ${R.overbought}: overbought, stretched.`,
    },
    {
      key: 'high', name: '52-Week High / Low Breakout', short: '52-week high / low', color: 'var(--s3)',
      buy: (R) => `Within ${R.nearHigh}% of the 52-week high with volume ≥ ${R.volSpike}× the 20-day average (last 3 sessions).`,
      sell: (R) => `Within ${R.nearLow}% of the 52-week low with the same volume spike: breakdown.`,
    },
    {
      key: 'value', name: 'Value Fundamentals', short: 'Value', color: 'var(--s4)',
      buy: (R) => `P/E ${R.maxPE} or less, P/B ${R.maxPB} or less, ROE ≥ ${R.minROE}%, debt/equity ≤ ${R.maxDE} (D/E skipped for banks & finance).`,
      sell: null,
    },
    {
      key: 'pivot', name: 'Pivot Cross', short: 'Pivot cross', color: 'var(--s5)', usesTf: true,
      buy: (R, T) => `On the ${T.label.toLowerCase()} chart, a candle closed above the pivot within the last ${R.pivotWithin} candle${R.pivotWithin == 1 ? '' : 's'}. Pivot = (high + low + close) ÷ 3 of the ${T.basis}.`,
      sell: (R, T) => `A ${T.label.toLowerCase()} candle closed below the pivot within the last ${R.pivotWithin} candle${R.pivotWithin == 1 ? '' : 's'}.`,
    },
    {
      key: 'range', name: 'Range Breakout', short: 'Range breakout', color: 'var(--s6)', usesTf: true,
      buy: (R, T) => `On the ${T.label.toLowerCase()} chart, a close above the highest high of the previous ${R.rangeLookback} candles within the last ${R.rangeWithin}, still holding`
        + (R.maxRangeWidth > 0 ? `; range no wider than ${R.maxRangeWidth}%.` : '.'),
      sell: (R) => `A close below the lowest low of the previous ${R.rangeLookback} candles: range breakdown.`,
    },
  ];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const STRAT_KEYS = STRATEGIES.map((s) => s.key);
  const TF_FALLBACK = { id: '1d', label: 'Daily', short: '1D', basis: 'previous day' };
  const tfMeta = () => state.timeframes.find((t) => t.id === state.tf) || TF_FALLBACK;
  const COLOR = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.color]));

  const LEVELS = [
    { key: 'strongbuy', label: 'Strong Buy', icon: '▲▲' },
    { key: 'buy', label: 'Buy', icon: '▲' },
    { key: 'hold', label: 'Hold', icon: '●' },
    { key: 'sell', label: 'Sell', icon: '▼' },
    { key: 'strongsell', label: 'Strong Sell', icon: '▼▼' },
  ];
  const LEVEL = Object.fromEntries(LEVELS.map((l) => [l.key, l]));

  const DEFAULT_RULES = {
    crossWithin: 20, oversold: 30, overbought: 70,
    nearHigh: 5, nearLow: 5, volSpike: 1.5,
    maxPE: 20, maxPB: 3, minROE: 15, maxDE: 1,
    pivotWithin: 1, rangeLookback: 20, rangeWithin: 3, maxRangeWidth: 0,
    squeezeRatio: 0.8, nearEdge: 20,
    strongAt: 3,
  };
  const RULE_GROUPS = [
    { name: 'Golden Cross / MA Trend', color: 'var(--s1)', fields: [['crossWithin', 'Fresh cross within (sessions)', 1]] },
    { name: 'RSI', color: 'var(--s2)', fields: [['oversold', 'Oversold (buy) at or below', 1], ['overbought', 'Overbought (sell) at or above', 1]] },
    { name: '52-Week High / Low', color: 'var(--s3)', fields: [['nearHigh', 'Within % of 52W high', 0.5], ['nearLow', 'Within % of 52W low', 0.5], ['volSpike', 'Volume spike (× average)', 0.1]] },
    { name: 'Value', color: 'var(--s4)', fields: [['maxPE', 'Max P/E', 1], ['maxPB', 'Max P/B', 0.1], ['minROE', 'Min ROE %', 1], ['maxDE', 'Max debt / equity', 0.1]] },
    { name: 'Pivot Cross', color: 'var(--s5)', fields: [['pivotWithin', 'Cross within last N candles (1–10)', 1]] },
    { name: 'Range Breakout', color: 'var(--s6)', fields: [['rangeLookback', 'Range length (5–50 candles)', 1], ['rangeWithin', 'Breakout within last N candles (1–10)', 1], ['maxRangeWidth', 'Max range width % (0 = any)', 0.5]] },
    { name: 'Breakout watch', color: 'var(--s6)', fields: [['squeezeRatio', 'Tight range: at most × usual width', 0.05], ['nearEdge', 'Near edge: within top / bottom % of range', 5]] },
    { name: 'Signal score', color: 'var(--axis)', fields: [['strongAt', 'Strong Buy / Sell at score ±', 1]] },
  ];

  function levelFor(score, R) {
    const strong = Math.max(1, R.strongAt);
    if (score >= strong) return 'strongbuy';
    if (score > 0) return 'buy';
    if (score === 0) return 'hold';
    if (score > -strong) return 'sell';
    return 'strongsell';
  }

  /**
   * Evaluate every strategy for one stock.
   * Each tag: { key, dir: +1 buy / -1 sell, pts, sub, label, detail }.
   * The signal score is the sum of the tags' points.
   */
  function evaluate(r, R) {
    const tags = [];
    if (r.price == null) return { tags, byKey: {}, score: null, level: null };

    // Golden cross / moving-average trend
    if (r.sma50 != null && r.sma200 != null) {
      const vs = signed(pctDiff(r.price, r.sma200));
      if (r.sma50 > r.sma200 && r.price > r.sma200) {
        const fresh = r.gc_days != null && r.gc_days <= R.crossWithin;
        tags.push({
          key: 'ma', dir: 1, pts: fresh ? 2 : 1, sub: fresh ? 'gc' : 'up',
          label: fresh ? `Golden Cross · ${r.gc_days === 0 ? 'today' : r.gc_days + 'd ago'}` : 'MA Uptrend',
          detail: `50-day avg ${inr(r.sma50)} is above the 200-day avg ${inr(r.sma200)}; price is ${vs} vs the 200-day.`
            + (fresh ? ` The 50-day crossed above ${r.gc_days === 0 ? 'today' : r.gc_days + ' sessions ago'}.` : ''),
        });
      } else if (r.sma50 < r.sma200 && r.price < r.sma200) {
        const fresh = r.dc_days != null && r.dc_days <= R.crossWithin;
        tags.push({
          key: 'ma', dir: -1, pts: fresh ? -2 : -1, sub: fresh ? 'dc' : 'down',
          label: fresh ? `Death Cross · ${r.dc_days === 0 ? 'today' : r.dc_days + 'd ago'}` : 'MA Downtrend',
          detail: `50-day avg ${inr(r.sma50)} is below the 200-day avg ${inr(r.sma200)}; price is ${vs} vs the 200-day.`
            + (fresh ? ` The 50-day crossed below ${r.dc_days === 0 ? 'today' : r.dc_days + ' sessions ago'}.` : ''),
        });
      }
    }

    // RSI
    if (r.rsi != null) {
      if (r.rsi <= R.oversold) {
        tags.push({ key: 'rsi', dir: 1, pts: 1, sub: 'oversold', label: `RSI Oversold · ${num(r.rsi, 0)}`,
          detail: `RSI(14) is ${num(r.rsi)}, at or below ${R.oversold}. Selling may be overdone.` });
      } else if (r.rsi >= R.overbought) {
        tags.push({ key: 'rsi', dir: -1, pts: -1, sub: 'overbought', label: `RSI Overbought · ${num(r.rsi, 0)}`,
          detail: `RSI(14) is ${num(r.rsi)}, at or above ${R.overbought}. Strong run-up; may be due a pullback.` });
      }
    }

    // 52-week high breakout / low breakdown (both need a volume spike)
    if (r.vol_ratio != null && r.vol_ratio >= R.volSpike) {
      if (r.pct_from_high != null && r.pct_from_high >= -R.nearHigh) {
        tags.push({ key: 'high', dir: 1, pts: 1, sub: 'breakout', label: `52W High Breakout · ${num(r.vol_ratio)}× vol`,
          detail: `Price ${inr(r.price)} is ${num(Math.abs(r.pct_from_high))}% below the 52-week high of ${inr(r.high52)}. Volume reached ${num(r.vol_ratio)}× its 20-day average in the last 3 sessions.` });
      } else if (r.pct_from_low != null && r.pct_from_low <= R.nearLow) {
        tags.push({ key: 'high', dir: -1, pts: -1, sub: 'breakdown', label: `52W Low Breakdown · ${num(r.vol_ratio)}× vol`,
          detail: `Price ${inr(r.price)} is only ${num(r.pct_from_low)}% above the 52-week low of ${inr(r.low52)}. Volume reached ${num(r.vol_ratio)}× its 20-day average in the last 3 sessions.` });
      }
    }

    // Value fundamentals (buy side only)
    const f = r.fund;
    if (f) {
      const fin = f.sector === 'Financial Services';
      const ok = f.pe != null && f.pe > 0 && f.pe <= R.maxPE
        && f.pb != null && f.pb <= R.maxPB
        && f.roe != null && f.roe >= R.minROE
        && (fin || (f.de != null && f.de <= R.maxDE));
      if (ok) {
        tags.push({ key: 'value', dir: 1, pts: 1, sub: 'value', label: `Value · P/E ${num(f.pe)}`,
          detail: `P/E ${num(f.pe)}, P/B ${num(f.pb)}, ROE ${num(f.roe)}%`
            + (fin ? '. Finance company, so debt/equity is not checked.' : `, debt/equity ${num(f.de, 2)}.`) });
      }
    }

    // Pivot cross + range breakout on the chosen chart timeframe
    const T = r.tf === state.tf ? r.tfd : null;
    if (T && T.c && T.c.length > 2) {
      const tfm = tfMeta();
      const { h, l, c, p } = T;
      const n = c.length;
      const lv = T.lv || {};
      const levels = lv.P != null ? ` Levels now: R1 ${inr(lv.R1)}, P ${inr(lv.P)}, S1 ${inr(lv.S1)}.` : '';
      const agoText = (ago) => (ago === 0 ? 'on the latest candle' : `${ago} candle${ago === 1 ? '' : 's'} ago`);

      const pw = clamp(R.pivotWithin, 1, 10);
      for (let i = n - 1; i >= Math.max(1, n - pw); i--) {
        if ([c[i], c[i - 1], p[i], p[i - 1]].some((v) => v == null)) continue;
        const up = c[i - 1] <= p[i - 1] && c[i] > p[i];
        const down = c[i - 1] >= p[i - 1] && c[i] < p[i];
        if (!up && !down) continue;
        const ago = n - 1 - i;
        tags.push({
          key: 'pivot', dir: up ? 1 : -1, pts: up ? 1 : -1, sub: up ? 'up' : 'down',
          label: `Pivot Cross ${up ? 'Up' : 'Down'} · ${tfm.short}`,
          detail: `On the ${tfm.label.toLowerCase()} chart, price closed ${up ? 'above' : 'below'} the pivot ${inr(p[i])} ${agoText(ago)} `
            + `(pivot from the ${tfm.basis}). Last close ${inr(c[n - 1])}, ${T.last}.${levels}`,
        });
        break;
      }

      const rw = clamp(R.rangeWithin, 1, 10);
      const look = clamp(R.rangeLookback, 5, Math.min(50, n - rw));
      for (let i = n - 1; i >= n - rw && i - look >= 0; i--) {
        if (c[i] == null) continue;
        let hi = -Infinity, lo = Infinity;
        for (let j = i - look; j < i; j++) {
          if (h[j] != null && h[j] > hi) hi = h[j];
          if (l[j] != null && l[j] < lo) lo = l[j];
        }
        if (!Number.isFinite(hi) || !Number.isFinite(lo) || lo <= 0) continue;
        const width = (hi - lo) / lo * 100;
        if (R.maxRangeWidth > 0 && width > R.maxRangeWidth) continue;
        const up = c[i] > hi, down = c[i] < lo;
        if (!up && !down) continue;
        // the most recent break counts only while price is still beyond the range
        if (up ? c[n - 1] > hi : c[n - 1] < lo) {
          const ago = n - 1 - i;
          tags.push({
            key: 'range', dir: up ? 1 : -1, pts: up ? 1 : -1, sub: up ? 'breakout' : 'breakdown',
            label: `Range ${up ? 'Breakout' : 'Breakdown'} · ${tfm.short}`,
            detail: `On the ${tfm.label.toLowerCase()} chart, price closed ${up ? 'above' : 'below'} the ${look}-candle range `
              + `(${inr(lo)} to ${inr(hi)}, ${num(width)}% wide) ${agoText(ago)} and is still ${up ? 'above' : 'below'} it. `
              + `Last close ${inr(c[n - 1])}, ${T.last}.`,
          });
        }
        break;
      }
    }

    const score = tags.reduce((s, t) => s + t.pts, 0);
    const byKey = Object.fromEntries(tags.map((t) => [t.key, t]));
    return { tags, byKey, score, level: levelFor(score, R) };
  }

  // ------------------------------------------------------------ filters
  const SIGNAL_SETS = {
    all: null,
    active: ['strongbuy', 'buy', 'sell', 'strongsell'],
    buyish: ['strongbuy', 'buy'],
    sellish: ['sell', 'strongsell'],
    strongbuy: ['strongbuy'], buy: ['buy'], hold: ['hold'], sell: ['sell'], strongsell: ['strongsell'],
  };
  const CAPS = { large: 'Large cap', mid: 'Mid cap', small: 'Small cap' };
  const CAP_SETS = { largemid: ['large', 'mid'], large: ['large'], mid: ['mid'], small: ['small'], all: ['large', 'mid', 'small'] };
  // which market-cap groups each index contains, and the index to switch to for a cap choice
  const INDEX_CAPS = {
    niftylargemidcap250: ['large', 'mid'], nifty100: ['large'], niftymidcap150: ['mid'], niftysmallcap250: ['small'],
    nifty500: ['large', 'mid', 'small'], nifty50: ['large'], niftynext50: ['large'], niftymidcap100: ['mid'],
    niftybank: ['large', 'mid'], nifty200: ['large', 'mid'],
  };
  const CAP_INDEX = { largemid: 'niftylargemidcap250', large: 'niftylargemidcap250', mid: 'niftylargemidcap250', small: 'niftysmallcap250', all: 'nifty500' };
  const INDEX_DEFAULT_CAP = { niftysmallcap250: 'small', nifty500: 'all' };
  const FILTERS = [
    { key: 'cap', label: 'Market cap', color: null, options: [
      ['largemid', 'Large + Mid caps'], ['large', 'Large caps only (top 100)'], ['mid', 'Mid caps only (101–250)'],
      ['small', 'Small caps only (251+)'], ['all', 'All caps (large + mid + small)']] },
    { key: 'signal', label: 'All-in-one signal', color: null, options: [
      ['all', 'All stocks'], ['active', 'Any Buy or Sell'], ['buyish', '▲ Buy + Strong Buy'], ['strongbuy', '▲▲ Strong Buy only'],
      ['buy', '▲ Buy only'], ['hold', '● Hold'], ['sell', '▼ Sell only'], ['strongsell', '▼▼ Strong Sell only'], ['sellish', '▼ Sell + Strong Sell']] },
    { key: 'ma', label: 'Golden Cross / MA', color: 'var(--s1)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: golden cross or uptrend'], ['gc', '▲ Fresh golden cross only'],
      ['sell', '▼ Sell: death cross or downtrend'], ['dc', '▼ Fresh death cross only'], ['none', 'No MA signal']] },
    { key: 'rsi', label: 'RSI', color: 'var(--s2)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: oversold'], ['sell', '▼ Sell: overbought'], ['none', 'Neutral (no RSI signal)']] },
    { key: 'high', label: '52-week high / low', color: 'var(--s3)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: 52W high breakout'], ['sell', '▼ Sell: 52W low breakdown'], ['none', 'No 52W signal']] },
    { key: 'value', label: 'Value', color: 'var(--s4)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: passes value screen'], ['none', 'Fails / no data']] },
    { key: 'pivot', label: 'Pivot cross', color: 'var(--s5)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: crossed above pivot'], ['sell', '▼ Sell: crossed below pivot'], ['none', 'No pivot cross']] },
    { key: 'range', label: 'Range breakout', color: 'var(--s6)', options: [
      ['any', 'Any'], ['buy', '▲ Buy: range breakout'], ['sell', '▼ Sell: range breakdown'], ['none', 'Inside range']] },
  ];
  const DEFAULT_FILTERS = { cap: 'largemid', signal: 'all', ma: 'any', rsi: 'any', high: 'any', value: 'any', pivot: 'any', range: 'any' };

  function loadFilters() {
    const saved = store.get('filters', {});
    const out = { ...DEFAULT_FILTERS };
    for (const f of FILTERS) {
      if (saved[f.key] && f.options.some(([v]) => v === saved[f.key])) out[f.key] = saved[f.key];
    }
    return out;
  }

  function strategyPasses(tag, opt) {
    switch (opt) {
      case 'buy': return !!tag && tag.dir > 0;
      case 'sell': return !!tag && tag.dir < 0;
      case 'gc': return !!tag && tag.sub === 'gc';
      case 'dc': return !!tag && tag.sub === 'dc';
      case 'none': return !tag;
      default: return true;
    }
  }

  function passesFilters(e) {
    const F = state.filters;
    const set = SIGNAL_SETS[F.signal];
    if (set && !set.includes(e.level)) return false;
    const active = STRAT_KEYS.filter((k) => F[k] !== 'any');
    if (!active.length) return true;
    if (e.score == null) return false;
    const test = (k) => strategyPasses(e.byKey[k], F[k]);
    return state.mode === 'any' ? active.some(test) : active.every(test);
  }

  const capPasses = (r) => (CAP_SETS[state.filters.cap] || CAP_SETS.largemid).includes(r.cap);

  const defaultFilters = () => ({ ...DEFAULT_FILTERS, cap: INDEX_DEFAULT_CAP[state.universe] || 'largemid' });
  const filtersActive = () => { const d = defaultFilters(); return Object.keys(d).some((k) => state.filters[k] !== d[k]); };
  /** Keep the market-cap filter compatible with the chosen index. */
  function fitCapToIndex() {
    const has = INDEX_CAPS[state.universe] || CAP_SETS.all;
    if (!CAP_SETS[state.filters.cap].some((c) => has.includes(c))) state.filters.cap = defaultFilters().cap;
  }

  // ------------------------------------------------------------ state
  const savedSort = store.get('sort', null);
  const state = {
    universes: [],
    universe: store.get('index', 'niftylargemidcap250'),
    timeframes: [],
    tf: store.get('tf', '1d'),
    scan: null,
    scanId: null,
    version: -1,
    stocks: new Map(),   // ysym -> record (current index)
    lookups: new Map(),  // ysym -> record (searched stocks outside the index)
    filters: loadFilters(),
    mode: store.get('mode', 'all') === 'any' ? 'any' : 'all',
    rules: Object.assign({}, DEFAULT_RULES, store.get('rules', {})),
    sort: savedSort && savedSort.key ? savedSort : { key: 'signal', dir: -1 },
    view: ['split', 'watch', 'table'].includes(store.get('view', 'split')) ? store.get('view', 'split') : 'split',
    watchTfs: store.get('watchTfs', ['15m', '1h', '1d', '1wk']),
    strongOnly: Object.assign({ buy: false, sell: false }, store.get('strongOnly', {})),
    query: '',
    flash: null,
    pollTimer: null,
    pollToken: 0,
  };

  // ------------------------------------------------------------ table columns
  const vs200 = (r) => pctDiff(r.price, r.sma200);
  const fundCell = (r, v) => {
    if (r.fund_status === 'pending') return '<span class="pending" title="Loading fundamentals">…</span>';
    return v == null ? '<span class="na">—</span>' : v;
  };
  const COLUMNS = [
    { key: 'symbol', label: 'Stock · strategy signals', value: (r) => r.symbol, text: true, asc: true },
    { key: 'signal', label: 'Signal', value: (r, e) => e.score, left: true },
    { key: 'trend', label: '6M trend', nosort: true },
    { key: 'price', label: 'Price', value: (r) => r.price },
    { key: 'change_pct', label: 'Day', value: (r) => r.change_pct },
    { key: 'rsi', label: 'RSI 14', value: (r) => r.rsi },
    { key: 'vs200', label: 'vs 200 DMA', value: vs200 },
    { key: 'pct_from_high', label: 'From 52W high', value: (r) => r.pct_from_high },
    { key: 'vol_ratio', label: 'Vol spike', value: (r) => r.vol_ratio },
    { key: 'pe', label: 'P/E', value: (r) => r.fund && r.fund.pe, asc: true },
    { key: 'pb', label: 'P/B', value: (r) => r.fund && r.fund.pb, asc: true },
    { key: 'roe', label: 'ROE', value: (r) => r.fund && r.fund.roe },
    { key: 'de', label: 'D/E', value: (r) => r.fund && r.fund.de, asc: true },
    { key: 'mcap', label: 'Mkt cap ₹ Cr', value: (r) => r.fund && r.fund.mcap },
  ];
  if (!COLUMNS.some((c) => c.key === state.sort.key && !c.nosort)) state.sort = { key: 'signal', dir: -1 };

  function renderHead() {
    $('#headRow').innerHTML = COLUMNS.map((c) => {
      if (c.nosort) return `<th class="nosort" scope="col">${esc(c.label)}</th>`;
      const active = state.sort.key === c.key;
      const aria = active ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none';
      const arrow = active ? (state.sort.dir > 0 ? '▲' : '▼') : '';
      return `<th scope="col" aria-sort="${aria}"${c.left ? ' class="sig-cell"' : ''}><button type="button" data-sort="${c.key}"${c.left ? ' style="justify-content:flex-start"' : ''}>${esc(c.label)}<span class="arrow" aria-hidden="true">${arrow}</span></button></th>`;
    }).join('');
  }

  // ------------------------------------------------------------ sparkline
  const SPARK = { W: 100, H: 32, P: 3 };
  function sparkGeom(c) {
    let min = Infinity, max = -Infinity;
    for (const v of c) if (v != null) { if (v < min) min = v; if (v > max) max = v; }
    const span = max - min || 1;
    const step = (SPARK.W - 2 * SPARK.P) / (c.length - 1);
    return {
      x: (i) => SPARK.P + i * step,
      y: (v) => SPARK.H - SPARK.P - ((v - min) / span) * (SPARK.H - 2 * SPARK.P),
      step,
    };
  }
  function sparkSVG(r) {
    const c = r.spark && r.spark.c;
    if (!c || c.length < 2) return '<span class="na">—</span>';
    const g = sparkGeom(c);
    let d = '';
    c.forEach((v, i) => { if (v != null) d += (d ? 'L' : 'M') + g.x(i).toFixed(1) + ' ' + g.y(v).toFixed(1); });
    const last = c.length - 1;
    const chg = pctDiff(c[last], c[0]);
    return `<svg class="spark" viewBox="0 0 ${SPARK.W} ${SPARK.H}" data-ysym="${esc(r.ysym)}" role="img" aria-label="6-month trend ${esc(signed(chg))}">`
      + `<path class="line" d="${d}"/><circle class="end" cx="${g.x(last).toFixed(1)}" cy="${g.y(c[last]).toFixed(1)}" r="2.5"/></svg>`;
  }

  // ------------------------------------------------------------ rows
  function quoteURL(r) {
    if (r.ysym.endsWith('.BO')) return `https://finance.yahoo.com/quote/${encodeURIComponent(r.ysym)}`;
    return `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(r.symbol)}`;
  }

  function signalTip(e) {
    const L = LEVEL[e.level];
    const why = e.tags.length
      ? e.tags.map((t) => `${t.label.split(' · ')[0]} ${signedInt(t.pts)}`).join(', ')
      : 'No strategy gives a buy or sell signal';
    const wait = [e.pendingFund && 'fundamentals', e.pendingTf && `${tfMeta().label.toLowerCase()} candles`].filter(Boolean).join(' and ');
    return `${L.label}, score ${signedInt(e.score)}. ${why}.${wait ? ` Still loading ${wait}.` : ''}`;
  }

  const sigHTML = (e) => `<span class="sig sig-${e.level}" tabindex="0" data-tip="${esc(signalTip(e))}"><span aria-hidden="true">${LEVEL[e.level].icon}</span>${esc(LEVEL[e.level].label)}</span>`;

  function signalBadge(e) {
    if (e.level == null) return '<span class="na">—</span>';
    return sigHTML(e) + `<span class="sub">score ${signedInt(e.score)}</span>`;
  }

  const tagHTML = (t) =>
    `<span class="tag" tabindex="0" style="--c:${COLOR[t.key]}" data-tip="${esc(t.detail)}">${t.dir > 0 ? UP : DOWN}${esc(t.label)}</span>`;
  const capChip = (r) => (r.cap ? `<span class="cap cap-${r.cap}">${CAPS[r.cap]}</span>` : '');
  const pinnedExtra = (r) =>
    `<span class="badge">Searched${r.exchange === 'BSE' ? ' · BSE' : ''}</span><button class="remove" type="button" data-remove="${esc(r.ysym)}" aria-label="Remove ${esc(r.symbol)}" title="Remove">×</button>`;
  const symLink = (r) => `<a class="sym" href="${quoteURL(r)}" target="_blank" rel="noopener">${esc(r.symbol)}</a>`;

  function rowHTML(r, e, pinned) {
    const tags = e.tags.map(tagHTML).join('');
    let below;
    if (r.error) below = `<div class="row-error">${esc(r.error)}</div>`;
    else if (tags) below = `<div class="tags">${tags}</div>`;
    else below = `<div class="no-match">No strategy signal${r.fund_status === 'pending' ? ' yet' : ''}</div>`;

    const f = r.fund || {};
    const chgCls = r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : '';
    const v2 = vs200(r);
    return `<tr data-ysym="${esc(r.ysym)}">
      <td class="stock-cell">
        <div class="stock-line">${symLink(r)}<span class="co">${esc(r.name)}</span>${capChip(r)}${pinned ? pinnedExtra(r) : ''}</div>
        ${below}
      </td>
      <td class="sig-cell">${signalBadge(e)}</td>
      <td>${sparkSVG(r)}</td>
      <td>${r.price == null ? '<span class="na">—</span>' : inr(r.price)}${r.live ? '<span class="live-tag" title="Live price from Kite">LIVE</span>' : ''}</td>
      <td class="${chgCls}">${signed(r.change_pct, 2)}</td>
      <td>${num(r.rsi)}</td>
      <td class="${v2 > 0 ? 'up' : v2 < 0 ? 'down' : ''}">${signed(v2)}</td>
      <td>${signed(r.pct_from_high)}<span class="sub">${r.high52 == null ? '' : 'high ' + inr(r.high52)}</span></td>
      <td>${r.vol_ratio == null ? '<span class="na">—</span>' : num(r.vol_ratio) + '×'}</td>
      <td>${fundCell(r, f.pe == null ? null : num(f.pe))}</td>
      <td>${fundCell(r, f.pb == null ? null : num(f.pb))}</td>
      <td>${fundCell(r, f.roe == null ? null : num(f.roe) + '%')}</td>
      <td>${fundCell(r, f.de == null ? null : num(f.de, 2))}</td>
      <td>${fundCell(r, f.mcap == null ? null : num(f.mcap / 1e7, 0))}</td>
    </tr>`;
  }

  function frameItem(r, e, pinned) {
    const chg = r.change_pct;
    return `<li class="fi" data-ysym="${esc(r.ysym)}">
      <div class="fi-top">
        ${sigHTML(e)}<span class="score">${signedInt(e.score)}</span>
        <span class="fi-name">${symLink(r)}<span class="co">${esc(r.name)}</span>${capChip(r)}${pinned ? pinnedExtra(r) : ''}</span>
        <span class="fi-price">${inr(r.price)} <span class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${signed(chg, 2)}</span></span>
      </div>
      <div class="tags">${e.tags.map(tagHTML).join('')}</div>
    </li>`;
  }

  /** Two frames: stocks to buy (strongest first) and stocks to sell (weakest first). */
  function renderSplit(items, loading) {
    const mcap = (x) => (x.r.fund && x.r.fund.mcap) || 0;
    const side = (dir) => {
      const [strong, normal] = dir > 0 ? ['strongbuy', 'buy'] : ['strongsell', 'sell'];
      const all = items.filter(({ e }) => e.level === strong || e.level === normal);
      const nStrong = all.filter(({ e }) => e.level === strong).length;
      const list = state.strongOnly[dir > 0 ? 'buy' : 'sell'] ? all.filter(({ e }) => e.level === strong) : all;
      list.sort((a, b) => dir * (b.e.score - a.e.score) || (b.e.tags.length - a.e.tags.length) || (mcap(b) - mcap(a)));
      return { all, list, nStrong };
    };
    const bones = '<li><span class="bone"></span><span class="bone" style="width:70%"></span><span class="bone" style="width:80%"></span></li>';
    for (const [dir, id, word] of [[1, 'buy', 'Buy'], [-1, 'sell', 'Sell']]) {
      const X = side(dir);
      $(`#${id}Count`).textContent = loading ? '' : `(${X.list.length})`;
      $(`#${id}Sub`).textContent = loading ? 'Loading…' : `${X.nStrong} Strong ${word} · ${X.all.length - X.nStrong} ${word}`;
      $(`#${id}List`).innerHTML = loading ? bones
        : X.list.length ? X.list.map(({ r, e }) => frameItem(r, e, !state.stocks.has(r.ysym))).join('')
        : `<li class="frame-empty">No stocks with a${dir > 0 ? ' buy' : ' sell'} signal match your filters.</li>`;
    }
  }

  const skeletonRows = (n) => Array.from({ length: n }, () =>
    `<tr class="skeleton">${COLUMNS.map((c, i) => `<td><span class="bone" style="width:${i === 0 ? 70 : 60}%"></span></td>`).join('')}</tr>`
  ).join('');

  // ------------------------------------------------------------ sorting
  function matchesQuery(r, q) {
    q = q.toLowerCase();
    return r.symbol.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q);
  }

  function comparator() {
    const { key, dir } = state.sort;
    const col = COLUMNS.find((c) => c.key === key);
    const mcap = (x) => (x.r.fund && x.r.fund.mcap) || 0;
    return (a, b) => {
      const va = col.value(a.r, a.e), vb = col.value(b.r, b.e);
      if (va == null && vb == null) return mcap(b) - mcap(a);
      if (va == null) return 1;   // missing values always last
      if (vb == null) return -1;
      const primary = col.text ? dir * String(va).localeCompare(String(vb)) : dir * (va - vb);
      if (primary) return primary;
      if (key === 'signal') return (b.e.tags.length - a.e.tags.length) || (mcap(b) - mcap(a));
      return mcap(b) - mcap(a);
    };
  }

  // ------------------------------------------------------------ render
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; renderNow(); }, 0);
  }

  function evalAll(records) {
    return records.map((r0) => {
      const r = withLive(r0);
      const e = evaluate(r, state.rules);
      e.pendingFund = r.fund_status === 'pending';
      e.pendingTf = r.price != null && (r.tf !== state.tf || r.tf_status === 'pending');
      return { r, e };
    });
  }

  function renderNow() {
    hideTooltip();
    const all = evalAll([...state.stocks.values()].filter(capPasses));
    const pins = evalAll([...state.lookups.values()].filter((r) => !state.stocks.has(r.ysym)));

    renderStatus();
    renderSignalTiles(all);
    renderCards(all);
    renderFilterState();

    const q = state.query;
    const rows = all.filter(({ r, e }) => (q ? matchesQuery(r, q) : passesFilters(e)));
    rows.sort(comparator());
    const pinRows = q ? pins.filter(({ r }) => matchesQuery(r, q)) : pins;

    const tbody = $('#rows');
    const empty = $('#empty');
    const loading = state.scan && state.scan.state === 'running' && state.stocks.size === 0;
    const pinHTML = pinRows.map(({ r, e }) => rowHTML(r, e, true)).join('');

    if (loading) {
      tbody.innerHTML = pinHTML + skeletonRows(8);
      empty.hidden = true;
    } else {
      tbody.innerHTML = pinHTML + rows.map(({ r, e }) => rowHTML(r, e, false)).join('');
      const nothing = rows.length + pinRows.length === 0 && state.scan && state.scan.state !== 'error';
      empty.hidden = !nothing;
      if (nothing) {
        const label = esc((state.scan && state.scan.label) || 'this index');
        empty.innerHTML = q
          ? `<strong>No stock in ${label} matches “${esc(q)}”</strong>Press Enter to look it up on NSE, or pick a suggestion.`
          : `<strong>No stocks match these filters</strong>Try “Any can match”, loosen the rules, clear a filter, or switch the index to Large + Mid caps.`;
      }
    }

    const total = all.length;
    const capText = { largemid: 'large & mid cap', large: 'large cap', mid: 'mid cap', small: 'small cap', all: 'large, mid & small cap' }[state.filters.cap] || '';
    let text = '';
    if (q) text = `${rows.length + pinRows.length} result${rows.length + pinRows.length === 1 ? '' : 's'} for “${q}”. Filters are paused while searching.`;
    else if (total) text = filtersActive() ? `${rows.length} of ${total} ${capText} stocks match your filters` : `Showing all ${total} ${capText} stocks`;
    $('#count').textContent = text;

    const view = q ? 'table' : state.view;
    $('#splitView').hidden = view !== 'split';
    $('#watchView').hidden = view !== 'watch';
    $('#tableView').hidden = view !== 'table';
    document.querySelectorAll('#viewSwitch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('#viewNote').textContent = q ? 'Search results are shown in the full table.'
      : view === 'split' ? 'Hold stocks appear only in the full table.' : '';
    if (view === 'split') renderSplit([...pinRows, ...rows], loading);
    if (view === 'watch') renderWatch(rows, loading);

    if (state.flash) {
      const tr = tbody.querySelector(`tr[data-ysym="${CSS.escape(state.flash)}"]`);
      if (tr) {
        tr.classList.add('flash');
        tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      state.flash = null;
    }
  }

  function renderSignalTiles(all) {
    const counts = Object.fromEntries(LEVELS.map((l) => [l.key, 0]));
    for (const { e } of all) if (e.level) counts[e.level]++;
    const total = all.filter(({ e }) => e.level).length;
    const R = state.rules;
    $('#signalHint').textContent = `Each strategy adds +1 for a buy and −1 for a sell (fresh golden / death cross ±2). `
      + `Score ≥ ${R.strongAt} is Strong Buy, ≤ −${R.strongAt} Strong Sell. Click a tile to filter.`;
    $('#signalTiles').innerHTML = LEVELS.map((l) => `
      <button type="button" class="sig-tile t-${l.key}" data-signal="${l.key}" aria-pressed="${state.filters.signal === l.key}">
        <span class="lbl"><span aria-hidden="true">${l.icon}</span>${esc(l.label)}</span>
        <span class="num">${total ? counts[l.key] : '–'}<small>${total ? `of ${total}` : ''}</small></span>
      </button>`).join('');
  }

  function renderCards(all) {
    const R = state.rules;
    const c = {};
    for (const s of STRATEGIES) c[s.key] = { buy: 0, sell: 0, gc: 0, dc: 0 };
    for (const { e } of all) {
      for (const t of e.tags) {
        c[t.key][t.dir > 0 ? 'buy' : 'sell']++;
        if (t.sub === 'gc') c.ma.gc++;
        if (t.sub === 'dc') c.ma.dc++;
      }
    }
    const pendingFund = all.filter(({ e }) => e.pendingFund).length;
    const pendingTf = all.filter(({ e }) => e.pendingTf).length;
    const has = all.length > 0;
    const F = state.filters;
    const T = tfMeta();

    $('#strategyCards').innerHTML = STRATEGIES.map((s) => {
      const n = c[s.key];
      const btn = (side, count, label) => {
        const pressed = F[s.key] === side;
        return `<button type="button" class="count-btn ${side}" data-strat="${s.key}" data-side="${side}" aria-pressed="${pressed}"
          aria-label="${esc(`${s.short}: ${count} ${label}. ${pressed ? 'Remove filter' : 'Filter to these'}`)}">
          ${side === 'buy' ? UP : DOWN}<b>${has ? count : '–'}</b><span class="lbl">${label}</span></button>`;
      };
      let split = '';
      if (s.key === 'ma') split = `${n.gc} fresh golden cross${n.gc === 1 ? '' : 'es'} · ${n.dc} fresh death cross${n.dc === 1 ? '' : 'es'}`;
      if (s.key === 'value' && pendingFund) split = `Loading fundamentals for ${pendingFund} stocks…`;
      if (s.usesTf && pendingTf) split = `Loading ${T.label.toLowerCase()} candles for ${pendingTf} stocks…`;
      return `<div class="card${F[s.key] !== 'any' ? ' active' : ''}" style="--c:${s.color}">
        <span class="card-name">${esc(s.name)}${s.usesTf ? ` <span class="tf-chip">${esc(T.label)}</span>` : ''}</span>
        <div class="card-counts">${btn('buy', n.buy, s.sell ? 'buy' : 'pass')}${s.sell ? btn('sell', n.sell, 'sell') : ''}</div>
        ${split ? `<span class="card-split">${esc(split)}</span>` : ''}
        <p class="card-rule">${UP}${esc(s.buy(R, T))}</p>
        ${s.sell ? `<p class="card-rule">${DOWN}${esc(s.sell(R, T))}</p>` : '<p class="card-rule">No sell side: failing the value screen is not a sell signal.</p>'}
      </div>`;
    }).join('');
  }

  function renderFilters() {
    $('#filterRow').innerHTML = FILTERS.map((f) => `
      <label class="filter" data-filter-wrap="${f.key}">
        <span>${f.color ? `<i class="dot" style="--c:${f.color}"></i>` : ''}${esc(f.label)}</span>
        <select data-filter="${f.key}">${f.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      </label>`).join('');
    renderFilterState();
  }

  function renderFilterState() {
    for (const f of FILTERS) {
      const sel = document.querySelector(`select[data-filter="${f.key}"]`);
      if (!sel) continue;
      if (sel.value !== state.filters[f.key]) sel.value = state.filters[f.key];
      sel.closest('.filter').classList.toggle('on', state.filters[f.key] !== defaultFilters()[f.key]);
    }
    document.querySelectorAll('#modeGroup button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    $('#clearFilters').hidden = !filtersActive();
  }

  function setFilter(key, value) {
    state.filters[key] = value;
    store.set('filters', state.filters);
    render();
  }

  function renderStatus() {
    const el = $('#status');
    const s = state.scan;
    $('#refresh').disabled = !s || s.state === 'running';
    if (!s) { el.textContent = 'Starting…'; return; }
    if (s.state === 'running') {
      const step = s.steps && s.step ? `Step ${s.step} of ${s.steps}: ${s.phase.toLowerCase()}` : s.phase;
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      el.innerHTML = `${esc(s.label)}: ${esc(step)}${s.total ? ` (${s.done} of ${s.total})` : ''}…`
        + `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
    } else if (s.state === 'error') {
      el.innerHTML = `<div class="err"><span>Couldn’t load ${esc(s.label || 'data')}: ${esc(s.error)}</span><button type="button" data-act="retry">Try again</button></div>`;
    } else {
      const recs = [...state.stocks.values()];
      const asOf = recs.map((r) => r.as_of).filter(Boolean).sort().pop();
      const missing = recs.filter((r) => r.error).length;
      const time = s.finished ? new Date(s.finished).toLocaleString('en-IN', STATIC.on
        ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' }) : '';
      el.textContent = `${s.label}: ${s.count} stocks, updated ${time}`
        + (asOf ? ` (latest session ${fmtDate(asOf)})` : '')
        + (missing ? `. ${missing} without price data.` : '.')
        + (STATIC.on ? ' Data refreshes about every 15 minutes during market hours.' : '')
        + (live.on && live.lastUpdate ? ` Live prices from Kite, last update ${new Date(live.lastUpdate).toLocaleTimeString('en-IN')}.` : '');
    }
  }

  // ------------------------------------------------------------ Zerodha Kite live prices (owner's Mac only)
  const live = { on: false, version: -1, quotes: {}, timer: null, status: null, lastUpdate: null };

  const lastSet = (arr, v) => { const a = arr.slice(); a[a.length - 1] = v; return a; };
  function patchCandles(t, ltp) {
    if (!t || !t.c || !t.c.length || ltp == null) return t;
    const n = t.c.length;
    return { ...t, c: lastSet(t.c, ltp), h: lastSet(t.h, Math.max(t.h[n - 1] ?? ltp, ltp)), l: lastSet(t.l, Math.min(t.l[n - 1] ?? ltp, ltp)) };
  }

  function rsiOf(closes, period = 14) {
    const v = closes.filter((x) => x != null);
    if (v.length <= period + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= period; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= period; l /= period;
    for (let i = period + 1; i < v.length; i++) {
      const d = v[i] - v[i - 1];
      g = (g * (period - 1) + Math.max(d, 0)) / period;
      l = (l * (period - 1) + Math.max(-d, 0)) / period;
    }
    return l === 0 ? 100 : Math.round((100 - 100 / (1 + g / l)) * 10) / 10;
  }

  /** The record with Kite's live price folded into every price-based number. */
  function withLive(r) {
    const q = live.on && live.quotes[r.symbol];
    if (!q || q.ltp == null || r.price == null) return r;
    const ltp = q.ltp;
    const out = { ...r, price: ltp, live: true };
    if (q.change_pct != null) out.change_pct = q.change_pct;
    if (r.high52 != null) { out.high52 = Math.max(r.high52, q.high ?? ltp, ltp); out.pct_from_high = (ltp / out.high52 - 1) * 100; }
    if (r.low52 != null) { out.low52 = Math.min(r.low52, q.low ?? ltp, ltp); out.pct_from_low = (ltp / out.low52 - 1) * 100; }
    if (r.spark && r.spark.c && r.spark.c.length) {
      const c = lastSet(r.spark.c, ltp);
      out.spark = { ...r.spark, c };
      const rv = rsiOf(c);
      if (rv != null) out.rsi = rv;
    }
    if (r.tfd) out.tfd = patchCandles(r.tfd, ltp);
    return out;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 7000);
  }

  function renderKiteBtn() {
    const b = $('#kiteBtn');
    const s = live.status;
    if (STATIC.on || !s || !s.local) { b.hidden = true; return; }
    b.hidden = false;
    let text = 'Kite connecting…', on = false;
    if (!s.available) text = 'Kite unavailable';
    else if (!s.configured) text = 'Connect Kite';
    else if (!s.logged_in) text = 'Log in to Kite';
    else if (s.streaming || live.lastUpdate) { text = 'Kite live'; on = true; }
    b.classList.toggle('on', on);
    b.innerHTML = `<span class="dot" aria-hidden="true"></span>${esc(text)}`;
    b.title = s.logged_in ? `Live prices from Kite (${s.user}). Session ends ${new Date(s.expires).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`
      : 'Show live prices from your Zerodha Kite Connect account';
  }

  async function pollLive() {
    clearTimeout(live.timer);
    if (!live.on) return;
    try {
      const res = await api('/api/live', { method: 'POST', body: JSON.stringify({
        universe: state.universe, extra: [...state.lookups.values()].map((r) => r.symbol), since: live.version }) });
      live.status = { ...live.status, ...res, local: true };
      const n = Object.keys(res.quotes || {}).length;
      Object.assign(live.quotes, res.quotes || {});
      live.version = res.version;
      if (n) live.lastUpdate = Date.now();
      if (!res.logged_in) { live.on = false; toast('Your Kite session has ended. Log in to Kite again for live prices.'); }
      renderKiteBtn();
      if (n) render();
    } catch (e) {
      live.status = { ...(live.status || {}), error: e.message };
      renderKiteBtn();
    }
    if (live.on) live.timer = setTimeout(pollLive, 2000);
  }

  async function kiteInit() {
    if (STATIC.on) return;
    try { live.status = await api('/api/kite/status'); } catch (e) { return; }
    renderKiteBtn();
    const p = new URLSearchParams(location.search).get('kite');
    if (p) {
      toast({ connected: 'Kite connected: prices are now live.', failed: 'Kite login failed. Check your API key and secret, then try again.',
        cancelled: 'Kite login was cancelled.', setup: 'Add your Kite API key and secret first.' }[p] || '');
      history.replaceState(null, '', location.pathname);
      if (p === 'setup') openKiteDialog();
    }
    if (live.status.logged_in && live.status.available) { live.on = true; live.version = -1; pollLive(); }
  }

  const kiteDialog = $('#kiteDialog');
  function openKiteDialog(forceSetup = false) {
    const s = live.status || {};
    const info = s.logged_in && !forceSetup;
    $('#kiteSetup').hidden = info;
    $('#kiteInfo').hidden = !info;
    $('#kiteMsg').textContent = s.available === false ? 'Live streaming needs the websocket-client package: run  .venv/bin/python -m pip install -r requirements.txt' : '';
    if (info) {
      $('#kiteInfoText').textContent = `Logged in to Kite as ${s.user}. Prices and signals update live every 2 seconds `
        + `until the session ends at ${new Date(s.expires).toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (Kite asks for a fresh login each day).`
        + (s.error ? ` Last message from Kite: ${s.error}` : '');
    }
    kiteDialog.showModal();
  }

  $('#kiteBtn').addEventListener('click', () => {
    const s = live.status || {};
    if (s.configured && !s.logged_in) { location.href = 'kite/login'; return; }
    openKiteDialog();
  });
  kiteDialog.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) kiteDialog.close(); });
  $('#kiteChangeKeys').addEventListener('click', () => openKiteDialog(true));
  $('#kiteSetup').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#kiteMsg').textContent = '';
    try {
      const res = await api('/api/kite/config', { method: 'POST', body: JSON.stringify({ api_key: $('#kiteKey').value, api_secret: $('#kiteSecret').value }) });
      $('#kiteSecret').value = '';
      location.href = res.login_url.replace(/^\//, '');
    } catch (err) {
      $('#kiteMsg').textContent = err.message;
    }
  });
  $('#kiteLogout').addEventListener('click', async () => {
    try { await api('/api/kite/logout', { method: 'POST' }); } catch (e) { /* already logged out */ }
    live.on = false;
    live.quotes = {};
    live.lastUpdate = null;
    live.status = await api('/api/kite/status').catch(() => live.status);
    kiteDialog.close();
    renderKiteBtn();
    render();
    toast('Logged out of Kite. Prices are back to the regular data feed.');
  });

  // ------------------------------------------------------------ breakout watch
  const WATCH_ALL = ['15m', '1h', '1d', '1wk'];
  const watch = { data: {}, loading: new Set(), key: '' };
  const tfInfo = (id) => state.timeframes.find((t) => t.id === id) || { id, label: id, short: id };

  async function loadCandles(tf) {
    if (STATIC.on) {
      await staticLoad(false);
      if (tf === '1d') return Object.fromEntries(Object.entries(STATIC.stocks).filter(([, r]) => r.tfd).map(([sym, r]) => [sym, r.tfd]));
      if (!STATIC.tf[tf]) STATIC.tf[tf] = await getJSON(`data/tf-${tf}.json?v=${encodeURIComponent(STATIC.meta.updated)}`);
      return STATIC.tf[tf];
    }
    return api(`/api/candles?universe=${encodeURIComponent(state.universe)}&tf=${encodeURIComponent(tf)}`);
  }

  function ensureWatchData() {
    const key = STATIC.on ? 'static' : state.universe;
    if (watch.key !== key) { watch.data = {}; watch.key = key; }
    for (const tf of state.watchTfs) {
      if (watch.data[tf] || watch.loading.has(tf)) continue;
      watch.loading.add(tf);
      loadCandles(tf)
        .then((m) => { if (watch.key === key) watch.data[tf] = m || {}; })
        .catch(() => { if (watch.key === key) watch.data[tf] = {}; })
        .finally(() => { watch.loading.delete(tf); render(); });
    }
  }

  /** A stock "in a range" whose price is near the top (dir +1) or bottom (dir -1) of it. */
  function rangeSetup(t, R) {
    if (!t || !t.c) return null;
    const { h, l, c } = t;
    const n = c.length;
    const N = clamp(R.rangeLookback, 5, Math.floor((n - 1) / 2));
    const win = (end) => {
      let hi = -Infinity, lo = Infinity;
      for (let j = end - N; j < end; j++) {
        if (h[j] == null || l[j] == null) return null;
        if (h[j] > hi) hi = h[j];
        if (l[j] < lo) lo = l[j];
      }
      return { hi, lo };
    };
    const cur = win(n - 1);
    const price = c[n - 1];
    if (!cur || price == null || cur.lo <= 0 || cur.hi <= cur.lo) return null;
    if (price > cur.hi || price < cur.lo) return null;            // already broken out / down
    const widths = [];
    for (let i = N; i <= n - 1 - N; i++) { const w = win(i); if (w) widths.push((w.hi - w.lo) / w.lo); }
    if (widths.length < 3) return null;
    widths.sort((a, b) => a - b);
    const width = (cur.hi - cur.lo) / cur.lo;
    const ratio = width / widths[Math.floor(widths.length / 2)];
    if (ratio > R.squeezeRatio) return null;                      // not tighter than usual
    const pos = (price - cur.lo) / (cur.hi - cur.lo);
    const edge = R.nearEdge / 100;
    const base = { hi: cur.hi, lo: cur.lo, width: width * 100, ratio, price, last: t.last, N };
    if (pos >= 1 - edge) return { ...base, dir: 1, dist: (cur.hi - price) / price * 100 };
    if (pos <= edge) return { ...base, dir: -1, dist: (price - cur.lo) / price * 100 };
    return null;
  }

  function watchItem(it, dir) {
    const r = it.r;
    const chg = r.change_pct;
    const chips = it.hits.map((x) => {
      const T = tfInfo(x.tf);
      const tip = `${T.label} chart: the last ${x.N} candles traded between ${inr(x.lo)} and ${inr(x.hi)} `
        + `(${num(x.width)}% wide, ${num(x.ratio * 100, 0)}% of its usual width). Price ${inr(x.price)} is ${num(x.dist, 2)}% `
        + (dir > 0 ? `below the top: a close above ${inr(x.hi)} would be a breakout.` : `above the bottom: a close below ${inr(x.lo)} would be a breakdown.`)
        + ` As of ${x.last}.`;
      return `<span class="tag" tabindex="0" style="--c:var(--s6)" data-tip="${esc(tip)}">${dir > 0 ? UP : DOWN}<b>${esc(T.short)}</b>&nbsp;${num(x.dist, 2)}% to ${dir > 0 ? inr(x.hi) : inr(x.lo)}</span>`;
    }).join('');
    return `<li class="fi" data-ysym="${esc(r.ysym)}">
      <div class="fi-top">
        <span class="fi-name">${symLink(r)}<span class="co">${esc(r.name)}</span>${capChip(r)}</span>
        ${it.e.level ? sigHTML(it.e) : ''}
        <span class="fi-price">${inr(r.price)} <span class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${signed(chg, 2)}</span></span>
      </div>
      <div class="tags">${chips}</div>
    </li>`;
  }

  function renderWatch(items, loading) {
    state.watchTfs = state.watchTfs.filter((tf) => WATCH_ALL.includes(tf));
    if (!state.watchTfs.length) state.watchTfs = [...WATCH_ALL];
    ensureWatchData();
    const R = state.rules;
    $('#watchTfs').innerHTML = WATCH_ALL.map((tf) =>
      `<button type="button" data-tf="${tf}" aria-pressed="${state.watchTfs.includes(tf)}">${esc(tfInfo(tf).label)}</button>`).join('');
    const pending = state.watchTfs.filter((tf) => !watch.data[tf]);
    $('#watchNote').textContent = pending.length
      ? `Loading ${pending.map((tf) => tfInfo(tf).label.toLowerCase()).join(', ')} candles…`
      : `Range = the last ${R.rangeLookback} candles; tight = at most ${Math.round(R.squeezeRatio * 100)}% of its usual width; near = in the top or bottom ${R.nearEdge}% of the range.`;
    const up = [], down = [];
    for (const it of items) {
      const hits = [];
      for (const tf of state.watchTfs) {
        const raw = watch.data[tf] && watch.data[tf][it.r.symbol];
        const q = live.on && live.quotes[it.r.symbol];
        const setup = rangeSetup(q && raw ? patchCandles(raw, q.ltp) : raw, R);
        if (setup) hits.push({ tf, ...setup });
      }
      for (const [dir, list] of [[1, up], [-1, down]]) {
        const mine = hits.filter((x) => x.dir === dir);
        if (mine.length) list.push({ ...it, hits: mine, best: Math.min(...mine.map((x) => x.dist)) });
      }
    }
    const order = (a, b) => b.hits.length - a.hits.length || a.best - b.best;
    const busy = loading || (pending.length === state.watchTfs.length);
    const bones = '<li><span class="bone"></span><span class="bone" style="width:70%"></span><span class="bone" style="width:80%"></span></li>';
    for (const [id, list, dir, word] of [['up', up, 1, 'breakout'], ['down', down, -1, 'breakdown']]) {
      list.sort(order);
      $(`#${id}Count`).textContent = busy ? '' : `(${list.length})`;
      $(`#${id}List`).innerHTML = busy ? bones
        : list.length ? list.map((it) => watchItem(it, dir)).join('')
        : `<li class="frame-empty">No stock is in a tight range near its ${dir > 0 ? 'top' : 'bottom'} on these timeframes. Loosen the Breakout watch rules or add timeframes.</li>`;
    }
  }

  $('#watchTfs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tf]');
    if (!b) return;
    const tf = b.dataset.tf;
    const on = state.watchTfs.includes(tf);
    if (on && state.watchTfs.length === 1) return;               // keep at least one timeframe
    state.watchTfs = on ? state.watchTfs.filter((x) => x !== tf) : WATCH_ALL.filter((x) => x === tf || state.watchTfs.includes(x));
    store.set('watchTfs', state.watchTfs);
    render();
  });

  // ------------------------------------------------------------ scanning
  async function startScan(force = false) {
    clearTimeout(state.pollTimer);
    const token = ++state.pollToken;
    if (force) watch.data = {};
    if (STATIC.on) return staticScan(token, force);
    try {
      const meta = await api('/api/scan', { method: 'POST', body: JSON.stringify({ universe: state.universe, tf: state.tf, force }) });
      if (token !== state.pollToken) return;
      if (meta.id !== state.scanId) { state.scanId = meta.id; state.version = -1; }
      state.scan = meta;
      render();
      poll(token);
    } catch (e) {
      state.scan = { state: 'error', error: e.message, label: universeLabel() };
      render();
    }
  }

  async function poll(token) {
    if (token !== state.pollToken) return;
    try {
      const snap = await api(`/api/scan/${encodeURIComponent(state.universe)}?tf=${encodeURIComponent(state.tf)}&since=${state.version}`);
      if (token !== state.pollToken) return;
      if (snap.id !== state.scanId) {          // a new scan replaced ours; fetch it from scratch
        state.scanId = snap.id; state.version = -1;
        state.pollTimer = setTimeout(() => poll(token), 0);
        return;
      }
      for (const r of snap.stocks) state.stocks.set(r.ysym, r);
      state.version = snap.version;
      delete snap.stocks;
      state.scan = snap;
      render();
      if (snap.state === 'running') state.pollTimer = setTimeout(() => poll(token), 900);
    } catch (e) {
      if (token !== state.pollToken) return;
      state.scan = { state: 'error', error: e.message, label: universeLabel() };
      render();
    }
  }

  const universeLabel = () => (state.universes.find((u) => u.id === state.universe) || {}).label || state.universe;

  // ------------------------------------------------------------ search
  const search = $('#search');
  const list = $('#suggestions');
  let suggestions = [];
  let active = -1;
  let suggestTimer = null;
  let suggestSeq = 0;

  function openList(html) {
    list.innerHTML = html;
    list.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  }
  function closeList() {
    list.hidden = true;
    active = -1;
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
  }

  function renderSuggestions() {
    if (!suggestions.length) { closeList(); return; }
    openList(suggestions.map((s, i) => {
      const inIndex = state.stocks.has(s.symbol + '.NS');
      return `<li id="sug-${i}" role="option" data-i="${i}" aria-selected="${i === active}">
        <span class="sym">${esc(s.symbol)}</span><span class="nm">${esc(s.name)}</span>
        <span class="where">${inIndex ? 'In ' + esc(universeLabel()) : 'Look up'}</span></li>`;
    }).join(''));
    if (active >= 0) search.setAttribute('aria-activedescendant', `sug-${active}`);
  }

  async function fetchSuggestions(q) {
    const seq = ++suggestSeq;
    try {
      const res = STATIC.on ? staticSuggest(q) : await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (seq !== suggestSeq || search.value.trim() !== q) return;
      suggestions = res;
      active = -1;
      renderSuggestions();
    } catch (e) { /* suggestions are optional */ }
  }

  function choose(s) {
    closeList();
    const ysym = s.symbol + '.NS';
    if (state.stocks.has(ysym)) {
      search.value = s.symbol;
      state.query = s.symbol;
      state.flash = ysym;
      render();
    } else {
      lookup(s.symbol);
    }
  }

  async function lookup(q) {
    openList(`<li class="msg" aria-disabled="true">Looking up “${esc(q)}” on NSE…</li>`);
    try {
      const rec = await lookupRecord(q);
      closeList();
      if (state.stocks.has(rec.ysym)) {
        search.value = rec.symbol;
        state.query = rec.symbol;
      } else {
        state.lookups.set(rec.ysym, rec);
        saveLookups();
        search.value = '';
        state.query = '';
        state.view = 'table';
        store.set('view', state.view);
      }
      state.flash = rec.ysym;
      render();
    } catch (e) {
      openList(`<li class="msg" aria-disabled="true">${esc(e.message)}</li>`);
    }
  }

  const saveLookups = () => store.set('lookups', [...state.lookups.keys()]);

  async function restoreLookups() {
    for (const ysym of store.get('lookups', [])) {
      try {
        const rec = await lookupRecord(ysym);
        state.lookups.set(rec.ysym, rec);
        render();
      } catch (e) { /* dropped silently; it will not be saved again */ }
    }
    saveLookups();
  }

  search.addEventListener('input', () => {
    const q = search.value.trim();
    state.query = q;
    render();
    clearTimeout(suggestTimer);
    if (!q) { suggestions = []; closeList(); return; }
    suggestTimer = setTimeout(() => fetchSuggestions(q), 120);
  });

  search.addEventListener('keydown', (e) => {
    const open = !list.hidden && suggestions.length;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault(); active = (active + 1) % suggestions.length; renderSuggestions();
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault(); active = (active - 1 + suggestions.length) % suggestions.length; renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = search.value.trim();
      if (!q) return;
      if (open && active >= 0) { choose(suggestions[active]); return; }
      const exact = suggestions.find((s) => s.symbol.toLowerCase() === q.toLowerCase());
      if (exact) { choose(exact); return; }
      const inTable = [...state.stocks.values()].some((r) => matchesQuery(r, q));
      if (inTable) { closeList(); return; }
      lookup(q);
    } else if (e.key === 'Escape') {
      if (!list.hidden) closeList();
      else { search.value = ''; state.query = ''; render(); }
    }
  });

  list.addEventListener('mousedown', (e) => e.preventDefault());  // keep focus in the input
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) choose(suggestions[Number(li.dataset.i)]);
  });
  search.addEventListener('blur', () => setTimeout(closeList, 100));
  search.addEventListener('focus', () => { if (search.value.trim() && suggestions.length) renderSuggestions(); });

  // ------------------------------------------------------------ tooltip (tags, signals, sparklines)
  const tip = $('#tooltip');
  let activeSpark = null;

  function showTooltip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 8, w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 16;
    if (left + w > window.innerWidth - pad) left = x - w - 14;
    if (top + h > window.innerHeight - pad) top = y - h - 12;
    tip.style.left = Math.max(pad, left) + 'px';
    tip.style.top = Math.max(pad, top) + 'px';
  }
  function hideTooltip() {
    tip.hidden = true;
    if (activeSpark) {
      activeSpark.querySelectorAll('.xh, .dot').forEach((n) => n.remove());
      activeSpark = null;
    }
  }

  function findRecord(ysym) { return state.stocks.get(ysym) || state.lookups.get(ysym); }

  function sparkHover(svg, e) {
    const r = findRecord(svg.dataset.ysym);
    const c = r && r.spark && r.spark.c;
    if (!c) return;
    const box = svg.getBoundingClientRect();
    const g = sparkGeom(c);
    const px = ((e.clientX - box.left) / box.width) * SPARK.W;
    const i = Math.max(0, Math.min(c.length - 1, Math.round((px - SPARK.P) / g.step)));
    if (c[i] == null) return;
    if (activeSpark && activeSpark !== svg) hideTooltip();
    activeSpark = svg;
    const NS = 'http://www.w3.org/2000/svg';
    let xh = svg.querySelector('.xh'), dot = svg.querySelector('.dot');
    if (!xh) { xh = document.createElementNS(NS, 'line'); xh.setAttribute('class', 'xh'); svg.insertBefore(xh, svg.firstChild); }
    if (!dot) { dot = document.createElementNS(NS, 'circle'); dot.setAttribute('class', 'dot'); dot.setAttribute('r', '3'); svg.appendChild(dot); }
    const x = g.x(i).toFixed(1);
    xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('y1', 0); xh.setAttribute('y2', SPARK.H);
    dot.setAttribute('cx', x); dot.setAttribute('cy', g.y(c[i]).toFixed(1));
    const sinceStart = pctDiff(c[c.length - 1], c[0]);
    showTooltip(`<b>${inr(c[i])}</b> · ${esc(fmtDate(r.spark.d[i]))}<br>6-month change ${esc(signed(sinceStart))}`, e.clientX, e.clientY);
  }

  for (const rowsEl of [$('#rows'), $('#splitView'), $('#watchView')]) {
    rowsEl.addEventListener('pointermove', (e) => {
      const svg = e.target.closest('.spark');
      if (svg) { sparkHover(svg, e); return; }
      const t = e.target.closest('[data-tip]');
      if (t) {
        if (activeSpark) hideTooltip();
        showTooltip(esc(t.dataset.tip), e.clientX, e.clientY);
        return;
      }
      if (!tip.hidden) hideTooltip();
    });
    rowsEl.addEventListener('pointerleave', hideTooltip);
    rowsEl.addEventListener('focusin', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) return;
      const b = t.getBoundingClientRect();
      showTooltip(esc(t.dataset.tip), b.left, b.bottom - 8);
    });
    rowsEl.addEventListener('focusout', hideTooltip);
    rowsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      state.lookups.delete(btn.dataset.remove);
      saveLookups();
      render();
    });
  }
  window.addEventListener('scroll', () => { if (!tip.hidden) hideTooltip(); }, { passive: true });
  document.querySelectorAll('.frame-list').forEach((el) => el.addEventListener('scroll', hideTooltip, { passive: true }));

  // ------------------------------------------------------------ controls
  $('#headRow').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const key = btn.dataset.sort;
    const col = COLUMNS.find((c) => c.key === key);
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: col.asc ? 1 : -1 };
    store.set('sort', state.sort);
    renderHead();
    render();
  });

  $('#signalTiles').addEventListener('click', (e) => {
    const t = e.target.closest('[data-signal]');
    if (!t) return;
    setFilter('signal', state.filters.signal === t.dataset.signal ? 'all' : t.dataset.signal);
  });

  $('#strategyCards').addEventListener('click', (e) => {
    const b = e.target.closest('[data-strat]');
    if (!b) return;
    const { strat, side } = b.dataset;
    setFilter(strat, state.filters[strat] === side ? 'any' : side);
  });

  $('#filterRow').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-filter]');
    if (!sel) return;
    if (sel.dataset.filter === 'cap') {
      const has = INDEX_CAPS[state.universe] || CAP_SETS.all;
      if (!CAP_SETS[sel.value].every((c) => has.includes(c))) {
        state.filters.cap = sel.value;
        switchUniverse(CAP_INDEX[sel.value]);
        return;
      }
    }
    setFilter(sel.dataset.filter, sel.value);
  });

  $('#viewSwitch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    store.set('view', state.view);
    if (state.query) { search.value = ''; state.query = ''; }
    render();
  });

  $('#splitView').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-strong]');
    if (!box) return;
    state.strongOnly[box.dataset.strong] = box.checked;
    store.set('strongOnly', state.strongOnly);
    render();
  });
  document.querySelectorAll('#splitView input[data-strong]').forEach((box) => { box.checked = !!state.strongOnly[box.dataset.strong]; });

  $('#modeGroup').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    state.mode = b.dataset.mode;
    store.set('mode', state.mode);
    render();
  });

  $('#clearFilters').addEventListener('click', () => {
    state.filters = defaultFilters();
    store.set('filters', state.filters);
    search.value = '';
    state.query = '';
    render();
  });

  $('#refresh').addEventListener('click', () => startScan(true));
  $('#status').addEventListener('click', (e) => { if (e.target.closest('[data-act="retry"]')) startScan(true); });

  const universeSel = $('#universe');
  universeSel.addEventListener('change', () => switchUniverse(universeSel.value));
  function switchUniverse(uid) {
    state.universe = uid;
    universeSel.value = uid;
    store.set('index', state.universe);
    live.version = -1;
    fitCapToIndex();
    store.set('filters', state.filters);
    state.stocks.clear();
    state.scan = null;
    state.scanId = null;
    state.version = -1;
    render();
    startScan(false);
  }

  const tfSel = $('#timeframe');
  tfSel.addEventListener('change', () => {
    state.tf = tfSel.value;
    store.set('tf', state.tf);
    state.scan = null;
    state.scanId = null;
    state.version = -1;
    render();
    startScan(false);
    restoreLookups();
  });

  // rules form
  function renderRulesForm() {
    $('#rulesForm').innerHTML = RULE_GROUPS.map((g) => `
      <fieldset>
        <legend><span class="tag" style="--c:${g.color}">${esc(g.name)}</span></legend>
        ${g.fields.map(([k, label, step]) => `
          <label>${esc(label)} <input type="number" inputmode="decimal" step="${step}" name="${k}" value="${state.rules[k]}"></label>`).join('')}
      </fieldset>`).join('')
      + '<div class="rules-actions"><button type="button" class="link-btn" id="resetRules">Reset to defaults</button></div>';
  }
  $('#rulesForm').addEventListener('input', (e) => {
    const input = e.target;
    const v = parseFloat(input.value);
    if (!input.name || !Number.isFinite(v)) return;
    state.rules[input.name] = v;
    store.set('rules', state.rules);
    render();
  });
  $('#rulesForm').addEventListener('click', (e) => {
    if (e.target.id !== 'resetRules') return;
    state.rules = Object.assign({}, DEFAULT_RULES);
    store.set('rules', state.rules);
    renderRulesForm();
    render();
  });

  // theme
  $('#themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  });

  // ------------------------------------------------------------ init
  async function init() {
    renderHead();
    renderFilters();
    renderRulesForm();
    render();
    try {
      if (await detectStatic()) {
        state.universes = STATIC.meta.universes.map(({ id, label }) => ({ id, label }));
        state.timeframes = STATIC.meta.timeframes;
      } else {
        [state.universes, state.timeframes] = await Promise.all([api('/api/universes'), api('/api/timeframes')]);
      }
    } catch (e) {
      state.scan = { state: 'error', error: e.message, label: 'index list' };
      render();
      return;
    }
    if (!state.universes.some((u) => u.id === state.universe)) state.universe = 'niftylargemidcap250';
    universeSel.innerHTML = state.universes.map((u) => `<option value="${esc(u.id)}">${esc(u.label)}</option>`).join('');
    universeSel.value = state.universe;
    fitCapToIndex();
    renderFilterState();
    if (!state.timeframes.some((t) => t.id === state.tf)) state.tf = '1d';
    tfSel.innerHTML = state.timeframes.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
    tfSel.value = state.tf;
    startScan(false);
    restoreLookups();
    kiteInit();
  }
  init();
})();
