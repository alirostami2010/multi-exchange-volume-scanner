/**
 * GATE.IO USDT PERPETUAL — LONG INITIATION HUNTER
 * ------------------------------------------------------------
 * Node.js 20+ | GitHub Actions | Telegram alerts only (no orders)
 *
 * Design goal:
 * Rank contracts by the strength of a NEW long-side opportunity,
 * preferably before the main expansion or at its first confirmation.
 *
 * The scoring engine is newly designed. It does not reuse the supplied
 * scanner's readiness/momentum/entry formulas or classification logic.
 *
 * Data principles:
 * - 1H candles scan the full active USDT perpetual universe.
 * - 15m/5m/4H candles and contract_stats deep-check a shortlist.
 * - Directional taker flow uses documented long_taker_size and
 *   short_taker_size fields when present. Missing fields stay missing.
 * - Public trades are used only for activity/turnover validation; their
 *   size sign is NOT assumed to mean buyer/seller aggressor.
 * - Order book is used for liquidity/spread quality, not as proof of buying.
 * - No claims of whale detection or guaranteed future price direction.
 *
 * Required secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * Optional: TOP_LIMIT=12, DEEP_CANDIDATES=70, CONCURRENCY=3,
 * MIN_REQUEST_INTERVAL_MS=260, MIN_DAILY_QUOTE_VOLUME=50000,
 * TELEGRAM_DISABLE=false, REQUEST_TIMEOUT_MS=15000
 */

import process from 'node:process';

// ----------------------------- CONFIG -----------------------------
const CFG = Object.freeze({
  BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',
  MAIN_INTERVAL: '1h',
  MAIN_LIMIT: 96,
  FAST_INTERVAL: '5m',
  FAST_LIMIT: 100,
  MID_INTERVAL: '15m',
  MID_LIMIT: 100,
  TREND_INTERVAL: '4h',
  TREND_LIMIT: 60,
  STATS_INTERVAL: '15m',
  STATS_LIMIT: 20,
  TRADES_LIMIT: 150,
  BOOK_LIMIT: 20,
  TOP_LIMIT: intEnv('TOP_LIMIT', 12, 1, 30),
  DEEP_CANDIDATES: intEnv('DEEP_CANDIDATES', 70, 20, 160),
  CONCURRENCY: intEnv('CONCURRENCY', 3, 1, 8),
  REQUEST_GAP_MS: intEnv('MIN_REQUEST_INTERVAL_MS', 260, 100, 2000),
  REQUEST_TIMEOUT_MS: intEnv('REQUEST_TIMEOUT_MS', 15000, 5000, 60000),
  RETRIES: 3,
  MIN_DAILY_QUOTE_VOLUME: numEnv('MIN_DAILY_QUOTE_VOLUME', 50000, 0, 1e12),
  MIN_MAIN_CANDLES: 60,
  MIN_DEEP_CANDLES: 45,
  MAX_SPREAD_PCT: 0.90,
  MAX_REPORT_LENGTH: 3900,
  TELEGRAM_DISABLED: String(process.env.TELEGRAM_DISABLE || 'false').toLowerCase() === 'true',
  BTC_CONTRACT: 'BTC_USDT',
});

