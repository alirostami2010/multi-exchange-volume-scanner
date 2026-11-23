/**
 * GATE.IO USDT PERPETUAL — EARLY BULLISH TRANSITION RADAR
 * -----------------------------------------------------------------
 * ONE ENGINE ONLY. No Motor 2.
 * - Closed 1h candles only.
 * - Implements five H1 bullish methods adapted from the referenced article.
 * - Uses closed candles only; no volume and no BTC comparison.
 * - Detects early setups, not trade entries or guaranteed predictions.
 * - Rejects late/extended moves and weak one-candle spikes.
 * - No entry, trade signal, or price target.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1h',
  CANDLE_SECONDS: 3600,
  CANDLE_PAGE_SIZE: 2000,
  // 360 closed hourly candles (~15 days) are sufficient for early structure
  // and keep the scan to roughly one candle-history request per market.
  MAX_RECENT_CANDLES: 360,
  MIN_CANDLES: 100,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  CONCURRENCY: 5,
  REQUEST_TIMEOUT: 45000,
  RETRIES: 6,
  MARKET_HISTORY_RETRIES: 2,
  REQUEST_SPACING_MS: 180,
  MAX_RETRY_DELAY_MS: 60000,
  MAX_RESULTS: 10,
  PAGE_PAUSE_MS: 0,

  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,

  // Candidate context windows, all measured in CLOSED 1h candles.
  MIN_BASE_HOURS: 24,
  MAX_BASE_HOURS: 120,
  ACTIVATION_HOURS: 6,
  SETUP_HOURS: 18,
  MAX_BASE_RANGE_PCT: 10.0,
  MAX_BASE_SLOPE_ABS: 0.075,
  MAX_RECENT_DOWNSLOPE: -0.020,
  MAX_ADVANCE_FROM_BASE_LOW_PCT: 6.0,
  MAX_RECENT_12H_RISE_PCT: 3.8,
  MAX_RECENT_6H_RISE_PCT: 2.4,
  MAX_LATEST_CANDLE_RANGE_PCT: 3.8,
  MIN_BULLISH_SCORE: 48,
  EMA_FAST: 50,
  EMA_SLOW: 200,
  RSI_PERIOD: 14,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + CONFIG.REQUEST_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

function isRetryableError(error) {
  const status = Number(error?.status || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

function retryDelay(error, attempt) {
  if (Number(error?.status) === 429) {
    const retryAfter = Number(error?.retryAfterSeconds || 0) * 1000;
    if (retryAfter > 0) return Math.min(retryAfter, CONFIG.MAX_RETRY_DELAY_MS);
  }
  const base = Number(error?.status) >= 500 ? 2500 : 1500;
  return Math.min(base * (2 ** (attempt - 1)), CONFIG.MAX_RETRY_DELAY_MS);
}

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pct = (current, previous) => previous > 0 ? (current / previous - 1) * 100 : 0;
const safeDiv = (a, b, fallback = 0) => Math.abs(b) > Number.EPSILON ? a / b : fallback;
const candleRangePct = (c) => c.close > 0 ? ((c.high - c.low) / c.close) * 100 : 0;

async function fetchJSON(url) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      await waitForRequestSlot();
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 240);
        const error = new Error(`Gate.io HTTP ${response.status}: ${body}`);
        error.status = response.status;
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) error.retryAfterSeconds = Number(retryAfter) || 0;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= CONFIG.RETRIES || !isRetryableError(error)) break;
      const delay = retryDelay(error, attempt);
      console.warn(`[API RETRY ${attempt}/${CONFIG.RETRIES - 1}] ${error.status ? `HTTP ${error.status}` : error.name || 'Network'}; waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function getContracts() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contracts`);
}

function isSupportedCryptoContract(contract) {
  const name = String(contract?.name ?? '').trim().toUpperCase();
  const classification = String(contract?.contract_type ?? '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  const active = String(contract?.status ?? '').toLowerCase() === 'trading' &&
    contract?.in_delisting !== true;
  const validName = /^[A-Z0-9]{2,30}_USDT$/.test(name);
  if (!active || !validName) return false;
  if (!classification) return true;
  return CONFIG.ALLOWED_CRYPTO_CONTRACT_TYPES.has(classification);
}

function normalizeCandle(item) {
  return {
    time: num(item.t),
    open: num(item.o),
    high: num(item.h),
    low: num(item.l),
    close: num(item.c),
  };
}

function isValidCandle(c) {
  return c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
    c.high >= c.low && c.high >= c.open && c.high >= c.close &&
    c.low <= c.open && c.low <= c.close;
}

async function getClosedHourlyCandles(contract) {
  const currentBucket = Math.floor((Date.now() / 1000) / CONFIG.CANDLE_SECONDS) * CONFIG.CANDLE_SECONDS;
  const oldestAllowed = currentBucket - (CONFIG.MAX_RECENT_CANDLES * CONFIG.CANDLE_SECONDS);
  const byTime = new Map();
  let pageEnd = currentBucket - 1;
  let pageCount = 0;
  let oldestSeen = Infinity;

  while (pageEnd >= oldestAllowed) {
    const pageStart = Math.max(
      oldestAllowed,
      pageEnd - ((CONFIG.CANDLE_PAGE_SIZE - 1) * CONFIG.CANDLE_SECONDS),
    );
    const params = new URLSearchParams({
      contract,
      interval: CONFIG.TIMEFRAME,
      from: String(pageStart),
      to: String(pageEnd),
    });
    const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
    if (!Array.isArray(raw)) throw new Error(`Invalid hourly candles: ${contract}`);
    if (raw.length === 0) break;

    const page = raw.map(normalizeCandle).filter((c) =>
      isValidCandle(c) && c.time < currentBucket &&
      c.time >= oldestAllowed && c.time <= pageEnd
    );
    if (page.length === 0) break;

    let pageOldest = Infinity;
    for (const candle of page) {
      byTime.set(candle.time, candle);
      if (candle.time < pageOldest) pageOldest = candle.time;
    }
    if (!Number.isFinite(pageOldest) || pageOldest >= oldestSeen) break;
    oldestSeen = pageOldest;
    pageEnd = pageOldest - 1;
    pageCount++;
    if (pageEnd < oldestAllowed) break;

    if (CONFIG.PAGE_PAUSE_MS > 0) await sleep(CONFIG.PAGE_PAUSE_MS);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, pages: pageCount };
}

async function getClosedHourlyCandlesWithRetry(contract) {
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.MARKET_HISTORY_RETRIES; attempt++) {
    try {
      return await getClosedHourlyCandles(contract);
    } catch (error) {
      lastError = error;
      if (attempt >= CONFIG.MARKET_HISTORY_RETRIES || !isRetryableError(error)) break;
      const delay = Math.min(3000 * (2 ** attempt), CONFIG.MAX_RETRY_DELAY_MS);
      console.warn(`[HISTORY RETRY] ${contract} attempt ${attempt + 1}/${CONFIG.MARKET_HISTORY_RETRIES}; ${error.message}; waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function errorSummary(error) {
  const message = String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
  return message.slice(0, 300);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function candleFacts(c) {
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const body = c.close - c.open;
  return {
    bullish: body > 0,
    bearish: body < 0,
    bodyRatio: body / range,
    closePosition: clamp((c.close - c.low) / range, 0, 1),
    lowerWick: clamp((Math.min(c.open, c.close) - c.low) / range, 0, 1),
    upperWick: clamp((c.high - Math.max(c.open, c.close)) / range, 0, 1),
    rangePct: candleRangePct(c),
  };
}

function directionalPressure(candles) {
  return mean(candles.map((c) => {
    const f = candleFacts(c);
    return (f.bodyRatio * 0.55) + ((f.closePosition - 0.5) * 0.9);
  }));
}

function linearRegressionSlope(values) {
  if (values.length < 3) return 0;
  const logs = values.map((v) => Math.log(Math.max(v, Number.EPSILON)));
  const n = logs.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(logs);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (logs[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator ? (numerator / denominator) * 100 : 0;
}

function findPivots(candles, left = CONFIG.PIVOT_LEFT, right = CONFIG.PIVOT_RIGHT) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: c.high, time: c.time });
    if (isLow) lows.push({ index: i, price: c.low, time: c.time });
  }
  return { highs, lows };
}

function structuralDirection(pivots) {
  const highs = pivots.highs.slice(-5);
  const lows = pivots.lows.slice(-5);
  const highUp = highs.length >= 2 ? highs.slice(1).filter((p, i) => p.price > highs[i].price).length : 0;
  const highDown = highs.length >= 2 ? highs.slice(1).filter((p, i) => p.price < highs[i].price).length : 0;
  const lowUp = lows.length >= 2 ? lows.slice(1).filter((p, i) => p.price > lows[i].price).length : 0;
  const lowDown = lows.length >= 2 ? lows.slice(1).filter((p, i) => p.price < lows[i].price).length : 0;
  const bullish = highUp + lowUp;
  const bearish = highDown + lowDown;
  let direction = 'MIXED';
  if (bullish >= bearish + 2) direction = 'UP';
  else if (bearish >= bullish + 2) direction = 'DOWN';
  else if (bullish === 0 && bearish === 0) direction = 'UNCONFIRMED';
  return { direction, highUp, highDown, lowUp, lowDown, bullishSteps: bullish, bearishSteps: bearish };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rangePct(candles) {
  if (!candles.length) return 0;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const reference = mean(candles.map((c) => c.close));
  return reference > 0 ? ((high - low) / reference) * 100 : 0;
}

function summarizeCandleBehavior(candles) {
  if (!candles.length) return null;
  const facts = candles.map(candleFacts);
  const closes = candles.map((c) => c.close);
  const pivots = findPivots(candles);
  const structure = structuralDirection(pivots);
  const slope = linearRegressionSlope(closes);
  const bullish = facts.filter((f) => f.bullish).length;
  const bearish = facts.filter((f) => f.bearish).length;
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  return {
    slope, structure, pivots, bullish, bearish,
    closePosition: mean(facts.map((f) => f.closePosition)),
    lowerWick: mean(facts.map((f) => f.lowerWick)),
    upperWick: mean(facts.map((f) => f.upperWick)),
    low, high,
    returnPct: pct(candles.at(-1).close, candles[0].open),
    rangePct: rangePct(candles),
    closeFromLowPct: pct(candles.at(-1).close, low),
    rangePosition: clamp(safeDiv(candles.at(-1).close - low, high - low, 0.5), 0, 1),
    pressure: directionalPressure(candles),
  };
}

function countHigherSteps(points, field = 'price', tolerance = 0.001) {
  if (points.length < 2) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][field] > points[i - 1][field] * (1 + tolerance)) count++;
  }
  return count;
}

function countLowerSteps(points, field = 'price', tolerance = 0.001) {
  if (points.length < 2) return 0;
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][field] < points[i - 1][field] * (1 - tolerance)) count++;
  }
  return count;
}

function downsidePressure(candles) {
  if (!candles.length) return 0;
  return mean(candles.map((c) => {
    const f = candleFacts(c);
    return f.bearish ? Math.abs(f.bodyRatio) * (1.2 - f.closePosition) : 0;
  }));
}

function analyzeWindow(candles, baseLength) {
  const activationLength = CONFIG.ACTIVATION_HOURS;
  const setupLength = CONFIG.SETUP_HOURS;
  const baseEnd = candles.length - activationLength;
  const baseStart = baseEnd - baseLength;
  if (baseStart < setupLength + 12) return null;

  const base = candles.slice(baseStart, baseEnd);
  const recent = candles.slice(baseEnd);
  const setup = candles.slice(baseStart - setupLength, baseStart);
  const older = candles.slice(Math.max(0, baseStart - setupLength - 24), baseStart - setupLength);
  if (base.length < CONFIG.MIN_BASE_HOURS || recent.length !== activationLength || setup.length !== setupLength || older.length < 12) return null;

  const baseStats = summarizeCandleBehavior(base);
  const setupStats = summarizeCandleBehavior(setup);
  const olderStats = summarizeCandleBehavior(older);
  const recentStats = summarizeCandleBehavior(recent);
  const last = candles.at(-1);
  const baseHigh = Math.max(...base.map(c => c.high));
  const baseLow = Math.min(...base.map(c => c.low));
  const riseFromBaseLowPct = pct(last.close, baseLow);
  const recent6hRisePct = pct(last.close, candles.at(-7).close);
  const recent12hRisePct = pct(last.close, candles.at(-13).close);
  const recent18hRisePct = pct(last.close, candles.at(-19).close);

  const basePivots = findPivots(base);
  const recentPivots = findPivots(candles.slice(-30));
  const baseLows = basePivots.lows.slice(-6);
  const recentLows = recentPivots.lows.slice(-4);
  const higherLows = countHigherSteps(baseLows);
  const lowerLows = countLowerSteps(baseLows);
  const recentHigherLows = countHigherSteps(recentLows);
  const recentLowerLows = countLowerSteps(recentLows);

  const baseCompressed = baseStats.rangePct <= CONFIG.MAX_BASE_RANGE_PCT &&
    Math.abs(baseStats.slope) <= CONFIG.MAX_BASE_SLOPE_ABS;
  const recentRange = rangePct(recent);
  const setupRange = rangePct(setup);
  const volatilityContracting = recentRange <= setupRange * 1.12 || baseRangeContraction(base);

  const pressureImprovement = directionalPressure(recent) - directionalPressure(setup);
  const sellerPressureChange = downsidePressure(recent) - downsidePressure(setup);
  const sellerExhaustion = sellerPressureChange <= 0.015 ||
    (recentStats.lowerWick >= setupStats.lowerWick + 0.025 && recentLowerLows === 0);

  const recentBullish = recent.filter(c => c.close > c.open).length;
  const recentBearish = recent.filter(c => c.close < c.open).length;
  const recentClosePosition = mean(recent.map(c => candleFacts(c).closePosition));
  const recentBodyStrength = mean(recent.map(c => candleFacts(c).bodyRatio));
  const greenBody = mean(recent.filter(c => c.close > c.open).map(c => (c.close-c.open)/Math.max(c.high-c.low, Number.EPSILON)));
  const redBody = mean(recent.filter(c => c.close < c.open).map(c => Math.abs(c.close-c.open)/Math.max(c.high-c.low, Number.EPSILON)));
  const bullishCandleQuality = recentClosePosition >= 0.53 &&
    (greenBody >= redBody * 0.85 || recentBullish > recentBearish);

  const noFreshLow = Math.min(...recent.map(c => c.low)) >= baseLow * 0.985;
  const lowsStabilizing = recentLowerLows === 0 &&
    (higherLows >= 1 || recentHigherLows >= 1 || noFreshLow);
  const closeAboveShortBase = last.close > mean(base.slice(-8).map(c => c.close));
  const localHigh = Math.max(...candles.slice(-18, -6).map(c => c.high));
  const earlyReclaim = last.close > localHigh * 0.992;
  const buyersImproving = (pressureImprovement >= 0.015 && recentClosePosition >= 0.52) ||
    (recentBullish >= 3 && recentClosePosition >= 0.57 && recentBodyStrength > -0.02);
  const structureTurning = lowsStabilizing && (closeAboveShortBase || earlyReclaim);

  const priorSlope = olderStats.slope;
  let context = 'SIDEWAYS_BASE';
  if (priorSlope < -0.045) context = 'DOWNTREND_EXHAUSTION';
  else if (priorSlope > 0.045) context = 'UPTREND_PULLBACK';

  const priceNotExtended = riseFromBaseLowPct <= CONFIG.MAX_ADVANCE_FROM_BASE_LOW_PCT &&
    recent12hRisePct <= CONFIG.MAX_RECENT_12H_RISE_PCT &&
    recent6hRisePct <= CONFIG.MAX_RECENT_6H_RISE_PCT &&
    candleRangePct(last) <= CONFIG.MAX_LATEST_CANDLE_RANGE_PCT;
  const notActivelyFalling = recentStats.slope >= CONFIG.MAX_RECENT_DOWNSLOPE &&
    !(recentLowerLows >= 2 && recentStats.slope < -0.015);
  const notAlreadyBrokenOut = last.close <= baseHigh * 1.012 && recent18hRisePct <= 5.0;

  // Continuous scoring prevents the old saturation problem (many assets at 98/100).
  const scoreParts = {
    sellerFading: clamp((0.035 - sellerPressureChange) / 0.10, 0, 1) * 18,
    buyerPressure: clamp((pressureImprovement + 0.015) / 0.10, 0, 1) * 20,
    candleQuality: clamp((recentClosePosition - 0.42) / 0.38, 0, 1) * 12,
    lowStability: (higherLows > 0 ? 7 : 0) + (recentHigherLows > 0 ? 5 : 0) + (noFreshLow ? 5 : 0),
    structureRecovery: (closeAboveShortBase ? 7 : 0) + (earlyReclaim ? 6 : 0),
    volatility: (baseCompressed ? 6 : 0) + (volatilityContracting ? 5 : 0),
    freshness: priceNotExtended ? 9 : 0,
    downsidePenalty: Math.min(18, lowerLows * 3 + recentLowerLows * 4),
    extensionPenalty: Math.max(0, riseFromBaseLowPct - 4) * 2 + Math.max(0, recent12hRisePct - 2.5) * 2,
  };
  let score = scoreParts.sellerFading + scoreParts.buyerPressure + scoreParts.candleQuality +
    scoreParts.lowStability + scoreParts.structureRecovery + scoreParts.volatility +
    scoreParts.freshness - scoreParts.downsidePenalty - scoreParts.extensionPenalty;
  score = Math.round(clamp(score, 0, 100));

  const qualifies = score >= CONFIG.MIN_BULLISH_SCORE && sellerExhaustion &&
    buyersImproving && bullishCandleQuality && structureTurning && priceNotExtended &&
    notActivelyFalling && notAlreadyBrokenOut && (baseCompressed || volatilityContracting) &&
    (noFreshLow || higherLows > 0 || recentHigherLows > 0);

  return {
    qualifies, score, context,
    metrics: {
      baseHours: base.length, baseRangePct: baseStats.rangePct,
      baseSlope: baseStats.slope, priorSlope, recentSlope: recentStats.slope,
      pressureImprovement, sellerPressureChange, sellerExhaustion, buyersImproving,
      bullishCandleQuality, higherLows, recentHigherLows, lowerLows, recentLowerLows,
      noFreshLow, lowsStabilizing, closeAboveShortBase, earlyReclaim, structureTurning,
      volatilityContracting, priceNotExtended, riseFromBaseLowPct,
      recent6hRisePct, recent12hRisePct, recent18hRisePct,
      recentBullish, recentBearish, recentClosePosition, scoreParts,
    },
  };
}

function baseRangeContraction(candles) {
  if (candles.length < 24) return false;
  const split = Math.floor(candles.length / 2);
  const first = rangePct(candles.slice(0, split));
  const second = rangePct(candles.slice(split));
  return second < first * 0.88;
}

function calculateEMA(values, period) {
  if (values.length < period) return [];
  const out = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let seed = mean(values.slice(0, period));
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    seed = (values[i] - seed) * multiplier + seed;
    out[i] = seed;
  }
  return out;
}

function calculateRSI(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const value = () => avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

function evaluateArticleStrategies(candles) {
  const closes = candles.map(c => c.close);
  const ema50 = calculateEMA(closes, CONFIG.EMA_FAST);
  const ema200 = calculateEMA(closes, CONFIG.EMA_SLOW);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const i = candles.length - 1;
  const last = candles[i];
  const prev = candles[i - 1];
  const facts = candleFacts(last);
  const rsiNow = rsi[i];
  const rsiPrev = rsi[i - 1];
  const strategies = [];
  const details = {};

  if (ema50[i] == null || ema200[i] == null || rsiNow == null || rsiPrev == null) {
    return { strategies, details, indicatorsReady: false };
  }

  const trendUp = ema50[i] > ema200[i] && last.close > ema200[i];
  const ema50Distance = Math.abs(pct(last.close, ema50[i]));
  const ema200Distance = Math.abs(pct(last.close, ema200[i]));
  const ema200Rising = ema200[i] > ema200[i - 12];
  const rsiRising = rsiNow > rsiPrev && rsiPrev >= rsi[i - 3];
  const notExtended = pct(last.close, candles.at(-13).close) <= 5.5 &&
    pct(last.close, candles.at(-7).close) <= 3.5 && facts.rangePct <= 4.5;
  const recent = candles.slice(-12);
  const recentBullish = recent.filter(c => c.close > c.open).length;
  const buyerCandle = facts.closePosition >= 0.58 &&
    (facts.bullish || facts.lowerWick >= 0.35) &&
    (last.close > prev.close || facts.lowerWick >= 0.48);

  // 1) Trend following: established EMA trend, controlled pullback to EMA50,
  // then a closed-candle recovery. Avoid chasing a stretched move.
  const trendPullback = trendUp && ema50Distance <= 2.0 &&
    last.low <= ema50[i] * 1.018 && last.close >= ema50[i] * 0.995 &&
    rsiNow >= 42 && rsiNow <= 66 && rsiRising && buyerCandle && notExtended;
  if (trendPullback) strategies.push('TREND_PULLBACK');
  details.trendPullback = trendPullback;

  // 2) Range breakout + retest: a recent closed breakout followed by a retest
  // that holds the former ceiling. The breakout itself must be recent.
  let rangeBreakoutRetest = false;
  let rangeLevel = 0;
  for (let lookback = 1; lookback <= 8 && !rangeBreakoutRetest; lookback++) {
    const breakoutIndex = i - lookback;
    const rangeStart = Math.max(0, breakoutIndex - 48);
    const priorRange = candles.slice(rangeStart, breakoutIndex);
    if (priorRange.length < 24) continue;
    const ceiling = Math.max(...priorRange.map(c => c.high));
    const floor = Math.min(...priorRange.map(c => c.low));
    const width = pct(ceiling, floor);
    const breakout = candles[breakoutIndex];
    const hadBreakout = breakout.close > ceiling * 1.002;
    const heldRetest = last.low <= ceiling * 1.012 && last.close >= ceiling * 0.998;
    if (width <= 12 && hadBreakout && heldRetest && rsiNow >= 48 && rsiNow < 72 && buyerCandle && notExtended) {
      rangeBreakoutRetest = true;
      rangeLevel = ceiling;
    }
  }
  if (rangeBreakoutRetest) strategies.push('RANGE_BREAKOUT_RETEST');
  details.rangeBreakoutRetest = rangeBreakoutRetest;
  details.rangeLevel = rangeLevel;

  // 3) RSI oversold near a confirmed local support, with RSI turning upward.
  const supportPivots = findPivots(candles.slice(-100)).lows;
  const supports = supportPivots.map(p => p.price).filter(price => price <= last.close * 1.025);
  const support = supports.length ? supports.at(-1) : 0;
  const nearSupport = support > 0 && Math.abs(pct(last.close, support)) <= 2.0;
  const oversoldTurn = rsiNow >= 28 && rsiNow <= 42 && rsiRising &&
    (rsi.slice(-4).some(v => v != null && v < 32) || rsiNow <= 35);
  const rsiSupportBounce = nearSupport && oversoldTurn && buyerCandle && notExtended;
  if (rsiSupportBounce) strategies.push('RSI_SUPPORT_BOUNCE');
  details.rsiSupportBounce = rsiSupportBounce;
  details.support = support;

  // 4) Liquidity sweep / false breakdown: a closed candle pierces a prior
  // confirmed swing low then closes back above it with a rejection wick.
  const recentPivotLow = findPivots(candles.slice(-45, -3)).lows.at(-1);
  let liquiditySweep = false;
  let sweepLevel = 0;
  if (recentPivotLow) {
    const level = recentPivotLow.price;
    const swept = last.low < level * 0.998 && last.low >= level * 0.975;
    const reclaimed = last.close > level * 1.001;
    liquiditySweep = swept && reclaimed && facts.lowerWick >= 0.30 &&
      facts.closePosition >= 0.62 && rsiRising && rsiNow < 68 && notExtended;
    if (liquiditySweep) sweepLevel = level;
  }
  if (liquiditySweep) strategies.push('LIQUIDITY_SWEEP_RECLAIM');
  details.liquiditySweep = liquiditySweep;
  details.sweepLevel = sweepLevel;

  // 5) EMA200 trend filter + RSI 40-50 pullback/recovery.
  const ema200RsiPullback = trendUp && ema200Rising && ema200Distance <= 8 &&
    rsiNow >= 40 && rsiNow <= 52 && rsiRising &&
    (ema50Distance <= 3.0 || last.low <= ema50[i] * 1.025) &&
    buyerCandle && notExtended;
  if (ema200RsiPullback) strategies.push('EMA200_RSI_PULLBACK');
  details.ema200RsiPullback = ema200RsiPullback;

  details.ema50 = ema50[i];
  details.ema200 = ema200[i];
  details.rsi = rsiNow;
  details.trendUp = trendUp;
  details.ema200Rising = ema200Rising;
  details.rsiRising = rsiRising;
  details.notExtended = notExtended;
  details.recentBullish = recentBullish;
  return { strategies, details, indicatorsReady: true };
}

function analyzeTrend(symbol, candles, pageCount) {
  if (!Array.isArray(candles) || candles.length < Math.max(CONFIG.MIN_CANDLES, CONFIG.EMA_SLOW + 20)) return null;

  const article = evaluateArticleStrategies(candles);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const recent = candles.slice(-18);
  const base = candles.slice(-54, -6);
  const baseHigh = Math.max(...base.map(c => c.high));
  const baseLow = Math.min(...base.map(c => c.low));
  const riseFromBaseLowPct = pct(last.close, baseLow);
  const recent6hRisePct = pct(last.close, candles.at(-7).close);
  const recent12hRisePct = pct(last.close, candles.at(-13).close);
  const recent18hRisePct = pct(last.close, candles.at(-19).close);
  const pressureImprovement = directionalPressure(recent) - directionalPressure(candles.slice(-36, -18));
  const sellerPressureChange = downsidePressure(recent) - downsidePressure(candles.slice(-36, -18));
  const pivots = findPivots(candles.slice(-100));
  const higherLows = countHigherSteps(pivots.lows.slice(-5));
  const baseRangePct = rangePct(base);
  const freshness = riseFromBaseLowPct <= 7.0 && recent6hRisePct <= 3.5 &&
    recent12hRisePct <= 5.0 && candleRangePct(last) <= 4.5;
  const methods = article.strategies;
  const methodCount = methods.length;
  const candleConfirmation = candleFacts(last).closePosition >= 0.55 &&
    (last.close > last.open || last.close > prev.close);

  // A method can qualify alone, but weak/late setups are filtered. Confluence
  // increases rank; score is a ranking index, not a probability percentage.
  const qualifies = article.indicatorsReady && methodCount > 0 && freshness && candleConfirmation;
  const score = Math.round(clamp(
    43 + methodCount * 13 + (pressureImprovement > 0.025 ? 7 : 0) +
    (sellerPressureChange < 0 ? 5 : 0) + (higherLows > 0 ? 4 : 0) +
    (article.details.trendUp ? 3 : 0) - Math.max(0, riseFromBaseLowPct - 4) * 1.5,
    0, 96,
  ));

  const labels = {
    TREND_PULLBACK: 'پولبک در روند صعودی (EMA50/EMA200)',
    RANGE_BREAKOUT_RETEST: 'شکست محدوده و تثبیت روی مقاومت شکسته‌شده',
    RSI_SUPPORT_BOUNCE: 'برگشت RSI از ناحیه اشباع فروش در حمایت',
    LIQUIDITY_SWEEP_RECLAIM: 'جمع‌آوری نقدینگی و بازپس‌گیری کف قبلی',
    EMA200_RSI_PULLBACK: 'پایان پولبک با فیلتر EMA200 و RSI',
  };
  const strategyLabels = methods.map(key => labels[key]);
  const primaryMethod = methods[0] || 'NONE';
  const phase = primaryMethod === 'TREND_PULLBACK' || primaryMethod === 'EMA200_RSI_PULLBACK'
    ? 'UPTREND_PULLBACK'
    : primaryMethod === 'RANGE_BREAKOUT_RETEST'
      ? 'RANGE_BREAKOUT_RETEST'
      : primaryMethod === 'LIQUIDITY_SWEEP_RECLAIM'
        ? 'LIQUIDITY_SWEEP_RECLAIM'
        : primaryMethod === 'RSI_SUPPORT_BOUNCE' ? 'SUPPORT_REVERSAL' : 'NONE';

  return {
    symbol,
    bullishCandidate: qualifies,
    bullishScore: qualifies ? score : 0,
    currentPhase: phase,
    currentPhaseLabel: strategyLabels.join(' + '),
    strategies: methods,
    metrics: {
      candlesAvailable: candles.length, historyPages: pageCount,
      baseHours: base.length, baseRangePct,
      pressureImprovement, sellerPressureChange, higherLows,
      riseFromBaseLowPct, recent6hRisePct, recent12hRisePct, recent18hRisePct,
      rsi: article.details.rsi,
      ema50: article.details.ema50,
      ema200: article.details.ema200,
      trendUp: article.details.trendUp,
      strategyCount: methodCount,
      strategyLabels,
      rangeLevel: article.details.rangeLevel,
      support: article.details.support,
      sweepLevel: article.details.sweepLevel,
      freshness,
    },
  };
}

async function sendTelegram(lines) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram HTTP ${response.status}`);
  }
}

function formatTelegramCandidate(item, index) {
  const name = item.symbol.replace(/_USDT$/, '');
  const m = item.metrics;
  return [
    `${index + 1} — ${name} | امتیاز احتمال پیش‌صعود: ${item.bullishScore}/100`,
    `روش شناسایی: ${item.currentPhaseLabel}`,
    `RSI(14): ${m.rsi.toFixed(1)} | EMA50: ${m.ema50.toPrecision(7)} | EMA200: ${m.ema200.toPrecision(7)}`,
    `تعداد روش‌های هم‌زمان: ${m.strategyCount} | روند EMA صعودی: ${m.trendUp ? 'بله' : 'خیر'}`,
    `رشد از کف بازه: ${m.riseFromBaseLowPct.toFixed(2)}% | رشد ۶ساعت: ${m.recent6hRisePct.toFixed(2)}% | رشد ۱۲ساعت: ${m.recent12hRisePct.toFixed(2)}%`,
  ].join('\n');
}
async function main() {
  console.log('\nGATE.IO | ONE-HOUR EARLY BULLISH TRANSITION ENGINE 1');
  console.log('Closed 1h candles only | five H1 strategy patterns | no volume | no BTC comparison');
  console.log('Target: detect early bullish setups before the main expansion; not entry signals');
  console.log('Methods: EMA trend pullback | range breakout-retest | RSI support bounce | liquidity sweep | EMA200+RSI pullback');

  const contracts = await getContracts();
  if (!Array.isArray(contracts)) throw new Error('داده قراردادهای Gate.io معتبر نیست.');
  const namedContracts = contracts.filter((c) => c?.name);
  const cryptoContracts = namedContracts.filter(isSupportedCryptoContract);
  const markets = cryptoContracts.map((c) => c.name).sort();

  let checked = 0;
  let failed = 0;
  let insufficient = 0;
  let totalCandles = 0;
  let totalPages = 0;

  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (symbol) => {
    const history = await getClosedHourlyCandlesWithRetry(symbol);
    if (history.candles.length < CONFIG.MIN_CANDLES) {
      insufficient++;
      return null;
    }
    checked++;
    totalCandles += history.candles.length;
    totalPages += history.pages;
    return analyzeTrend(symbol, history.candles, history.pages);
  });

  const failedMarkets = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i]?.error) {
      failed++;
      failedMarkets.push({ symbol: markets[i], reason: errorSummary(results[i].error) });
    }
  }

  const analyzed = results.filter((r) => r && !r.error);
  const candidates = analyzed
    .filter((r) => r.bullishCandidate)
    .sort((a, b) => b.bullishScore - a.bullishScore ||
      b.metrics.strategyCount - a.metrics.strategyCount ||
      b.metrics.pressureImprovement - a.metrics.pressureImprovement ||
      b.metrics.higherLows - a.metrics.higherLows ||
      a.metrics.riseFromBaseLowPct - b.metrics.riseFromBaseLowPct ||
      a.symbol.localeCompare(b.symbol));
  const selected = candidates.slice(0, CONFIG.MAX_RESULTS);
  const telegramLines = selected.map(formatTelegramCandidate);

  console.log(`Gate.io contracts: ${contracts.length}`);
  console.log(`Active crypto perpetuals: ${cryptoContracts.length}`);
  console.log(`Markets scanned (without volume/liquidity filtering): ${markets.length}`);
  console.log(`Markets analyzed: ${checked} | insufficient history: ${insufficient} | data errors: ${failed}`);
  if (failedMarkets.length) {
    console.log('Failed market details:');
    for (const item of failedMarkets) console.log(`DATA_ERROR ${item.symbol} | ${item.reason}`);
  }
  console.log(`Closed 1h candles processed: ${totalCandles} | API pages: ${totalPages}`);
  console.log(`Early bullish candidates: ${candidates.length} | selected: ${selected.length}`);

  const patternCounts = analyzed.reduce((acc, item) => {
    acc[item.currentPhase] = (acc[item.currentPhase] || 0) + 1;
    return acc;
  }, {});
  console.log('Pattern counts:', JSON.stringify(patternCounts));
  const strategyCounts = analyzed.reduce((acc, item) => {
    for (const method of (item.strategies || [])) acc[method] = (acc[method] || 0) + 1;
    return acc;
  }, {});
  console.log('Strategy detections:', JSON.stringify(strategyCounts));
  for (const item of candidates) {
    const m = item.metrics;
    console.log(
      `${item.symbol} | score=${item.bullishScore} | context=${item.currentPhase}` +
      ` | base=${m.baseHours}h | range=${m.baseRangePct.toFixed(2)}%` +
      ` | pressureDelta=${m.pressureImprovement.toFixed(3)} | sellerDelta=${m.sellerPressureChange.toFixed(3)}` +
      ` | higherLows=${m.higherLows} | rise=${m.riseFromBaseLowPct.toFixed(2)}%` +
      ` | 6h=${m.recent6hRisePct.toFixed(2)}% | 12h=${m.recent12hRisePct.toFixed(2)}%` +
      ` | RSI=${m.rsi.toFixed(1)} | methods=${(item.strategies || []).join(',')}`
    );
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | ENGINE 1 — EARLY BULLISH TRANSITION RADAR',
      'فقط کندل‌های بسته‌شده یک‌ساعته | پنج روش استراتژی H1',
      'بدون استفاده از حجم معاملات و بدون مقایسه با بیت‌کوین',
      'هشدار الگوی احتمالی؛ نه سیگنال ورود یا تضمین صعود',
      '━━━━━━━━━━━━━━━━━━',
      ...telegramLines,
    ]);
    console.log('Telegram message sent.');
  } else {
    console.log('No market met strict early bullish-transition requirements; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
