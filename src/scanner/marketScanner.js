/**
 * GATE.IO USDT PERPETUAL — LONG ONLY ENTRY RADAR
 * --------------------------------------------------------------------
 * File: src/scanner/marketScanner.js
 * Node.js 20+
 *
 * All scanner settings are HARD-CODED in CONFIG below.
 * No .env file is required for strategy settings.
 * FIXED: currentNearMisses is now correctly initialized as an array [].
 *
 * Logic:
 * - LONG_MODE=BALANCED
 * - BTC 4h regime filter
 * - Coin 4h uptrend filter: close > EMA50 > EMA200
 * - Entry only on 15m Pullback / Breakout
 * - Mandatory 15m trigger
 * - Entry zone, Stop Loss, TP1/TP2/TP3 from real resistances
 * - Telegram: max 5 compact signals, no empty spam
 * - Logs: [FILTER STATS] and [NEAR MISSES]
 *
 * No order execution.
 */
import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',

  // ===== HARD-CODED SETTINGS (NO .env NEEDED) =====
  MIN_QUOTE_VOLUME_24H: 1000000,
  LONG_MODE: 'BALANCED', // STRICT | BALANCED
  MIN_LONG_SCORE: 70,
  MIN_LONG_SCORE_NEUTRAL: 75,
  MIN_LONG_SCORE_BEARISH: 82,
  SCAN_LIMIT: 0, // 0 = scan ALL liquid markets
  TOP_COUNT: 5,
  TELEGRAM_SEND_EMPTY: false,

  // ===== Other fixed settings =====
  TRADE_LIMIT: 1000,
  HISTORY_HOURS: 24,
  HISTORY_REPORT_HOURS: 6,
  CONCURRENCY: 5,
  REQUEST_SPACING_MS: 120,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,
  TELEGRAM_MAX_LENGTH: 3800,

  MIN_RECENT_BUY_NOTIONAL: 1500,
  MIN_PREVIOUS_BUY_BASELINE: 300,
  MIN_HISTORY_CANDLES: 4,

  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,

  MIN_RR_TP1: 1.0,
  MIN_RR_TP2: 1.8,
  MAX_RSI_ENTRY: 70,
  MAX_RSI_4H: 75,
  MAX_FUNDING_RATE: 0.001, // 0.10%
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const num = value => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};
const positive = value => Number.isFinite(value) && value > 0;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const round = (value, digits = 2) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const pctChange = (current, previous) => positive(previous) ? ((current - previous) / previous) * 100 : 0;

const fmtPrice = value => {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100) return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(5);
  return value.toFixed(8);
};
const pctFrom = (price, target) => positive(price) ? ((target - price) / price) * 100 : 0;
const signedPct = (price, target) => {
  const p = pctFrom(price, target);
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
};
const intScore = v => Math.round(clamp(v, 0, 100));

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