function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function numEnv(name, fallback, min, max) {
  const n = Number(process.env[name] ?? '');
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
const n = x => {
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : 0;
const median = xs => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, b) => a > 0 && Number.isFinite(b) ? (b / a - 1) * 100 : 0;
const safeDiv = (a, b, fallback = 0) => Math.abs(b) > 1e-12 ? a / b : fallback;
const round = (x, d = 1) => Number((Number.isFinite(x) ? x : 0).toFixed(d));
const signed = (x, d = 1) => `${x > 0 ? '+' : ''}${round(x, d)}`;
const fmt = x => {
  if (!Number.isFinite(x)) return '—';
  if (Math.abs(x) >= 1e9) return `${round(x / 1e9, 2)}B`;
  if (Math.abs(x) >= 1e6) return `${round(x / 1e6, 2)}M`;
  if (Math.abs(x) >= 1e3) return `${round(x / 1e3, 1)}K`;
  return String(round(x, 2));
};
const bar = x => '▰'.repeat(Math.round(clamp(x) / 10)) + '▱'.repeat(10 - Math.round(clamp(x) / 10));
const stamp = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

// -------------------------- HTTP / PACING --------------------------
let requestTail = Promise.resolve();
let lastStart = 0;
async function pace() {
  const task = async () => {
    const wait = CFG.REQUEST_GAP_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  };
  requestTail = requestTail.then(task, task);
  await requestTail;
}

async function getJSON(endpoint, params = {}) {
  const url = new URL(`${CFG.BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let lastError;
  for (let attempt = 0; attempt <= CFG.RETRIES; attempt++) {
    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Gate-Long-Initiation-Hunter/1.0' },
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${endpoint}: ${body.slice(0, 180)}`);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 600 * (attempt + 1));
          continue;
        }
        throw err;
      }
      try { return body ? JSON.parse(body) : null; }
      catch { throw new Error(`Invalid JSON from ${endpoint}`); }
    } catch (err) {
      lastError = err;
      if (attempt < CFG.RETRIES) await sleep(400 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Request failed: ${endpoint}`);
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (err) { out[i] = { error: err?.message || String(err) }; }
    }
  }));
  return out;
}

// ------------------------- DATA NORMALIZATION -------------------------
function normalizeCandle(row) {
  if (Array.isArray(row)) {
    const [time, volume, close, high, low, open, quote] = row;
    const c = { time: n(time), volume: n(volume), close: n(close), high: n(high), low: n(low), open: n(open), quoteVolume: n(quote) };
    return c;
  }
  if (!row || typeof row !== 'object') return null;
  const c = { time: n(row.t), volume: n(row.v), close: n(row.c), high: n(row.h), low: n(row.l), open: n(row.o), quoteVolume: n(row.sum) };
  return c;
}

const INTERVAL_SECONDS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
async function getCandles(contract, interval, limit) {
  const rows = await getJSON(`/futures/${CFG.SETTLE}/candlesticks`, { contract, interval, limit });
  if (!Array.isArray(rows)) return [];
  const step = INTERVAL_SECONDS[interval] || 3600;
  const now = Math.floor(Date.now() / 1000);
  return rows.map(normalizeCandle)
    .filter(x => x && x.time > 0 && x.open > 0 && x.close > 0 && x.high >= x.low && x.low > 0 && x.quoteVolume !== null)
    .filter(x => x.time + step <= now)
    .sort((a, b) => a.time - b.time);
}

function normalizeStat(x) {
  return {
    time: n(x?.time),
    oi: n(x?.open_interest),
    oiUsd: n(x?.open_interest_usd),
    longTaker: n(x?.long_taker_size),
    shortTaker: n(x?.short_taker_size),
    topPositionRatio: n(x?.top_lsr_size),
    topAccountRatio: n(x?.top_lsr_account),
    funding: null,
  };
}

function normalizeTrade(x) {
  const time = n(x?.create_time_ms ?? x?.create_time);
  return { time, id: String(x?.id ?? '') };
}

async function getDeep(contract) {
  const tasks = await Promise.allSettled([
    getCandles(contract, CFG.MID_INTERVAL, CFG.MID_LIMIT),
    getCandles(contract, CFG.FAST_INTERVAL, CFG.FAST_LIMIT),
    getCandles(contract, CFG.TREND_INTERVAL, CFG.TREND_LIMIT),
    getJSON(`/futures/${CFG.SETTLE}/contract_stats`, { contract, interval: CFG.STATS_INTERVAL, limit: CFG.STATS_LIMIT }),
    getJSON(`/futures/${CFG.SETTLE}/trades`, { contract, limit: CFG.TRADES_LIMIT }),
    getJSON(`/futures/${CFG.SETTLE}/order_book`, { contract, limit: CFG.BOOK_LIMIT, with_id: true }),
  ]);
  const val = i => tasks[i].status === 'fulfilled' ? tasks[i].value : null;
  return {
    mid: Array.isArray(val(0)) ? val(0) : [],
    fast: Array.isArray(val(1)) ? val(1) : [],
    trend: Array.isArray(val(2)) ? val(2) : [],
    stats: Array.isArray(val(3) ? val(3) : []).map(normalizeStat).filter(x => x.time !== null).sort((a, b) => a.time - b.time),
    trades: Array.isArray(val(4)) ? val(4).map(normalizeTrade) : [],
    book: val(5) && typeof val(5) === 'object' ? val(5) : null,
    errors: tasks.map((x, i) => x.status === 'rejected' ? ['15m', '5m', '4h', 'stats', 'trades', 'book'][i] : null).filter(Boolean),
  };
}

// ----------------------------- INDICATORS -----------------------------
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return mean(trs);
}

function candleFeatures(candles, interval = '1h') {
  if (!Array.isArray(candles) || candles.length < CFG.MIN_DEEP_CANDLES) return null;
  const last = candles.at(-1);
  const closes = candles.map(x => x.close);
  const vols = candles.map(x => x.quoteVolume);
  const ranges = candles.map(x => (x.high - x.low) / x.close * 100);
  const base = candles.slice(-25, -3);
  const recent3 = candles.slice(-3);
  const recent6 = candles.slice(-6);
  const prior20 = candles.slice(-21, -1);
  const priorHigh = Math.max(...prior20.map(x => x.high));
  const priorLow = Math.min(...prior20.map(x => x.low));
  const recentVol = mean(vols.slice(-3));
  const baselineVol = median(vols.slice(-27, -3));
  const recentRange = mean(ranges.slice(-6));
  const baselineRange = mean(ranges.slice(-30, -6));
  const a = atr(candles, 14);
  const e9 = ema(closes.slice(-40), 9);
  const e21 = ema(closes.slice(-60), 21);
  const lows = candles.slice(-8).map(x => x.low);
  let risingLowSteps = 0;
  for (let i = 1; i < lows.length; i++) if (lows[i] >= lows[i - 1]) risingLowSteps++;
  const closeLocation = safeDiv(last.close - last.low, last.high - last.low, 0.5);
  const bodyPct = pct(last.open, last.close);
  const bars = { '5m': { m5: 1, m15: 3, h1: 12, h4: 48 }, '15m': { m5: 0, m15: 1, h1: 4, h4: 16 }, '1h': { m5: 0, m15: 0, h1: 1, h4: 4 }, '4h': { m5: 0, m15: 0, h1: 0, h4: 1 } }[interval] || { m5: 0, m15: 0, h1: 1, h4: 4 };
  const returnBars = count => count > 0 && candles.length > count ? count : 0;
  const ret5 = bars.m5 ? pct(candles.at(-1 - returnBars(bars.m5))?.close || last.open, last.close) : 0;
  const ret15 = bars.m15 ? pct(candles.at(-1 - returnBars(bars.m15))?.close || last.open, last.close) : 0;
  const ret1h = bars.h1 ? pct(candles.at(-1 - returnBars(bars.h1))?.close || last.open, last.close) : 0;
  const ret4h = bars.h4 ? pct(candles.at(-1 - returnBars(bars.h4))?.close || last.open, last.close) : 0;
  const rangeHighDistance = (priorHigh - last.close) / last.close * 100;
  const rangeLowDistance = (last.close - priorLow) / last.close * 100;
  const volRatio = safeDiv(recentVol, baselineVol, 1);
  const rangeCompression = safeDiv(baselineRange, recentRange, 1);
  const greenVol = sum(recent6.filter(x => x.close > x.open).map(x => x.quoteVolume));
  const redVol = sum(recent6.filter(x => x.close < x.open).map(x => x.quoteVolume));
  const directionalCandleShare = safeDiv(greenVol, greenVol + redVol, 0.5);
  const upCloseCount = recent6.filter(x => x.close > x.open && (x.close - x.low) / Math.max(1e-12, x.high - x.low) > 0.60).length;
  const last3Range = mean(recent3.map(x => (x.high - x.low) / x.close * 100));
  const extensionAtr = a > 0 ? (last.close - e21) / a : 0;
  const breakout = last.close > priorHigh;
  const nearResistance = rangeHighDistance >= -0.25 && rangeHighDistance <= 2.0;
  return {
    candles: candles.length, last, price: last.close, atr: a, ema9: e9, ema21: e21,
    priorHigh, priorLow, rangeHighDistance, rangeLowDistance,
    volRatio, recentVol, baselineVol, rangeCompression, recentRange, baselineRange,
    closeLocation, bodyPct, ret5, ret15, ret1h, ret4h,
    risingLowSteps, directionalCandleShare, upCloseCount, last3Range,
    extensionAtr, breakout, nearResistance,
  };
}

function scoreTakerFlow(stats) {
  const now = Date.now() / 1000;
  const rows = stats.filter(x => x.longTaker !== null && x.shortTaker !== null && x.longTaker >= 0 && x.shortTaker >= 0 && x.time !== null);
  if (rows.length < 4 || now - rows.at(-1).time > 3600 || rows.at(-1).time - rows[0].time < 1800) return { available: false, score: 0, buyShare: null, change: null, samples: rows.length };
  const usable = rows.slice(-12);
  const half = Math.floor(usable.length / 2);
  const first = usable.slice(0, half), second = usable.slice(half);
  const totals = arr => ({ buy: sum(arr.map(x => x.longTaker)), sell: sum(arr.map(x => x.shortTaker)) });
  const a = totals(first), b = totals(second), all = totals(usable);
  const allTotal = all.buy + all.sell;
  const buyShare = allTotal > 0 ? all.buy / allTotal * 100 : 50;
  const firstShare = a.buy + a.sell > 0 ? a.buy / (a.buy + a.sell) * 100 : 50;
  const secondShare = b.buy + b.sell > 0 ? b.buy / (b.buy + b.sell) * 100 : 50;
  const improvement = secondShare - firstShare;
  const shareScore = clamp(35 + (buyShare - 50) * 5.2);
  const trendScore = clamp(50 + improvement * 5);
  return { available: true, score: clamp(shareScore * 0.72 + trendScore * 0.28), buyShare: round(buyShare, 1), change: round(improvement, 1), samples: usable.length };
}

function scoreOpenInterest(stats, midFeatures) {
  const now = Date.now() / 1000;
  const rows = stats.filter(x => x.oi !== null && x.oi > 0 && x.time !== null);
  if (rows.length < 4 || now - rows.at(-1).time > 3600 || rows.at(-1).time - rows[0].time < 1800) return { available: false, score: 0, changePct: null };
  const usable = rows.slice(-12);
  const first = usable[0], last = usable.at(-1);
  const changePct = pct(first.oi, last.oi);
  const priceMove = midFeatures?.ret1h ?? 0;
  // OI expansion is constructive only when price is not sharply falling.
  let alignment = 70;
  if (priceMove < -1.5) alignment = 12;
  else if (priceMove < -0.5) alignment = 35;
  else if (priceMove > 3.5) alignment = 55; // rising OI after a large impulse is less early
  else if (priceMove >= 0 && priceMove <= 2.0) alignment = 95;
  const oiBuild = clamp(40 + changePct * 18);
  return { available: true, score: clamp(oiBuild * 0.62 + alignment * 0.38), changePct: round(changePct, 2), samples: usable.length };
}

function scoreStructure(f) {
  if (!f) return 0;
  const compression = clamp(30 + (f.rangeCompression - 0.85) * 38);
  const higherLows = clamp(25 + f.risingLowSteps * 10);
  const closeStrength = clamp(f.closeLocation * 100);
  const baseStability = clamp(100 - Math.max(0, f.ret1h) * 9 - Math.max(0, -f.ret1h) * 18);
  const nearLevel = f.nearResistance ? 88 : clamp(80 - Math.max(0, f.rangeHighDistance) * 13);
  return clamp(compression * 0.24 + higherLows * 0.24 + closeStrength * 0.18 + baseStability * 0.18 + nearLevel * 0.16);
}

function scoreVolume(f) {
  if (!f) return 0;
  const ratio = clamp(30 + Math.log2(Math.max(0.2, f.volRatio)) * 28);
  const persistence = clamp(20 + f.upCloseCount * 13 + Math.max(0, f.directionalCandleShare - 0.5) * 70);
  // Reward measured expansion, not a single extreme volume spike.
  const moderation = f.volRatio > 5 ? 45 : f.volRatio > 3.5 ? 65 : 100;
  return clamp(ratio * 0.48 + persistence * 0.37 + moderation * 0.15);
}

function scoreIgnition(mid, fast) {
  if (!mid || !fast) return 0;
  const shortMomentum = clamp(48 + mid.ret15 * 13 + fast.ret15 * 8);
  const emaAlignment = clamp(35 + (mid.price > mid.ema9 ? 20 : 0) + (mid.ema9 > mid.ema21 ? 25 : 0) + (fast.price > fast.ema9 ? 20 : 0));
  const pressure = clamp(mid.closeLocation * 65 + fast.closeLocation * 35);
  const firstBreak = mid.breakout && mid.ret15 < 2.8 ? 95 : mid.nearResistance ? 78 : clamp(65 - Math.max(0, mid.rangeHighDistance) * 12);
  const earlyPenalty = Math.max(0, mid.ret1h - 3.5) * 12 + Math.max(0, fast.ret15 - 2.2) * 18;
  return clamp((shortMomentum * 0.28 + emaAlignment * 0.25 + pressure * 0.18 + firstBreak * 0.29) - earlyPenalty);
}

function scoreRelativeStrength(asset1h, asset4h, btc1h, btc4h) {
  if (!asset1h || !asset4h || !btc1h || !btc4h) return { score: 45, rel1h: null, rel4h: null, available: false };
  const rel1h = asset1h.ret1h - btc1h.ret1h;
  const rel4h = asset4h.ret4h - btc4h.ret4h;
  const s1 = clamp(50 + rel1h * 13);
  const s4 = clamp(50 + rel4h * 7);
  return { score: clamp(s1 * 0.58 + s4 * 0.42), rel1h: round(rel1h, 2), rel4h: round(rel4h, 2), available: true };
}

function scoreEntry(mid, fast, ticker, book) {
  if (!mid) return { score: 0, spreadPct: null, extended: true };
  const dist = mid.rangeHighDistance;
  // Best zone: close enough to trigger, but not already far beyond resistance.
  let resistance = dist >= 0 ? clamp(100 - Math.abs(dist - 0.8) * 27) : clamp(88 - Math.abs(dist) * 30);
  if (dist > 4.5) resistance = 30;
  const stopRoom = clamp(100 - Math.max(0, mid.rangeLowDistance - 3) * 9);
  const extension = Math.max(0, mid.extensionAtr - 1.6) * 18 + Math.max(0, mid.ret1h - 4) * 8 + Math.max(0, (fast?.ret15 ?? 0) - 2.5) * 8;
  const priceFreshness = clamp(100 - extension);
  const spreadPct = book?.available ? book.spreadPct : null;
  const spreadQuality = spreadPct === null ? 45 : clamp(100 - spreadPct * 110);
  const liquidity = ticker ? clamp(20 + Math.log10(Math.max(1, n(ticker.volume_24h_quote) || 0)) * 9) : 30;
  return { score: clamp(resistance * 0.32 + stopRoom * 0.18 + priceFreshness * 0.32 + spreadQuality * 0.10 + liquidity * 0.08), spreadPct, extended: extension > 48 || mid.extensionAtr > 3.2 || mid.ret1h > 8 || (fast && fast.ret15 > 6) };
}

function analyzeBook(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) || !book.bids.length || !book.asks.length) {
    return { available: false, spreadPct: null, bidDepth: null, askDepth: null };
  }
  const bid = n(book.bids[0]?.p), ask = n(book.asks[0]?.p);
  if (!(bid > 0 && ask > bid)) return { available: false, spreadPct: null, bidDepth: null, askDepth: null };
  const mid = (bid + ask) / 2;
  const current = n(book.current ?? book.update);
  const fresh = current !== null && Math.abs(Date.now() / 1000 - current) <= 60;
  return { available: fresh, spreadPct: (ask - bid) / mid * 100, bidDepth: null, askDepth: null };
}

function analyzeTrades(trades) {
  if (!trades?.length) return { available: false, count: 0, turnover: 0 };
  const recent = trades.filter(x => x.time === null || (x.time > 1e12 ? Date.now() - x.time <= 3600000 : Date.now() / 1000 - x.time <= 3600));
  return { available: recent.length >= 10, count: recent.length };
}

function fundingScore(ticker, stats) {
  const rate = n(ticker?.funding_rate);
  // Gate returns a decimal ratio (e.g. 0.0001 = 0.01%), not percent.
  const funding = rate === null ? 45 : rate <= 0.00015 ? 95 : rate <= 0.0003 ? 78 : rate <= 0.0005 ? 55 : rate <= 0.0008 ? 30 : 10;
  const topRows = (stats || []).filter(x => x.topPositionRatio !== null && x.topPositionRatio > 0);
  const topRatio = topRows.length ? topRows.at(-1).topPositionRatio : null;
  // Avoid crowded-long conditions; a high top-trader long/short ratio is a risk flag, not a directional signal.
  const positioning = topRatio === null ? 45 : topRatio >= 1.8 ? 15 : topRatio >= 1.45 ? 35 : topRatio >= 1.2 ? 55 : topRatio >= 0.8 ? 82 : 88;
  return { score: funding * 0.65 + positioning * 0.35, rate, topRatio };
}

function classify(score, readiness, ignition, entry, extended, dataConfidence) {
  if (extended || dataConfidence < 45 || entry < 35) return 'PASS';
  if (score >= 82 && readiness >= 72 && ignition >= 60) return 'STRONG LONG';
  if (score >= 73 && readiness >= 62) return 'EARLY LONG';
  if (score >= 62) return 'BUILDING';
  return 'WATCH';
}

function analyzeMarket(contract, ticker, main, deep, btc) {
  const h1 = candleFeatures(main, '1h');
  const m15 = candleFeatures(deep.mid, '15m');
  const m5 = candleFeatures(deep.fast, '5m');
  const h4 = candleFeatures(deep.trend, '4h');
  if (!h1 || !m15 || !m5 || !h4) return null;

  const flow = scoreTakerFlow(deep.stats);
  const oi = scoreOpenInterest(deep.stats, m15);
  const book = analyzeBook(deep.book);
  const trades = analyzeTrades(deep.trades);
  const funding = fundingScore(ticker, deep.stats);
  const structure = scoreStructure(h1) * 0.58 + scoreStructure(m15) * 0.42;
  const volume = scoreVolume(h1) * 0.45 + scoreVolume(m15) * 0.55;
  const ignition = scoreIgnition(m15, m5);
  const relative = scoreRelativeStrength(h1, h4, btc?.h1, btc?.h4);
  const entry = scoreEntry(m15, m5, ticker, book);

  // Readiness emphasizes demand, position build-up and pre-move structure.
  const readiness = clamp(flow.score * 0.28 + oi.score * 0.24 + structure * 0.28 + volume * 0.20);
  // Final ranking emphasizes evidence of a strong new LONG initiation.
  let score = flow.score * 0.20 + oi.score * 0.18 + structure * 0.17 + volume * 0.14 + ignition * 0.13 + relative.score * 0.10 + entry.score * 0.05 + funding.score * 0.03;

  const dailyVolume = n(ticker?.volume_24h_quote) || 0;
  const spreadPct = book.spreadPct;
  const extended = entry.extended || h1.ret4h > 15 || m15.ret1h > 9;
  const confidenceParts = [flow.available, oi.available, trades.available, book.available, deep.errors.length === 0];
  const dataConfidence = confidenceParts.filter(Boolean).length / confidenceParts.length * 100;

  // Evidence interaction bonuses: independent confirmations matter more together.
  if (flow.score >= 72 && oi.score >= 68) score += 3.5;
  if (structure >= 72 && volume >= 68) score += 2.5;
  if (relative.score >= 70 && ignition >= 68) score += 2;

  // Strong anti-chase and anti-false-signal controls.
  if (extended) score -= 18;
  if (dailyVolume < CFG.MIN_DAILY_QUOTE_VOLUME) score -= 14;
  if (spreadPct !== null && spreadPct > CFG.MAX_SPREAD_PCT) score -= 12;
  if (flow.available && flow.buyShare < 47) score -= 12;
  if (oi.available && oi.changePct < -0.25) score -= 8;
  if (!flow.available) score -= 8;
  if (!oi.available) score -= 7;
  if (!book.available) score -= 2; // book is quality context, not directional proof
  if (btc?.riskOff) score -= 6;
  score = clamp(score);

  const phase = classify(score, readiness, ignition, entry.score, extended, dataConfidence);
  return {
    contract, score: round(score, 1), phase,
    readiness: round(readiness, 1), flow: round(flow.score, 1), oiScore: round(oi.score, 1),
    structure: round(structure, 1), volume: round(volume, 1), ignition: round(ignition, 1),
    relative: round(relative.score, 1), entry: round(entry.score, 1), dataConfidence: round(dataConfidence, 0),
    price: m15.price, change24h: n(ticker?.change_percentage) ?? h1.ret4h,
    dailyVolume, fundingRate: funding.rate,
    takerBuyShare: flow.buyShare, takerShift: flow.change,
    oiChange: oi.changePct,
    rel1h: relative.rel1h, rel4h: relative.rel4h,
    resistanceDistance: round(m15.rangeHighDistance, 2),
    spreadPct: spreadPct === null ? null : round(spreadPct, 3),
    volumeRatio1h: round(h1.volRatio, 2), volumeRatio15m: round(m15.volRatio, 2),
    ret1h: round(m15.ret1h, 2), ret15m: round(m15.ret15, 2), ret5m: round(m5.ret15, 2),
    extensionAtr: round(m15.extensionAtr, 2), breakout: m15.breakout,
    bookBidDepth: book.bidDepth, bookAskDepth: book.askDepth,
    tradeCount: trades.count, tradeTurnover: trades.turnover,
    deepErrors: deep.errors,
  };
}

// -------------------------- UNIVERSE / PREFILTER --------------------------
async function getUniverse() {
  const [contracts, tickers] = await Promise.all([
    getJSON(`/futures/${CFG.SETTLE}/contracts`),
    getJSON(`/futures/${CFG.SETTLE}/tickers`),
  ]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new Error('Gate returned invalid contracts/tickers payload');
  const tickerMap = new Map(tickers.map(x => [x.contract, x]));
  const active = contracts.filter(c => c && c.status === 'trading' && c.type === 'direct' &&
    typeof c.name === 'string' && c.name.endsWith('_USDT') && c.in_delisting !== true);
  return { active, tickerMap };
}

function preliminaryRank(candles, ticker, btcH1) {
  const f = candleFeatures(candles, '1h');
  if (!f) return -1;
  const vol = scoreVolume(f);
  const structure = scoreStructure(f);
  const relative = btcH1 ? clamp(50 + (f.ret1h - btcH1.ret1h) * 10) : 50;
  const notChasing = clamp(100 - Math.max(0, f.ret4h - 7) * 9 - Math.max(0, f.extensionAtr - 2) * 12);
  const liquidity = clamp(20 + Math.log10(Math.max(1, n(ticker?.volume_24h_quote) || 0)) * 9);
  return vol * 0.22 + structure * 0.30 + relative * 0.18 + notChasing * 0.20 + liquidity * 0.10;
}

// ------------------------------ TELEGRAM ------------------------------
function phaseEmoji(phase) {
  return ({ 'STRONG LONG': '🟢', 'EARLY LONG': '🟩', BUILDING: '🟡', WATCH: '⚪', PASS: '⛔' })[phase] || '⚪';
}
function renderItem(x, rank) {
  const lines = [
    `${String(rank).padStart(2, '0')} · ${x.contract} · ${x.score}/100`,
    `${bar(x.score)}  ${phaseEmoji(x.phase)} ${x.phase}`,
    `آمادگی ${x.readiness} | جریان خرید ${x.flow} | OI ${x.oiScore} | ساختار ${x.structure}`,
    `شروع ${x.ignition} | حجم ${x.volume} | قدرت نسبی ${x.relative} | ورود ${x.entry}`,
    `Taker Buy ${x.takerBuyShare === null ? 'N/A' : `${x.takerBuyShare}%`} | OI Δ ${x.oiChange === null ? 'N/A' : `${signed(x.oiChange)}%`} | فاصله مقاومت ${signed(x.resistanceDistance)}%`,
    `۱۵m ${signed(x.ret15m)}% | ۱h ${signed(x.ret1h)}% | ۲۴h ${signed(x.change24h)}% | حجم روز ${fmt(x.dailyVolume)}`,
  ];
  if (x.spreadPct !== null) lines.push(`Spread ${x.spreadPct}% | اطمینان داده ${x.dataConfidence}%`);
  return lines.join('\n');
}
function splitMessage(s, max) {
  if (s.length <= max) return [s];
  const blocks = s.split('\n');
  const out = [];
  let cur = '';
  for (const b of blocks) {
    const candidate = cur ? `${cur}\n${b}` : b;
    if (candidate.length > max && cur) { out.push(cur); cur = b; }
    else cur = candidate;
  }
  if (cur) out.push(cur);
  return out;
}
async function sendTelegram(message) {
  if (CFG.TELEGRAM_DISABLED) { console.log(message); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.warn('Telegram secrets missing; report printed to logs.'); console.log(message); return; }
  for (const chunk of splitMessage(message, CFG.MAX_REPORT_LENGTH)) {
    let ok = false;
    let lastErr;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(`Telegram ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
        ok = true;
      } catch (err) { lastErr = err; await sleep(500 * (attempt + 1)); }
      finally { clearTimeout(timer); }
    }
    if (!ok) throw lastErr || new Error('Telegram delivery failed');
    await sleep(250);
  }
}