let currentRejectStats = {};
let currentNearMisses = [];
const reject = reason => {
  currentRejectStats[reason] = (currentRejectStats[reason] ?? 0) + 1;
  return null;
};

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const slot = requestQueue.then(async () => {
    const wait = CONFIG.REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  requestQueue = slot.catch(() => {});
  await slot;

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();

      const body = await response.text().catch(() => '');
      const error = new Error(`Gate HTTP ${response.status} ${path}: ${body.slice(0, 180)}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const permanentClientError =
        error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status);
      if (attempt === CONFIG.RETRIES || permanentClientError) break;
    }
    const delay = lastError?.status === 429 && lastError.retryAfter > 0
      ? Math.min(lastError.retryAfter * 1000, 30000)
      : Math.min(500 * (2 ** attempt), 8000);
    await sleep(delay);
  }
  throw lastError || new Error(`Gate request failed: ${path}`);
}

async function mapPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        output[index] = await worker(items[index], index);
      } catch (error) {
        output[index] = { __error: error?.message || String(error), symbol: items[index]?.symbol };
      }
    }
  }));
  return output;
}

function normalizeTradeTime(trade) {
  const milliseconds = num(trade?.create_time_ms);
  if (milliseconds != null && milliseconds > 0) return milliseconds / 1000;
  const seconds = num(trade?.create_time);
  return seconds != null && seconds > 0 ? seconds : null;
}

function tradeNotional(trade, multiplier) {
  const signedSize = num(trade?.size);
  const price = num(trade?.price);
  if (signedSize == null || price == null || !positive(price)) return null;
  const time = normalizeTradeTime(trade);
  if (time == null) return null;
  const contractMultiplier = positive(multiplier) ? multiplier : 1;
  return { signedSize, notional: Math.abs(signedSize) * contractMultiplier * price, time };
}

function aggregateCurrentTrades(trades, multiplier, hourStart, nowSeconds) {
  const minuteBuckets = new Map();
  let buyHour = 0, sellHour = 0, validTrades = 0, oldestTime = Infinity;

  for (const trade of trades || []) {
    const item = tradeNotional(trade, multiplier);
    if (!item) continue;
    if (item.time < hourStart || item.time > nowSeconds + 2) continue;
    validTrades++;
    oldestTime = Math.min(oldestTime, item.time);
    const minute = Math.floor(item.time / 60) * 60;
    const bucket = minuteBuckets.get(minute) || { buy: 0, sell: 0, count: 0 };
    if (item.signedSize > 0) { buyHour += item.notional; bucket.buy += item.notional; }
    else if (item.signedSize < 0) { sellHour += item.notional; bucket.sell += item.notional; }
    bucket.count++;
    minuteBuckets.set(minute, bucket);
  }

  const currentMinute = Math.floor(nowSeconds / 60) * 60;
  const bucketAt = minute => minuteBuckets.get(minute) || { buy: 0, sell: 0, count: 0 };
  const sumWindow = (start, end, key) => {
    let total = 0;
    for (let time = start; time < end; time += 60) total += bucketAt(time)[key];
    return total;
  };

  const last3Start = currentMinute - 2 * 60;
  const previous3Start = currentMinute - 5 * 60;
  const prior3Start = currentMinute - 8 * 60;

  const buyLast3 = sumWindow(last3Start, currentMinute + 60, 'buy');
  const sellLast3 = sumWindow(last3Start, currentMinute + 60, 'sell');
  const buyPrevious3 = sumWindow(previous3Start, last3Start, 'buy');
  const sellPrevious3 = sumWindow(previous3Start, last3Start, 'sell');
  const buyPrior3 = sumWindow(prior3Start, previous3Start, 'buy');

  const buyRateLast = buyLast3 / 3;
  const buyRatePrevious = buyPrevious3 / 3;
  const buyRatePrior = buyPrior3 / 3;

  const validBaseline = buyPrevious3 >= CONFIG.MIN_PREVIOUS_BUY_BASELINE;
  const rateMultiple = validBaseline ? buyRateLast / Math.max(buyRatePrevious, 1) : null;
  const acceleration = rateMultiple != null && buyPrior3 >= CONFIG.MIN_PREVIOUS_BUY_BASELINE
    ? rateMultiple - (buyRatePrevious / Math.max(buyRatePrior, 1))
    : null;

  const totalHour = buyHour + sellHour;
  const recentTotal = buyLast3 + sellLast3;
  const buyShareHour = totalHour > 0 ? (buyHour / totalHour) * 100 : 0;
  const buyShareRecent = recentTotal > 0 ? (buyLast3 / recentTotal) * 100 : 0;

  const recentMinuteBuckets = [];
  for (let time = last3Start; time <= currentMinute; time += 60) {
    const bucket = bucketAt(time);
    recentMinuteBuckets.push({ buy: bucket.buy, sell: bucket.sell, total: bucket.buy + bucket.sell });
  }
  const positiveBuyMinutes = recentMinuteBuckets.filter(item => item.buy > 0).length;
  const persistence = recentMinuteBuckets.length > 0 ? (positiveBuyMinutes / recentMinuteBuckets.length) * 100 : 0;

  const truncated = (trades || []).length >= CONFIG.TRADE_LIMIT;
  const elapsedSeconds = Math.max(1, nowSeconds - hourStart);
  const coveragePct = truncated && Number.isFinite(oldestTime)
    ? Math.min(100, ((nowSeconds - oldestTime) / elapsedSeconds) * 100)
    : truncated ? 0 : 100;

  return {
    buyHour, sellHour, totalHour, buyShareHour, deltaHour: buyHour - sellHour,
    buyLast3, sellLast3, recentTotal, buyShareRecent, deltaRecent: buyLast3 - sellLast3,
    buyPrevious3, sellPrevious3, buyPrior3, buyRateLast, buyRatePrevious, buyRatePrior,
    rateMultiple, acceleration, validBaseline, persistence, positiveBuyMinutes,
    validTrades, oldestTime, truncated, coveragePct: round(coveragePct, 0),
  };
}

function normalizeCandle(raw) {
  const time = num(raw?.t), open = num(raw?.o), high = num(raw?.h);
  const low = num(raw?.l), close = num(raw?.c);
  const volumeContracts = num(raw?.v), quoteTurnover = num(raw?.sum);
  if (time == null || !positive(open) || !positive(high) || !positive(low) || !positive(close)) return null;
  return { time, open, high, low, close, volumeContracts: volumeContracts ?? 0, quoteTurnover: quoteTurnover ?? 0 };
}

function toClosedCandles(rawCandles, timeframeSeconds, nowSeconds) {
  return (rawCandles || []).map(normalizeCandle).filter(Boolean)
    .filter(candle => candle.time + timeframeSeconds <= nowSeconds)
    .sort((a, b) => a.time - b.time);
}

function normalizeContractStat(raw) {
  const time = num(raw?.time);
  if (time == null) return null;
  return {
    time,
    longTakerContracts: num(raw?.long_taker_size),
    shortTakerContracts: num(raw?.short_taker_size),
    markPrice: num(raw?.mark_price),
    takerLongShortRatio: num(raw?.lsr_taker),
  };
}

function buildHourlyHistory(rawCandles, rawStats, multiplier, nowSeconds) {
  const currentHourStart = Math.floor(nowSeconds / 3600) * 3600;
  const candles = (rawCandles || []).map(normalizeCandle).filter(Boolean)
    .filter(candle => candle.time < currentHourStart).sort((a, b) => a.time - b.time);

  const statsByHour = new Map();
  for (const raw of rawStats || []) {
    const stat = normalizeContractStat(raw);
    if (!stat) continue;
    const bucket = Math.floor(stat.time / 3600) * 3600;
    if (bucket >= currentHourStart) continue;
    statsByHour.set(bucket, stat);
  }

  return candles.map(candle => {
    const stat = statsByHour.get(candle.time) || null;
    const referencePrice = positive(candle.close) ? candle.close : stat?.markPrice;
    const longTakerQuote = stat?.longTakerContracts != null && positive(multiplier) && positive(referencePrice)
      ? Math.abs(stat.longTakerContracts) * multiplier * referencePrice : null;
    const shortTakerQuote = stat?.shortTakerContracts != null && positive(multiplier) && positive(referencePrice)
      ? Math.abs(stat.shortTakerContracts) * multiplier * referencePrice : null;
    const hasDirectionalStats = longTakerQuote != null && shortTakerQuote != null;
    const directionalTotal = hasDirectionalStats ? longTakerQuote + shortTakerQuote : null;
    return {
      time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
      totalQuoteVolume: candle.quoteTurnover, buyQuoteVolume: longTakerQuote, sellQuoteVolume: shortTakerQuote,
      buySharePct: hasDirectionalStats && directionalTotal > 0 ? (longTakerQuote / directionalTotal) * 100 : null,
      deltaQuote: hasDirectionalStats ? longTakerQuote - shortTakerQuote : null,
      hasDirectionalStats, priceChangePct: pctChange(candle.close, candle.open),
    };
  });
}

function analyzeHourlyHistory(history) {
  const recent = history.slice(-CONFIG.HISTORY_REPORT_HOURS);
  if (recent.length < CONFIG.MIN_HISTORY_CANDLES) {
    return { available: false, candles: recent, priceTrend: 'INSUFFICIENT_HISTORY', volumeTrend: 'INSUFFICIENT_HISTORY', sellerPressure: 'UNKNOWN', directionalCoverage: 0, priceDown: false, volumeFalling: false, sellerPressureFalling: false, buyShareImproving: false };
  }
  const first = recent[0], last = recent.at(-1);
  const recent3 = recent.slice(-3), previous3 = history.slice(-6, -3);
  const recentVolumeAvg = recent3.reduce((s, c) => s + c.totalQuoteVolume, 0) / Math.max(1, recent3.length);
  const previousVolumeAvg = previous3.length > 0 ? previous3.reduce((s, c) => s + c.totalQuoteVolume, 0) / previous3.length : null;
  const priceDown = last.close < first.close;
  const volumeFalling = previousVolumeAvg != null && previousVolumeAvg > 0 && recentVolumeAvg < previousVolumeAvg * 0.9;

  const directionalCandles = recent.filter(c => c.hasDirectionalStats);
  const directionalCoverage = recent.length > 0 ? (directionalCandles.length / recent.length) * 100 : 0;
  let sellerPressureFalling = false, buyShareImproving = false;
  const recentDirectional = recent3.filter(c => c.hasDirectionalStats);
  const previousDirectional = previous3.filter(c => c.hasDirectionalStats);

  if (recentDirectional.length >= 2 && previousDirectional.length >= 2) {
    const recentSellAvg = recentDirectional.reduce((s, c) => s + c.sellQuoteVolume, 0) / recentDirectional.length;
    const previousSellAvg = previousDirectional.reduce((s, c) => s + c.sellQuoteVolume, 0) / previousDirectional.length;
    sellerPressureFalling = previousSellAvg > 0 && recentSellAvg < previousSellAvg * 0.9;
    const recentBuyShare = recentDirectional.reduce((s, c) => s + c.buySharePct, 0) / recentDirectional.length;
    const previousBuyShare = previousDirectional.reduce((s, c) => s + c.buySharePct, 0) / previousDirectional.length;
    buyShareImproving = recentBuyShare > previousBuyShare + 3;
  }

  return {
    available: true, candles: recent, priceChangePct: pctChange(last.close, first.close),
    recentVolumeAvg, previousVolumeAvg,
    priceTrend: priceDown ? 'DOWN' : last.close > first.close ? 'UP' : 'FLAT',
    volumeTrend: previousVolumeAvg == null ? 'NO_BASELINE' : volumeFalling ? 'FALLING' : recentVolumeAvg > previousVolumeAvg * 1.1 ? 'RISING' : 'STABLE',
    sellerPressure: directionalCoverage < 60 ? 'INSUFFICIENT_DIRECTIONAL_DATA' : sellerPressureFalling ? 'FALLING' : 'NOT_FALLING',
    directionalCoverage: round(directionalCoverage, 0),
    priceDown, volumeFalling, sellerPressureFalling, buyShareImproving,
  };
}

/* ---------------- Indicators ---------------- */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  values.forEach((value, i) => {
    if (!Number.isFinite(value)) { out[i] = prev; return; }
    prev = prev == null ? value : value * k + prev * (1 - k);
    out[i] = prev;
  });
  return out;
}
function smoothSeries(values, period = 14) {
  const alpha = 1 / period;
  const out = new Array(values.length).fill(null);
  let prev = null;
  values.forEach((value, i) => {
    const v = Number.isFinite(value) ? value : 0;
    prev = prev == null ? v : v * alpha + prev * (1 - alpha);
    out[i] = prev;
  });
  return out;
}
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  values.forEach((value, i) => {
    sum += Number.isFinite(value) ? value : 0;
    if (i >= period) {
      const old = values[i - period];
      sum -= Number.isFinite(old) ? old : 0;
    }
    out[i] = sum / Math.min(period, i + 1);
  });
  return out;
}
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  let avgGain = null, avgLoss = null;
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = Math.max(delta, 0), loss = Math.max(-delta, 0);
    if (avgGain == null) { avgGain = gain; avgLoss = loss; }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; }
    out[i] = i < period ? 50 : avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}
function addIndicators(candles) {
  const closes = candles.map(c => c.close), highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const ema9 = emaSeries(closes, 9), ema20 = emaSeries(closes, 20), ema50 = emaSeries(closes, 50), ema200 = emaSeries(closes, 200);
  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => ema12[i] - ema26[i]);
  const macdSignal = emaSeries(macd, 9);
  const macdHist = macd.map((v, i) => v - macdSignal[i]);
  const rsi = rsiSeries(closes, 14);
  const bbMid = smaSeries(closes, 20);
  const bbUpper = new Array(closes.length).fill(null), bbLower = new Array(closes.length).fill(null);
  for (let i = 19; i < closes.length; i++) {
    const window = closes.slice(i - 19, i + 1);
    const mean = bbMid[i];
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / 19;
    const std = Math.sqrt(variance);
    bbUpper[i] = mean + std * 2; bbLower[i] = mean - std * 2;
  }
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); plusDM.push(0); minusDM.push(0); continue; }
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const upMove = highs[i] - highs[i - 1], downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const atr = smoothSeries(tr, 14);
  const trS = smoothSeries(tr, 14), plusS = smoothSeries(plusDM, 14), minusS = smoothSeries(minusDM, 14);
  const dx = trS.map((v, i) => {
    const plusDI = v > 0 ? 100 * plusS[i] / v : 0, minusDI = v > 0 ? 100 * minusS[i] / v : 0;
    return plusDI + minusDI > 0 ? 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI) : 0;
  });
  const adx = smoothSeries(dx, 14);
  const volumes = candles.map(c => positive(c.quoteTurnover) ? c.quoteTurnover : c.volumeContracts);
  const volMa20 = smaSeries(volumes, 20);

  return candles.map((c, i) => ({
    ...c, ema9: ema9[i], ema20: ema20[i], ema50: ema50[i], ema200: ema200[i],
    rsi: rsi[i], macd: macd[i], macdSignal: macdSignal[i], macdHist: macdHist[i],
    bbMid: bbMid[i], bbUpper: bbUpper[i], bbLower: bbLower[i], atr: atr[i], adx: adx[i], volMa20: volMa20[i],
  }));
}
function isBullishEngulfing(candles) {
  if (candles.length < 2) return false;
  const l = candles.at(-1), p = candles.at(-2);
  return l.close > l.open && p.close < p.open && l.close > p.open && l.open < p.close;
}
function isHammer(candles) {
  const l = candles.at(-1); if (!l) return false;
  const body = Math.abs(l.close - l.open); if (body === 0) return false;
  return (Math.min(l.open, l.close) - l.low > body * 2) && (l.high - Math.max(l.open, l.close) < body);
}
function hasBullishDivergence(candles) {
  if (candles.length < 30) return false;
  const w = candles.slice(-30), a = w.slice(0, 15), b = w.slice(15);
  const minIdx = arr => arr.reduce((best, c, i) => c.low < arr[best].low ? i : best, 0);
  const i1 = minIdx(a), i2 = minIdx(b);
  return b[i2].low < a[i1].low && b[i2].rsi > a[i1].rsi;
}
function findResistanceLevels(candles15, candles4h, price) {
  const levels = [];
  for (const candles of [candles15, candles4h]) {
    for (let i = 2; i < candles.length - 2; i++) {
      const h = candles[i].high;
      if (h > candles[i - 1].high && h > candles[i - 2].high && h >= candles[i + 1].high && h >= candles[i + 2].high) levels.push(h);
    }
  }
  const clustered = [];
  for (const lvl of levels.filter(x => x > price * 1.003 && x < price * 1.30).sort((a, b) => a - b)) {
    const last = clustered.at(-1);
    if (last && Math.abs(lvl - last) / last < 0.007) clustered[clustered.length - 1] = Math.max(last, lvl);
    else clustered.push(lvl);
  }
  return clustered.slice(0, 5);
}

async function getBtcRegime() {
  try {
    const raw = await requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, { contract: 'BTC_USDT', interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT });
    const candles = addIndicators(toClosedCandles(raw, 4 * 3600, Date.now() / 1000));
    if (candles.length < 210) return 'NEUTRAL';
    const l = candles.at(-1);
    if (l.close < l.ema50 && l.ema50 < l.ema200) return 'BEARISH';
    if (l.close > l.ema50 && l.ema50 > l.ema200) return 'BULLISH';
    return 'NEUTRAL';
  } catch (error) {
    console.warn('[BTC REGIME] Failed, assuming NEUTRAL:', error?.message || error);
    return 'NEUTRAL';
  }
}

/* ---------------- LONG ONLY ANALYZER ---------------- */
function analyzeLong(market, metrics, hourly, raw15m, raw4h, nowSeconds, marketRegime) {
  const btcBearish = marketRegime === 'BEARISH';
  if (btcBearish && CONFIG.LONG_MODE === 'STRICT') return reject('BTC_BEARISH_STRICT');

  const candles4h = addIndicators(toClosedCandles(raw4h, 4 * 3600, nowSeconds));
  const candles15 = addIndicators(toClosedCandles(raw15m, 15 * 60, nowSeconds));
  if (candles4h.length < 210 || candles15.length < 60) return reject('INSUFFICIENT_CANDLES');

  const l4 = candles4h.at(-1), l = candles15.at(-1), p = candles15.at(-2);
  const tickerPrice = num(market.ticker?.last);
  const price = positive(tickerPrice) ? tickerPrice : l.close;
  if (!positive(price) || !positive(l.atr) || !positive(l.ema20)) return reject('BAD_PRICE_OR_INDICATOR');
  if (Math.abs(price - l.close) / l.close > 0.025) return reject('PRICE_MOVED_AWAY_FROM_TRIGGER');

  const funding = num(market.contract?.funding_rate) ?? num(market.ticker?.funding_rate) ?? 0;

  if (!(l4.close > l4.ema50 && l4.ema50 > l4.ema200)) return reject('COIN_4H_TREND');
  if (l.rsi > CONFIG.MAX_RSI_ENTRY || l4.rsi > CONFIG.MAX_RSI_4H) return reject('RSI_OVERBOUGHT');
  if ((price - l.ema20) / l.ema20 * 100 > 4) return reject('PRICE_CHASING');
  if (funding > CONFIG.MAX_FUNDING_RATE) return reject('FUNDING_CROWDED');

  const prevWindow = candles15.slice(-41, -1);
  if (prevWindow.length < 20) return reject('INSUFFICIENT_15M_WINDOW');
  const support = Math.min(...prevWindow.map(c => c.low));
  const prevResistance = Math.max(...prevWindow.map(c => c.high));
  const recentSwingLow = Math.min(...candles15.slice(-21, -1).map(c => c.low));
  const atr = l.atr;

  const reasons = [];
  let setup = 'Pullback';

  // 1) Trend — 30
  let trendScore = 0;
  if (l4.close > l4.ema50) { trendScore += 10; reasons.push('روند 4H صعودی'); }
  if (l4.ema20 > l4.ema50 && l4.ema50 > l4.ema200) { trendScore += 10; reasons.push('چیدمان صعودی EMAها در 4H'); }
  if (l4.adx > 20) { trendScore += 10; reasons.push(`روند قوی ADX=${fmt(l4.adx, 0)}`); }

  // 2) Pullback / Breakout quality — 25
  let setupScore = 0;
  if ((price - support) / price * 100 < 2.5) { setupScore += 10; reasons.push('قیمت روی حمایت 15m'); }
  const sub = candles4h.slice(-90);
  let hiIdx = 0;
  sub.forEach((c, i) => { if (c.high > sub[hiIdx].high) hiIdx = i; });
  if (hiIdx > 5) {
    const swingHigh = sub[hiIdx].high;
    const swingLow = Math.min(...sub.slice(0, hiIdx + 1).map(c => c.low));
    if (swingHigh > swingLow) {
      const diff = swingHigh - swingLow;
      if (price <= swingHigh - diff * 0.382 && price >= swingHigh - diff * 0.618) {
        setupScore += 10; reasons.push('پولبک در ناحیه طلایی فیبوناچی 0.382-0.618');
      }
    }
  }
  if (l.bbLower != null && price <= l.bbMid && price >= l.bbLower) { setupScore += 5; reasons.push('اصلاح سالم تا میانه Bollinger'); }
  if (p.close <= prevResistance && l.close > prevResistance) {
    if ((l.close - prevResistance) / prevResistance * 100 > 2) return reject('LATE_BREAKOUT_CHASE');
    setupScore += 12; setup = 'Breakout'; reasons.push('شکست و تثبیت بالای مقاومت 15m');
  }
  setupScore = clamp(setupScore, 0, 25);

  // 3) Entry trigger — 25 — mandatory
  let triggerScore = 0, hasTrigger = false;
  if (p.macdHist < 0 && l.macdHist > 0) { triggerScore += 10; hasTrigger = true; reasons.push('کراس صعودی MACD در 15m'); }
  if (l.rsi >= 35 && l.rsi <= 55 && l.rsi > p.rsi) { triggerScore += 8; hasTrigger = true; reasons.push(`برگشت RSI از ${fmt(l.rsi, 0)}`); }
  if (isBullishEngulfing(candles15)) { triggerScore += 7; hasTrigger = true; reasons.push('کندل Engulfing صعودی'); }
  if (isHammer(candles15)) { triggerScore += 5; hasTrigger = true; reasons.push('کندل Hammer برگشتی'); }
  if (hasBullishDivergence(candles15)) { triggerScore += 8; hasTrigger = true; reasons.push('واگرایی مثبت RSI در 15m'); }
  if (!hasTrigger) return reject('NO_15M_TRIGGER');
  triggerScore = clamp(triggerScore, 0, 25);

  // 4) Volume / live buy pressure — 15
  let volumeScore = 0;
  const lastVolume = positive(l.quoteTurnover) ? l.quoteTurnover : l.volumeContracts;
  const volRatio = positive(l.volMa20) ? lastVolume / l.volMa20 : null;
  if (volRatio != null && volRatio >= 1.5) { volumeScore += 8; reasons.push(`حجم کندل ${fmt(volRatio, 1)}x میانگین`); }
  else if (volRatio != null && volRatio >= 1) { volumeScore += 4; reasons.push('حجم بالاتر از میانگین'); }
  if (metrics?.recentTotal > 0 && metrics.buyShareRecent >= 56 && metrics.deltaRecent > 0) { volumeScore += 5; reasons.push(`فشار خرید زنده ${fmt(metrics.buyShareRecent, 1)}٪ در ۳ دقیقه اخیر`); }
  else if (metrics?.recentTotal > 0 && metrics.buyShareRecent >= 53 && metrics.deltaRecent > 0) { volumeScore += 3; }
  if (hourly?.sellerPressureFalling) { volumeScore += 2; reasons.push('کاهش فشار فروش در کندل‌های 1H'); }
  if (funding < 0) { volumeScore += 2; reasons.push('فاندینگ منفی؛ پتانسیل Short Squeeze'); }
  volumeScore = clamp(volumeScore, 0, 15);

  // Stop Loss from structure + ATR
  let stopLoss = Math.min(support, recentSwingLow) - atr * 0.5;
  let risk = price - stopLoss;
  if (!positive(risk) || risk < atr * 0.8) { stopLoss = price - atr * 1.5; risk = price - stopLoss; }
  if (!positive(risk) || risk > atr * 5) return reject('BAD_RISK');

  // Ceilings from real swing resistances; fallback to RR levels
  const resistances = findResistanceLevels(candles15, candles4h, price).filter(x => x > price + risk);
  const tp1 = resistances[0] ?? price + risk * 1.5;
  const tp2 = resistances[1] ?? Math.max(price + risk * 2.5, tp1 + risk * 0.8);
  const tp3 = resistances[2] ?? Math.max(price + risk * 4, tp2 + risk);
  if (!(price < tp1 && tp1 < tp2 && tp2 < tp3)) return reject('BAD_TP_ORDER');

  const rr1 = (tp1 - price) / risk, rr2 = (tp2 - price) / risk;
  if (rr1 < CONFIG.MIN_RR_TP1 || rr2 < CONFIG.MIN_RR_TP2) return reject('LOW_RR');

  // در BTC نزولی فقط ستاپ واقعاً قوی قبول است
  if (btcBearish && (l4.adx < 25 || rr2 < 2.2)) return reject('BTC_BEARISH_WEAK_SETUP');

  let score = trendScore + setupScore + triggerScore + volumeScore;
  if (rr2 >= 2.5) { score += 5; reasons.push(`سود به ضرر عالی تا سقف۲: 1:${fmt(rr2, 1)}`); }
  else if (rr2 >= 2) score += 3;
  score = intScore(score);

  const minScore = btcBearish
    ? CONFIG.MIN_LONG_SCORE_BEARISH
    : marketRegime === 'NEUTRAL'
      ? CONFIG.MIN_LONG_SCORE_NEUTRAL
      : CONFIG.MIN_LONG_SCORE;

  if (score < minScore) {
    currentNearMisses.push({
      symbol: market.symbol,
      score,
      required: minScore,
      setup,
      price,
      rsi15: round(l.rsi, 1),
      rr2: round(rr2, 2),
      reasons: reasons.slice(0, 4),
    });
    return reject('SCORE_LOW');
  }

  return {
    symbol: market.symbol,
    contract: market.symbol,
    side: 'LONG',
    setup,
    score,
    rankScore: score,
    grade: score >= 85 ? 'A+' : score >= 75 ? 'A' : 'B',
    status: 'LONG_ENTRY',
    statusLabel: setup === 'Breakout' ? 'لانگ روی شکست مقاومت' : 'لانگ روی پولبک به حمایت',
    price,
    change24h: num(market.ticker.change_percentage),
    quoteVolume24h: num(market.ticker.volume_24h_quote),
    fundingRate: funding,
    riskNote: btcBearish ? 'BTC نزولی؛ فقط ستاپ استثنایی، با نصف حجم همیشگی' : null,
    entryLow: price * 0.998,
    entryHigh: price * 1.002,
    entry: { low: price * 0.998, high: price * 1.002, price },
    stopLoss,
    stopLossPct: round(pctFrom(price, stopLoss), 2),
    tp1, tp2, tp3,
    tp1Pct: round(pctFrom(price, tp1), 2),
    tp2Pct: round(pctFrom(price, tp2), 2),
    tp3Pct: round(pctFrom(price, tp3), 2),
    takeProfits: [
      { level: 1, price: tp1, pct: round(pctFrom(price, tp1), 2) },
      { level: 2, price: tp2, pct: round(pctFrom(price, tp2), 2) },
      { level: 3, price: tp3, pct: round(pctFrom(price, tp3), 2) },
    ],
    riskRewardToTp1: round(rr1, 2),
    riskRewardToTp2: round(rr2, 2),
    rr: round(rr2, 2),
    rsi15: round(l.rsi, 1),
    rsi4h: round(l4.rsi, 1),
    reasons,
    _sort: { score, rateMultiple: metrics?.rateMultiple ?? null, buyLast3: metrics?.buyLast3 ?? 0 },
  };
}

function analyzeMarket(market, trades, rawCandles, rawStats, rawCandles15, rawCandles4h, nowSeconds, marketRegime) {
  const multiplier = num(market.contract.quanto_multiplier);
  if (!positive(multiplier)) return { symbol: market.symbol, __error: 'quanto_multiplier نامعتبر است' };

  const hourStart = Math.floor(nowSeconds / 3600) * 3600;
  const metrics = aggregateCurrentTrades(trades, multiplier, hourStart, nowSeconds);
  const history = buildHourlyHistory(rawCandles, rawStats, multiplier, nowSeconds);
  const hourly = analyzeHourlyHistory(history);

  const long = analyzeLong(market, metrics, hourly, rawCandles15, rawCandles4h, nowSeconds, marketRegime);
  if (!long) return null;

  const hourlyCandles = hourly.candles.map(candle => ({
    time: new Date(candle.time * 1000).toISOString(), open: candle.open, close: candle.close,
    priceChangePct: round(candle.priceChangePct, 2), totalVolumeUSDT: round(candle.totalQuoteVolume, 2),
    buyVolumeUSDT: round(candle.buyQuoteVolume, 2), sellVolumeUSDT: round(candle.sellQuoteVolume, 2),
    buySharePct: round(candle.buySharePct, 1), deltaUSDT: round(candle.deltaQuote, 2),
    directionalDataAvailable: candle.hasDirectionalStats,
  }));

  return {
    ...long,
    currentHour: {
      buyNotionalSample: round(metrics.buyHour, 2), sellNotionalSample: round(metrics.sellHour, 2),
      buySharePct: round(metrics.buyShareHour, 1), netDeltaSample: round(metrics.deltaHour, 2),
      sampleCoveragePct: metrics.coveragePct, sampleTruncated: metrics.truncated, sampleTrades: metrics.validTrades,
    },
    recent3m: {
      buyNotional: round(metrics.buyLast3, 2), sellNotional: round(metrics.sellLast3, 2),
      buySharePct: round(metrics.buyShareRecent, 1), netDelta: round(metrics.deltaRecent, 2),
      buyNotionalPerMinute: round(metrics.buyRateLast, 2), previousBuyNotionalPerMinute: round(metrics.buyRatePrevious, 2),
      buyRateMultiple: round(metrics.rateMultiple, 2), buyAcceleration: round(metrics.acceleration, 2),
      baselineValid: metrics.validBaseline, persistencePct: round(metrics.persistence, 0), activeBuyMinutes: metrics.positiveBuyMinutes,
    },
    hourlyHistory: {
      available: hourly.available, priceTrend: hourly.priceTrend, priceChangePct: round(hourly.priceChangePct, 2),
      volumeTrend: hourly.volumeTrend, sellerPressure: hourly.sellerPressure,
      sellerPressureFalling: hourly.sellerPressureFalling, buyShareImproving: hourly.buyShareImproving,
      directionalCoveragePct: hourly.directionalCoverage, candles: hourlyCandles,
    },
    volume: {
      currentHour: {
        buyNotionalSample: round(metrics.buyHour, 2), sellNotionalSample: round(metrics.sellHour, 2),
        buySharePct: round(metrics.buyShareHour, 1), netDeltaSample: round(metrics.deltaHour, 2),
        sampleCoveragePct: metrics.coveragePct, sampleTruncated: metrics.truncated,
      },
      recent3m: {
        buyNotional: round(metrics.buyLast3, 2), sellNotional: round(metrics.sellLast3, 2),
        buySharePct: round(metrics.buyShareRecent, 1), netDelta: round(metrics.deltaRecent, 2),
        buyRateMultiple: round(metrics.rateMultiple, 2), persistencePct: round(metrics.persistence, 0),
      },
      hourlyHistory: {
        priceTrend: hourly.priceTrend, volumeTrend: hourly.volumeTrend, sellerPressure: hourly.sellerPressure,
        directionalCoveragePct: hourly.directionalCoverage, candles: hourlyCandles,
      },
    },
    tradesObserved: metrics.validTrades,
    dataQuality: {
      currentHour: metrics.truncated ? 'TRUNCATED_RECENT_TRADE_SAMPLE' : 'REST_TRADE_SAMPLE_COMPLETE_FOR_RETURNED_RANGE',
      hourlyDirectionalCoveragePct: hourly.directionalCoverage,
    },
  };
}

function rankCandidates(items) {
  return items.sort((a, b) =>
    (b.score - a.score) ||
    ((b._sort?.rateMultiple ?? -1) - (a._sort?.rateMultiple ?? -1)) ||
    ((b._sort?.buyLast3 || 0) - (a._sort?.buyLast3 || 0))
  ).map((item, index) => ({ ...item, rank: index + 1 }));
}

/* ---------------- Compact Telegram report ---------------- */
function reportLine(item, index) {
  const lines = [
    `${index + 1}. ${item.symbol} 🟢 LONG | ${item.score}/100 (${item.grade}) | ${item.setup}`,
    `ورود: ${fmtPrice(item.entryLow)} - ${fmtPrice(item.entryHigh)}`,
    `حد ضرر: ${fmtPrice(item.stopLoss)} (${signedPct(item.price, item.stopLoss)})`,
    `سقف‌ها: ${fmtPrice(item.tp1)} (${signedPct(item.price, item.tp1)}) | ${fmtPrice(item.tp2)} (${signedPct(item.price, item.tp2)}) | ${fmtPrice(item.tp3)} (${signedPct(item.price, item.tp3)})`,
    `RR تا سقف۲: 1:${fmt(item.riskRewardToTp2, 1)} | RSI 15m: ${fmt(item.rsi15, 0)}`,
    `دلیل: ${(item.reasons || []).slice(0, 3).join(' • ')}`,
  ];
  if (item.riskNote) lines.push(`⚠️ ${item.riskNote}`);
  return lines.join('\n');
}

function buildReport(output) {
  const btcText = output.marketRegime === 'BULLISH' ? 'صعودی ✅' : output.marketRegime === 'BEARISH' ? 'نزولی 🔴' : 'خنثی ⚠️';
  const lines = [
    '🚀 فرصت‌های لانگ Gate.io | USDT Perp',
    `BTC 4H: ${btcText} | حالت: ${CONFIG.LONG_MODE} | ${output.scannedAt}`,
    `بررسی: ${output.stats.scanned ?? output.stats.liquid} بازار از ${output.stats.liquid} بازار نقدشونده | ورود معتبر: ${output.stats.candidates}`,
    '━━━━━━━━━━━━━━━━━━',
  ];
  if (!output.candidates.length) {
    lines.push('در این اسکن نقطه ورود لانگ باکیفیتی پیدا نشد.');
  } else {
    output.candidates.forEach((item, index) => lines.push(reportLine(item, index), '━━━━━━━━━━━━━━━━━━'));
  }
  lines.push('خروج پله‌ای: ۴۰٪ سقف۱ + انتقال SL به ورود، ۴۰٪ سقف۲، ۲۰٪ سقف۳ | حد ضرر الزامی است.');
  return lines.join('\n');
}

function splitTelegramMessage(message) {
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    if ((current + '\n' + line).length > CONFIG.TELEGRAM_MAX_LENGTH && current) {
      chunks.push(current); current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Credentials missing; report printed locally only.');
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }
  const chunks = splitTelegramMessage(message);
  for (let index = 0; index < chunks.length; index++) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunks[index], disable_web_page_preview: true }),
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.description || `Telegram HTTP ${response.status} while sending part ${index + 1}/${chunks.length}`);
    }
    await sleep(250);
  }
  return { sent: true, parts: chunks.length };
}

async function getMarkets() {
  const [contracts, tickers] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/contracts`),
    requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);
  const tickerMap = new Map((tickers || []).map(ticker => [ticker.contract, ticker]));
  const active = (contracts || []).filter(contract =>
    typeof contract.name === 'string' && contract.name.endsWith('_USDT') &&
    contract.status === 'trading' && contract.in_delisting === false && positive(num(contract.quanto_multiplier))
  );
  const markets = active.map(contract => {
    const ticker = tickerMap.get(contract.name);
    const quoteVolume = num(ticker?.volume_24h_quote) ?? 0;
    return ticker && positive(num(ticker.last)) && quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
      ? { symbol: contract.name, contract, ticker, quoteVolume } : null;
  }).filter(Boolean).sort((a, b) => b.quoteVolume - a.quoteVolume);
  return { active, markets };
}