function buildReport(summary, ranked) {
  const chosen = ranked.filter(x => x.phase !== 'PASS').slice(0, CFG.TOP_LIMIT);
  const lines = [
    '🎯 GATE.IO | LONG INITIATION HUNTER',
    `🕒 ${stamp()} · رتبه‌بندی قدرت شروع LONG`,
    '',
    `بازار ${summary.total} | بررسی اولیه ${summary.scanned} | بررسی عمیق ${summary.deep} | خطا ${summary.failed}`,
    `قوی ${summary.strong} · زودهنگام ${summary.early} · درحال‌شکل‌گیری ${summary.building}`,
    '',
    '🏆 TOP LONG OPPORTUNITIES',
    '',
  ];
  if (!chosen.length) lines.push('در این اجرا موقعیت LONG با کیفیت کافی پیدا نشد.');
  chosen.forEach((x, i) => {
    lines.push(renderItem(x, i + 1));
    if (i !== chosen.length - 1) lines.push('──────────');
  });
  lines.push('', 'راهنما: امتیاز، قدرت شواهد فعلی را رتبه‌بندی می‌کند؛ احتمال آماری تضمین‌شده نیست. قبل از معامله، نمودار و حدضرر بررسی شود.');
  return lines.join('\n');
}

// ------------------------------- SELF TEST -------------------------------
function selfTest() {
  const make = (count, trend = 0.0004, vol = 1000) => {
    const arr = [];
    let p = 100;
    const now = Math.floor(Date.now() / 1000) - count * 300;
    for (let i = 0; i < count; i++) {
      const open = p;
      p = p * (1 + trend + (i % 7 === 0 ? -0.0002 : 0));
      const high = Math.max(open, p) * 1.002;
      const low = Math.min(open, p) * 0.998;
      arr.push({ time: now + i * 300, open, close: p, high, low, volume: vol, quoteVolume: vol * p });
    }
    return arr;
  };
  const f = candleFeatures(make(100), '1h');
  const f15 = candleFeatures(make(100), '15m');
  const f5 = candleFeatures(make(100), '5m');
  if (!f || !f15 || !f5 || !(f.price > 0) || !Number.isFinite(scoreStructure(f)) || !Number.isFinite(scoreVolume(f)) || !Number.isFinite(f15.ret1h) || !Number.isFinite(f5.ret15)) throw new Error('Feature/scoring self-test failed');
  const now = Date.now() / 1000;
  const stats = Array.from({ length: 8 }, (_, i) => ({
    time: now - (7 - i) * 900, oi: 100000 + i * 250, oiUsd: null,
    longTaker: 120 + i, shortTaker: 80, topPositionRatio: 1.05, topAccountRatio: 1.0,
  }));
  const flow = scoreTakerFlow(stats);
  if (!flow.available || flow.buyShare <= 50) throw new Error('Taker-flow self-test failed');
  const deep = {
    mid: make(100), fast: make(100), trend: make(60), stats,
    trades: Array.from({ length: 20 }, (_, i) => ({ time: Date.now() - i * 1000, id: String(i) })),
    book: { current: now, bids: [{ p: '99.9', s: '100' }], asks: [{ p: '100.1', s: '100' }] },
    errors: [],
  };
  const btc = { h1: f, h4: candleFeatures(deep.trend, '4h'), riskOff: false };
  const result = analyzeMarket('TEST_USDT', { volume_24h_quote: '1000000', funding_rate: '0.0001', change_percentage: '1' }, make(100), deep, btc);
  if (!result || !Number.isFinite(result.score) || result.score < 0 || result.score > 100) throw new Error('Full market scoring self-test failed');
  console.log('SELF-TEST OK');
}

// -------------------------------- MAIN --------------------------------
async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const started = Date.now();
  console.log(`Starting LONG Initiation Hunter | Node ${process.version} | ${stamp()}`);
  const { active, tickerMap } = await getUniverse();
  console.log(`Active direct USDT perpetuals: ${active.length}`);
  if (!active.length) throw new Error('No active USDT direct perpetual contracts found');

  // Fetch BTC context first; it is also retained in the broad scan universe.
  const btcMain = await getCandles(CFG.BTC_CONTRACT, CFG.MAIN_INTERVAL, CFG.MAIN_LIMIT).catch(() => []);
  const btcH1 = candleFeatures(btcMain, '1h');

  let scanned = 0;
  const stageOne = await mapLimit(active, CFG.CONCURRENCY, async c => {
    const candles = await getCandles(c.name, CFG.MAIN_INTERVAL, CFG.MAIN_LIMIT);
    scanned++;
    if (candles.length < CFG.MIN_MAIN_CANDLES) return { contract: c.name, insufficient: true };
    const ticker = tickerMap.get(c.name);
    return { contract: c.name, candles, preScore: preliminaryRank(candles, ticker, btcH1) };
  });
  const valid = stageOne.filter(x => x && !x.error && !x.insufficient && x.candles);
  const failed = stageOne.filter(x => x?.error).length;
  valid.sort((a, b) => b.preScore - a.preScore);
  const targets = valid.slice(0, CFG.DEEP_CANDIDATES);
  console.log(`Stage 1 valid=${valid.length} | deep candidates=${targets.length} | failed=${failed}`);

  const deepRows = await mapLimit(targets, CFG.CONCURRENCY, async x => ({ contract: x.contract, deep: await getDeep(x.contract) }));
  const deepMap = new Map(deepRows.filter(x => x && !x.error).map(x => [x.contract, x.deep]));

  // BTC deep context uses the same market endpoints, but it need not displace candidates.
  let btcDeep = deepMap.get(CFG.BTC_CONTRACT);
  if (!btcDeep) btcDeep = await getDeep(CFG.BTC_CONTRACT).catch(() => null);
  const btcContext = {
    h1: btcH1,
    h4: btcDeep ? candleFeatures(btcDeep.trend, '4h') : null,
    riskOff: !!((btcH1 && btcH1.ret1h < -2.0) || (btcDeep && candleFeatures(btcDeep.trend, '4h')?.ret4h < -4.0)),
  };

  const results = [];
  for (const x of targets) {
    const deep = deepMap.get(x.contract);
    if (!deep) continue;
    const result = analyzeMarket(x.contract, tickerMap.get(x.contract), x.candles, deep, btcContext);
    if (result) results.push(result);
  }
  results.sort((a, b) => b.score - a.score);

  const summary = {
    total: active.length,
    scanned: valid.length,
    deep: deepMap.size,
    failed,
    strong: results.filter(x => x.phase === 'STRONG LONG').length,
    early: results.filter(x => x.phase === 'EARLY LONG').length,
    building: results.filter(x => x.phase === 'BUILDING').length,
  };
  const report = buildReport(summary, results);
  await sendTelegram(report);
  console.log(`Completed in ${round((Date.now() - started) / 1000, 1)}s | candidates=${results.length} | topScore=${results[0]?.score ?? 'n/a'}`);
}

main().catch(async err => {
  console.error('FATAL:', err?.stack || err);
  try { await sendTelegram(`🚨 LONG INITIATION HUNTER ERROR\n${String(err?.message || err).slice(0, 1000)}`); }
  catch (sendErr) { console.error('Error notification failed:', sendErr?.message || sendErr); }
  process.exitCode = 1;
});