async function scanOneMarket(market, nowSeconds, marketRegime) {
  const hourStart = Math.floor(nowSeconds / 3600) * 3600;
  const historyStart = hourStart - CONFIG.HISTORY_HOURS * 3600;
  const [trades, candles, stats, candles15m, candles4h] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/trades`, { contract: market.symbol, from: hourStart, to: Math.floor(nowSeconds), limit: CONFIG.TRADE_LIMIT }),
    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, { contract: market.symbol, interval: '1h', limit: CONFIG.HISTORY_HOURS + 2 }),
    requestGate(`/futures/${CONFIG.SETTLE}/contract_stats`, { contract: market.symbol, from: historyStart, interval: '1h', limit: CONFIG.HISTORY_HOURS + 2 }),
    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, { contract: market.symbol, interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT }),
    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, { contract: market.symbol, interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT }),
  ]);
  return analyzeMarket(market, trades, candles, stats, candles15m, candles4h, nowSeconds, marketRegime);
}

export async function scanGateMarkets() {
  const started = Date.now();
  const nowSeconds = Date.now() / 1000;
  currentRejectStats = {};
  currentNearMisses = []; // FIXED: was {} which caused "is not iterable"

  console.log('\n🚀 GATE.IO LONG ONLY ENTRY RADAR');
  const { active, markets: liquidMarkets } = await getMarkets();
  const marketRegime = await getBtcRegime();

  const strictBearishSkip = marketRegime === 'BEARISH' && CONFIG.LONG_MODE === 'STRICT';
  const scanLimit = positive(CONFIG.SCAN_LIMIT) ? CONFIG.SCAN_LIMIT : liquidMarkets.length;
  const markets = strictBearishSkip ? [] : liquidMarkets.slice(0, scanLimit);
  if (strictBearishSkip) currentRejectStats.BTC_BEARISH_STRICT_SKIPPED = liquidMarkets.length;

  console.log(`Active contracts: ${active.length} | Liquid markets: ${liquidMarkets.length} | Scanning: ${markets.length} | BTC regime: ${marketRegime} | Mode: ${CONFIG.LONG_MODE}`);
  if (strictBearishSkip) console.log('[MODE] BTC BEARISH + STRICT mode => scan skipped to avoid API calls.');

  let completed = 0, success = 0, failed = 0;
  const results = await mapPool(markets, CONFIG.CONCURRENCY, async market => {
    const result = await scanOneMarket(market, nowSeconds, marketRegime);
    completed++; success++;
    if (completed % 25 === 0 || completed === markets.length) console.log(`[PROGRESS] ${completed}/${markets.length}`);
    return result;
  });

  const candidates = [];
  for (const item of results) {
    if (item?.__error) { failed++; continue; }
    if (item) candidates.push(item);
  }

  const rankedAll = rankCandidates(candidates);
  const ranked = rankedAll.slice(0, CONFIG.TOP_COUNT).map((item, index) => {
    const clean = { ...item, rank: index + 1 };
    delete clean._sort;
    return clean;
  });

  const nearMissesTop = [...currentNearMisses]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const output = {
    success: true, exchange: 'GATE.IO', market: 'USDT PERPETUAL',
    strategy: 'LONG ONLY: BTC FILTER + 4H TREND + 15M PULLBACK/BREAKOUT TRIGGER',
    marketRegime,
    longMode: CONFIG.LONG_MODE,
    scannedAt: new Date().toISOString(),
    stats: {
      active: active.length, liquid: liquidMarkets.length, scanned: markets.length,
      success, failed, candidates: candidates.length, durationMs: Date.now() - started,
    },
    filterStats: { ...currentRejectStats },
    nearMisses: nearMissesTop,
    candidates: ranked, rankedCandidates: ranked,
  };

  try {
    const stored = await saveMarketSnapshot(rankedAll.map(item => { const copy = { ...item }; delete copy._sort; return copy; }));
    output.historyCount = stored?.historyCount ?? 0;
    output.summaryCount = stored?.summaryCount ?? rankedAll.length;
    output.rankChanges = stored?.rankChanges ?? {};
  } catch (error) {
    console.error('[STORAGE] Snapshot save failed; scan result is still available:', error?.stack || error?.message || error);
  }

  console.log('[FILTER STATS]', JSON.stringify(currentRejectStats));
  if (nearMissesTop.length) {
    console.log('[NEAR MISSES]', JSON.stringify(nearMissesTop, null, 2));
  } else {
    console.log('[NEAR MISSES] []');
  }

  const report = buildReport(output);
  console.log(report);
  console.log(`\nFinished in ${(output.stats.durationMs / 1000).toFixed(1)}s | scanned ${markets.length} | success ${success} | failed ${failed}`);

  // Telegram is kept, but an empty list is not spammed because TELEGRAM_SEND_EMPTY=false is hard-coded
  try {
    if (!ranked.length && !CONFIG.TELEGRAM_SEND_EMPTY) {
      output.telegram = { sent: false, reason: 'NO_LONG_CANDIDATES_SKIPPED' };
      console.log('[TELEGRAM] No long entry; empty report skipped.');
    } else {
      const telegramResult = await sendTelegram(report);
      console.log('[TELEGRAM RESULT]', JSON.stringify(telegramResult));
      output.telegram = telegramResult;
    }
  } catch (error) {
    console.error('[TELEGRAM DELIVERY ERROR] Scan completed, but notification failed:', error?.stack || error?.message || error);
    output.telegram = { sent: false, reason: error?.message || String(error) };
  }
  return output;
}

// src/index.js imports this module to start the scanner.
try {
  const result = await scanGateMarkets();
  console.log('[SCANNER RESULT]', JSON.stringify({
    success: result.success, active: result.stats.active, liquid: result.stats.liquid, scanned: result.stats.scanned,
    successful: result.stats.success, failed: result.stats.failed,
    candidates: result.stats.candidates, durationMs: result.stats.durationMs,
    filterStats: result.filterStats,
    nearMisses: result.nearMisses,
    telegramSent: result.telegram?.sent ?? false,
  }, null, 2));
} catch (error) {
  console.error('[SCANNER FATAL ERROR]', error?.stack || error);
  process.exitCode = 1;
}
