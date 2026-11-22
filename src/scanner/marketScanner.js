/**
 * GATE.IO USDT PERPETUAL — HOURLY CANDIDATE SCANNER + HIGH-POTENTIAL RANKER
 * -------------------------------------------------------------------------
 * Motor 1 discovers hourly bullish-potential candidates. Motor 2 independently
 * re-ranks EVERY Motor 1 candidate; it never removes a candidate.
 * - Downloads the available closed 1h history for each eligible contract by paging
 *   backwards until Gate.io has no older candles to return.
 * - Uses the complete available history to describe the long-term/past structure.
 * - Uses adaptive recent context to describe the current market regime.
 * - Evaluates observable evidence that the next directional phase may be bullish.
 * - Motor 1 remains unchanged in its candidate logic. Motor 2 adds multi-TF
 *   context, BTC relative strength, and upside-room ranking.
 * - Fully closed hourly candles only. No entry, trade signal, or price target.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1h',
  CANDLE_SECONDS: 3600,
  // Gate.io futures candlestick endpoint maximum page size.
  CANDLE_PAGE_SIZE: 2000,
  // Gate.io currently rejects futures candles older than its latest 10,000
  // hourly points. Use a small safety margin to avoid boundary rejections.
  MAX_RECENT_CANDLES: 9900,
  MIN_CANDLES: 48,
  MIN_QUOTE_VOLUME_24H: 100000,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  // Conservative request pacing prevents transient Gate.io throttling.
  CONCURRENCY: 3,
  REQUEST_TIMEOUT: 45000,
  RETRIES: 6,
  MARKET_HISTORY_RETRIES: 2,
  REQUEST_SPACING_MS: 300,
  MAX_RETRY_DELAY_MS: 60000,
  MAX_RESULTS: 10,
  PAGE_PAUSE_MS: 180,
  // These are analysis horizons, NOT history download limits.
  CURRENT_CONTEXT_HOURS: 72,
  SHORT_CONTEXT_HOURS: 24,
  PRESSURE_CONTEXT_HOURS: 12,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MIN_BULLISH_SCORE: 58,
  MOTOR2: {
    // 1H is deliberately dominant. Higher timeframes can influence ranking,
    // but none of them can filter out a Motor 1 candidate.
    WEIGHTS: { h1: 0.60, h4: 0.13, d1: 0.08, w1: 0.05, btcRelative: 0.07, upsideRoom: 0.03, growthCapacity: 0.04 },
    HISTORY: {
      '4h': { seconds: 4 * 3600, candles: 360, min: 24 },
      '1d': { seconds: 24 * 3600, candles: 180, min: 20 },
      '7d': { seconds: 7 * 24 * 3600, candles: 104, min: 12 },
    },
    BTC_HOURLY_CANDLES: 2161,
  },
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

async function getTickers() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/tickers`);
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
    volume: num(item.v),
    turnover: num(item.sum),
  };
}

function isValidCandle(c) {
  return c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
    c.high >= c.low && c.high >= c.open && c.high >= c.close &&
    c.low <= c.open && c.low <= c.close;
}

/**
 * Fetch all closed hourly candles that Gate.io currently exposes for a contract.
 * Gate.io enforces a rolling recent-history boundary of 10,000 points for this
 * endpoint. We deliberately stay inside 9,900 points as a safety margin.
 * Older lifetime candles are not retrievable from this endpoint; do not send
 * requests outside the supported window because Gate.io rejects the whole call.
 */
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

    // Prevent an infinite loop if the API ignores the `to` cursor.
    if (!Number.isFinite(pageOldest) || pageOldest >= oldestSeen) break;
    oldestSeen = pageOldest;
    pageEnd = pageOldest - 1;
    pageCount++;

    // Continue even after a short page: sparse markets can have gaps while
    // still containing older candles in the preceding time window.
    if (pageEnd < oldestAllowed) break;
    await sleep(CONFIG.PAGE_PAUSE_MS);
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

/** Fetch a bounded, fully closed recent window, paging if it exceeds 2,000 bars. */
async function getRecentClosedCandles(contract, interval, candleSeconds, candleCount) {
  const currentBucket = Math.floor((Date.now() / 1000) / candleSeconds) * candleSeconds;
  const from = currentBucket - (candleCount * candleSeconds);
  const byTime = new Map();
  let pageEnd = currentBucket - 1;
  let oldestSeen = Infinity;
  while (pageEnd >= from) {
    const pageStart = Math.max(
      from,
      pageEnd - ((CONFIG.CANDLE_PAGE_SIZE - 1) * candleSeconds),
    );
    const params = new URLSearchParams({
      contract, interval, from: String(pageStart), to: String(pageEnd),
    });
    const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
    if (!Array.isArray(raw)) throw new Error(`Invalid ${interval} candles: ${contract}`);
    if (!raw.length) break;
    let pageOldest = Infinity;
    for (const item of raw) {
      const candle = normalizeCandle(item);
      if (isValidCandle(candle) && candle.time < currentBucket &&
          candle.time >= from && candle.time <= pageEnd) {
        byTime.set(candle.time, candle);
        pageOldest = Math.min(pageOldest, candle.time);
      }
    }
    if (!Number.isFinite(pageOldest) || pageOldest >= oldestSeen) break;
    oldestSeen = pageOldest;
    pageEnd = pageOldest - 1;
    if (pageEnd >= from) await sleep(CONFIG.PAGE_PAUSE_MS);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function returnOverCandles(candles, count) {
  if (!Array.isArray(candles) || candles.length <= count) return null;
  const latest = candles.at(-1).close;
  const earlier = candles[candles.length - 1 - count].close;
  return earlier > 0 ? pct(latest, earlier) : null;
}

function relativeStrengthWindows(assetCandles, btcCandles) {
  const windows = [168, 720, 2160]; // 7d, 30d, 90d of closed hourly candles
  const labels = ['7d', '30d', '90d'];
  const out = {};
  for (let i = 0; i < windows.length; i++) {
    const n = windows[i];
    const assetReturn = returnOverCandles(assetCandles, n);
    const btcReturn = returnOverCandles(btcCandles, n);
    out[labels[i]] = assetReturn === null || btcReturn === null
      ? null
      : { assetReturnPct: assetReturn, btcReturnPct: btcReturn, excessPct: assetReturn - btcReturn };
  }
  return out;
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
  const bodyRatio = body / range;
  const closePosition = clamp((c.close - c.low) / range, 0, 1);
  const lowerWick = clamp((Math.min(c.open, c.close) - c.low) / range, 0, 1);
  const upperWick = clamp((c.high - Math.max(c.open, c.close)) / range, 0, 1);
  return {
    bullish: body > 0,
    bearish: body < 0,
    bodyRatio,
    closePosition,
    lowerWick,
    upperWick,
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
  // Approximate percentage change per candle.
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
  const highUp = highs.length >= 2
    ? highs.slice(1).filter((p, i) => p.price > highs[i].price).length
    : 0;
  const highDown = highs.length >= 2
    ? highs.slice(1).filter((p, i) => p.price < highs[i].price).length
    : 0;
  const lowUp = lows.length >= 2
    ? lows.slice(1).filter((p, i) => p.price > lows[i].price).length
    : 0;
  const lowDown = lows.length >= 2
    ? lows.slice(1).filter((p, i) => p.price < lows[i].price).length
    : 0;
  const bullish = highUp + lowUp;
  const bearish = highDown + lowDown;
  let direction = 'MIXED';
  if (bullish >= bearish + 2) direction = 'UP';
  else if (bearish >= bullish + 2) direction = 'DOWN';
  else if (bullish === 0 && bearish === 0) direction = 'UNCONFIRMED';
  return { direction, highUp, highDown, lowUp, lowDown, bullishSteps: bullish, bearishSteps: bearish };
}

function classifyTrend(slope, structure, totalReturn) {
  if (structure.direction === 'UP' && slope > 0.015) return 'UPTREND';
  if (structure.direction === 'DOWN' && slope < -0.015) return 'DOWNTREND';
  if (slope > 0.035 && totalReturn > 1.0) return 'RISING';
  if (slope < -0.035 && totalReturn < -1.0) return 'FALLING';
  if (Math.abs(slope) <= 0.025) return 'SIDEWAYS';
  return 'TRANSITION';
}

function describeTrend(code) {
  return ({
    UPTREND: 'روند صعودی',
    DOWNTREND: 'روند نزولی',
    RISING: 'حرکت رو به بالا',
    FALLING: 'حرکت رو به پایین',
    SIDEWAYS: 'روند خنثی',
    TRANSITION: 'مرحله تغییر روند',
  })[code] || 'ساختار نامشخص';
}

function selectRecent(candles, hours) {
  return candles.slice(-Math.min(hours, candles.length));
}

function analyzeTrend(symbol, candles, quoteVolume24h, pageCount, btcHourlyCandles = []) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;

  const latest = candles.at(-1);
  const first = candles[0];
  const allPivots = findPivots(candles);
  const fullSlope = linearRegressionSlope(candles.map((c) => c.close));
  const fullReturn = pct(latest.close, first.close);
  const pastStructure = structuralDirection(allPivots);
  const pastTrend = classifyTrend(fullSlope, pastStructure, fullReturn);

  const current = selectRecent(candles, CONFIG.CURRENT_CONTEXT_HOURS);
  const short = selectRecent(candles, CONFIG.SHORT_CONTEXT_HOURS);
  const pressureNow = selectRecent(candles, CONFIG.PRESSURE_CONTEXT_HOURS);
  const pressureBefore = candles.slice(
    Math.max(0, candles.length - CONFIG.PRESSURE_CONTEXT_HOURS * 2),
    Math.max(0, candles.length - CONFIG.PRESSURE_CONTEXT_HOURS)
  );
  const currentPivots = findPivots(current);
  const currentStructure = structuralDirection(currentPivots);
  const currentSlope = linearRegressionSlope(current.map((c) => c.close));
  const shortSlope = linearRegressionSlope(short.map((c) => c.close));
  const currentReturn = pct(current.at(-1).close, current[0].open);
  const shortReturn = pct(short.at(-1).close, short[0].open);
  const currentTrend = classifyTrend(currentSlope, currentStructure, currentReturn);

  const currentFacts = current.map(candleFacts);
  const pressureRecent = directionalPressure(pressureNow);
  const pressurePrevious = pressureBefore.length >= 4 ? directionalPressure(pressureBefore) : pressureRecent;
  const pressureChange = pressureRecent - pressurePrevious;
  const averageClosePosition = mean(currentFacts.map((f) => f.closePosition));
  const bullishBars = currentFacts.filter((f) => f.bullish).length;
  const bearishBars = currentFacts.filter((f) => f.bearish).length;
  const lowerWickAverage = mean(currentFacts.map((f) => f.lowerWick));
  const upperWickAverage = mean(currentFacts.map((f) => f.upperWick));

  const currentLow = Math.min(...current.map((c) => c.low));
  const currentHigh = Math.max(...current.map((c) => c.high));
  const shortLow = Math.min(...short.map((c) => c.low));
  const shortHigh = Math.max(...short.map((c) => c.high));
  const closeFromCurrentLow = pct(latest.close, currentLow);
  const closeFromShortLow = pct(latest.close, shortLow);
  const locationInCurrentRange = safeDiv(latest.close - currentLow, currentHigh - currentLow, 0.5);

  // A recency-weighted pressure trend: every candle participates, while newer
  // observations naturally have greater influence. This is not a hard lookback.
  let weightedPressure = 0;
  let totalWeight = 0;
  for (let i = 0; i < candles.length; i++) {
    const age = candles.length - 1 - i;
    const weight = Math.exp(-age / 36);
    weightedPressure += directionalPressure([candles[i]]) * weight;
    totalWeight += weight;
  }
  weightedPressure = safeDiv(weightedPressure, totalWeight, 0);

  // Score evidence, not certainty. No previous-growth penalty, breakout rule,
  // volume spike requirement, or BTC-relative-strength condition is applied.
  const structureScore = clamp(
    (currentStructure.lowUp * 8) + (currentStructure.highUp * 5) -
    (currentStructure.lowDown * 7) - (currentStructure.highDown * 4) + 12,
    0, 30
  );
  const slopeScore = clamp(10 + (currentSlope * 100) + (shortSlope * 65), 0, 20);
  const pressureScore = clamp(10 + (pressureChange * 30) + (weightedPressure * 7), 0, 20);
  const candleQualityScore = clamp(
    (averageClosePosition - 0.35) * 25 +
    ((bullishBars - bearishBars) / Math.max(current.length, 1)) * 12 +
    (lowerWickAverage - upperWickAverage) * 5 + 8,
    0, 15
  );
  const recoveryScore = clamp(
    (closeFromCurrentLow * 1.1) + (closeFromShortLow * 0.6) +
    (locationInCurrentRange * 8) - 4,
    0, 15
  );
  const bullishScore = Math.round(clamp(
    structureScore + slopeScore + pressureScore + candleQualityScore + recoveryScore,
    0, 100
  ));

  const hasBullishStructure = currentStructure.lowUp >= 1 || currentStructure.highUp >= 2;
  const hasBuyerEvidence = pressureChange > 0.025 ||
    (averageClosePosition >= 0.57 && bullishBars > bearishBars) ||
    (lowerWickAverage > upperWickAverage + 0.08 && closeFromCurrentLow > 1.0);
  const hasPriceProgress = currentSlope > 0.005 || shortSlope > 0.01 ||
    (closeFromCurrentLow > 2.0 && locationInCurrentRange > 0.62);
  const bullishCandidate = bullishScore >= CONFIG.MIN_BULLISH_SCORE &&
    hasBuyerEvidence && hasPriceProgress;

  let currentPhase;
  if (currentTrend === 'UPTREND' || currentTrend === 'RISING') {
    currentPhase = currentStructure.lowUp >= 1 && shortReturn < currentReturn
      ? 'UPTREND_PAUSE_OR_PULLBACK'
      : 'UPWARD_TREND_CONTINUATION';
  } else if (currentTrend === 'DOWNTREND' || currentTrend === 'FALLING') {
    currentPhase = hasBuyerEvidence ? 'POSSIBLE_DOWNTREND_EXHAUSTION' : 'ACTIVE_DOWNTREND';
  } else if (hasBuyerEvidence && hasPriceProgress) {
    currentPhase = 'BULLISH_TRANSITION';
  } else if (Math.abs(currentSlope) <= 0.025) {
    currentPhase = 'SIDEWAYS_OR_CONSOLIDATING';
  } else {
    currentPhase = 'MIXED_TRANSITION';
  }

  let futureBias = 'NEUTRAL_OR_UNCLEAR';
  if (bullishCandidate) futureBias = 'BULLISH_POTENTIAL';
  else if (bullishScore <= 38 && currentTrend.includes('DOWN')) futureBias = 'BEARISH_RISK';

  const averageTurnover = mean(current.map((c) => c.turnover > 0 ? c.turnover : c.volume));
  return {
    symbol,
    bullishCandidate,
    bullishScore,
    futureBias,
    pastTrend,
    pastTrendLabel: describeTrend(pastTrend),
    currentTrend,
    currentTrendLabel: describeTrend(currentTrend),
    currentPhase,
    metrics: {
      candlesAvailable: candles.length,
      historyPages: pageCount,
      historyReturnPct: fullReturn,
      currentReturnPct: currentReturn,
      shortReturnPct: shortReturn,
      fullSlope: fullSlope,
      currentSlope,
      shortSlope,
      pressureChange,
      weightedPressure,
      averageClosePosition,
      bullishBars,
      bearishBars,
      higherLowSteps: currentStructure.lowUp,
      higherHighSteps: currentStructure.highUp,
      lowerLowSteps: currentStructure.lowDown,
      lowerHighSteps: currentStructure.highDown,
      closeFromCurrentLowPct: closeFromCurrentLow,
      locationInCurrentRange,
      averageTurnover,
      quoteVolume24h,
      btcRelativeStrength: relativeStrengthWindows(candles, btcHourlyCandles),
    },
    scoreBreakdown: {
      structure: Math.round(structureScore),
      trendSlope: Math.round(slopeScore),
      buyerPressure: Math.round(pressureScore),
      candleQuality: Math.round(candleQualityScore),
      recovery: Math.round(recoveryScore),
    },
    evidence: {
      hasBullishStructure,
      hasBuyerEvidence,
      hasPriceProgress,
    },
  };
}

function analyzeHigherTimeframe(candles, minimumCandles) {
  if (!Array.isArray(candles) || candles.length < minimumCandles) {
    return { available: false, score: 50, trend: 'UNAVAILABLE', returnPct: null };
  }
  const recent = candles.slice(-Math.min(candles.length, 48));
  const pivots = findPivots(recent);
  const structure = structuralDirection(pivots);
  const slope = linearRegressionSlope(recent.map((c) => c.close));
  const facts = recent.map(candleFacts);
  const pressure = directionalPressure(recent.slice(-Math.min(12, recent.length)));
  const closePosition = mean(facts.map((f) => f.closePosition));
  const structureScore = clamp(50 +
    ((structure.highUp + structure.lowUp) - (structure.highDown + structure.lowDown)) * 10, 0, 100);
  const slopeScore = clamp(50 + slope * 180, 0, 100);
  const pressureScore = clamp(50 + pressure * 35, 0, 100);
  const candleScore = clamp(closePosition * 100, 0, 100);
  const score = Math.round(
    structureScore * 0.35 + slopeScore * 0.25 + pressureScore * 0.25 + candleScore * 0.15
  );
  const returnPct = recent.length > 1 ? pct(recent.at(-1).close, recent[0].open) : 0;
  let trend = 'MIXED';
  if (structure.direction === 'UP' && slope > 0) trend = 'UP';
  else if (structure.direction === 'DOWN' && slope < 0) trend = 'DOWN';
  else if (slope > 0.02 && returnPct > 0) trend = 'RISING';
  else if (slope < -0.02 && returnPct < 0) trend = 'FALLING';
  return { available: true, score, trend, returnPct, structure: structure.direction };
}

function calculateUpsideRoom(currentPrice, timeframeCandles) {
  const resistanceLevels = [];
  for (const candles of timeframeCandles) {
    if (!Array.isArray(candles) || candles.length < 8) continue;
    const pivots = findPivots(candles, 2, 2);
    for (const pivot of pivots.highs) {
      if (pivot.price > currentPrice * 1.002) resistanceLevels.push(pivot.price);
    }
  }
  const nearest = resistanceLevels.length ? Math.min(...resistanceLevels) : null;
  if (!nearest) {
    return { roomPct: null, score: 65, nextResistance: null };
  }
  const roomPct = pct(nearest, currentPrice);
  // This is room to the nearest observed overhead pivot, not a 100% growth forecast.
  const score = Math.round(clamp(15 + roomPct * 1.15, 0, 100));
  return { roomPct, score, nextResistance: nearest };
}

function calculateGrowthCapacity(currentPrice, dailyCandles, weeklyCandles) {
  const highs = [...(dailyCandles || []), ...(weeklyCandles || [])]
    .map((c) => c.high)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!highs.length || !(currentPrice > 0)) {
    return { score: 50, historicalHighRoomPct: null, canReachDoubleBeforeObservedHigh: null };
  }
  const historicalHigh = Math.max(...highs);
  const historicalHighRoomPct = historicalHigh > currentPrice
    ? pct(historicalHigh, currentPrice)
    : 0;
  let score;
  if (historicalHighRoomPct >= 100) score = 95;
  else if (historicalHighRoomPct >= 75) score = 88;
  else if (historicalHighRoomPct >= 50) score = 78;
  else if (historicalHighRoomPct >= 25) score = 65;
  else if (historicalHighRoomPct >= 10) score = 50;
  else score = 35;
  return {
    score,
    historicalHighRoomPct,
    canReachDoubleBeforeObservedHigh: historicalHighRoomPct >= 100,
  };
}

function calculateBtcRelativeScore(metrics) {
  const rs = metrics.btcRelativeStrength || {};
  const values = [
    { value: rs['7d']?.excessPct, weight: 0.40 },
    { value: rs['30d']?.excessPct, weight: 0.35 },
    { value: rs['90d']?.excessPct, weight: 0.25 },
  ].filter((x) => Number.isFinite(x.value));
  if (!values.length) return { score: 50, excessPct: null, available: false };
  const weightTotal = values.reduce((sum, x) => sum + x.weight, 0);
  const excessPct = values.reduce((sum, x) => sum + x.value * x.weight, 0) / weightTotal;
  const score = Math.round(clamp(50 + 50 * Math.tanh(excessPct / 25), 0, 100));
  return { score, excessPct, available: true };
}

function opportunityType(item) {
  if (item.currentPhase === 'BULLISH_TRANSITION') return 'EARLY_BULLISH_TRANSITION';
  if (item.currentPhase === 'UPTREND_PAUSE_OR_PULLBACK') return 'UPTREND_RESUMPTION_WATCH';
  if (item.currentPhase === 'UPWARD_TREND_CONTINUATION') return 'ACTIVE_BULLISH_MOMENTUM';
  if (item.currentPhase === 'POSSIBLE_DOWNTREND_EXHAUSTION') return 'EARLY_REVERSAL_WATCH';
  return 'OTHER_BULLISH_CANDIDATE';
}

async function rankWithMotorTwo(candidates) {
  const ranked = await mapLimit(candidates, CONFIG.CONCURRENCY, async (item) => {
    try {
    const tfData = {};
    const errors = [];
    for (const [interval, spec] of Object.entries(CONFIG.MOTOR2.HISTORY)) {
      try {
        tfData[interval] = await getRecentClosedCandles(
          item.symbol, interval, spec.seconds, spec.candles
        );
      } catch (error) {
        tfData[interval] = [];
        errors.push(`${interval}:${errorSummary(error)}`);
      }
    }

    const h4 = analyzeHigherTimeframe(tfData['4h'], CONFIG.MOTOR2.HISTORY['4h'].min);
    const d1 = analyzeHigherTimeframe(tfData['1d'], CONFIG.MOTOR2.HISTORY['1d'].min);
    const w1 = analyzeHigherTimeframe(tfData['7d'], CONFIG.MOTOR2.HISTORY['7d'].min);
    const btcRelative = calculateBtcRelativeScore(item.metrics);
    const latestPrice = item._latestPrice;
    const upside = calculateUpsideRoom(latestPrice, [tfData['1d'], tfData['7d']]);
    const growthCapacity = calculateGrowthCapacity(latestPrice, tfData['1d'], tfData['7d']);
    const w = CONFIG.MOTOR2.WEIGHTS;
    const rankScore = Math.round(clamp(
      item.bullishScore * w.h1 +
      h4.score * w.h4 +
      d1.score * w.d1 +
      w1.score * w.w1 +
      btcRelative.score * w.btcRelative +
      upside.score * w.upsideRoom +
      growthCapacity.score * w.growthCapacity,
      0, 100
    ));

    return {
      ...item,
      motor2: {
        rankScore,
        opportunityType: opportunityType(item),
        timeframe: { h1: item.bullishScore, h4, d1, w1 },
        btcRelative,
        upsideRoom: upside,
        growthCapacity,
        higherTimeframeErrors: errors,
      },
    };
    } catch (error) {
      // Even an unexpected Motor 2 calculation error must not remove a candidate.
      return {
        ...item,
        motor2: {
          rankScore: Math.round(item.bullishScore * 0.60 + 50 * 0.40),
          opportunityType: opportunityType(item),
          timeframe: {
            h1: item.bullishScore,
            h4: { available: false, score: 50, trend: 'UNAVAILABLE', returnPct: null },
            d1: { available: false, score: 50, trend: 'UNAVAILABLE', returnPct: null },
            w1: { available: false, score: 50, trend: 'UNAVAILABLE', returnPct: null },
          },
          btcRelative: { score: 50, excessPct: null, available: false },
          upsideRoom: { roomPct: null, score: 50, nextResistance: null },
          growthCapacity: { score: 50, historicalHighRoomPct: null, canReachDoubleBeforeObservedHigh: null },
          higherTimeframeErrors: [`motor2:${errorSummary(error)}`],
        },
      };
    }
  });

  // Every Motor 1 candidate remains in the list. Missing higher-TF data receives
  // a neutral score and is reported; it is never a reason to discard a symbol.
  return ranked.sort((a, b) =>
    b.motor2.rankScore - a.motor2.rankScore ||
    b.bullishScore - a.bullishScore ||
    (b.motor2.btcRelative.excessPct ?? -Infinity) - (a.motor2.btcRelative.excessPct ?? -Infinity) ||
    a.symbol.localeCompare(b.symbol)
  );
}

function formatTelegramCandidate(item, index) {
  const name = item.symbol.replace(/_USDT$/, '');
  const typeLabels = {
    EARLY_BULLISH_TRANSITION: 'شروع/گذار صعودی',
    UPTREND_RESUMPTION_WATCH: 'آمادگی ادامه صعود',
    ACTIVE_BULLISH_MOMENTUM: 'شتاب صعودی فعال',
    EARLY_REVERSAL_WATCH: 'مراقبت از برگشت زودهنگام',
    OTHER_BULLISH_CANDIDATE: 'نامزد صعودی',
  };
  const rs = item.motor2.btcRelative.excessPct;
  const room = item.motor2.upsideRoom.roomPct;
  const historicalRoom = item.motor2.growthCapacity.historicalHighRoomPct;
  return `${index + 1} — ${name} | رتبه موتور۲: ${item.motor2.rankScore}/100 | 1H: ${item.bullishScore} | قدرت نسبت به BTC: ${rs === null ? 'نامشخص' : `${rs >= 0 ? '+' : ''}${rs.toFixed(1)}%`} | مقاومت نزدیک: ${room === null ? 'نامشخص' : `${room.toFixed(1)}%`} | فاصله تا سقف تاریخیِ بازه: ${historicalRoom === null ? 'نامشخص' : `${historicalRoom.toFixed(1)}%`} | ${typeLabels[item.motor2.opportunityType] || item.motor2.opportunityType}`;
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

async function main() {
  console.log('\nGATE.IO HOURLY TREND SCANNER');
  console.log(`Mode: Motor 1 discovery + Motor 2 ranking | latest ${CONFIG.MAX_RECENT_CANDLES} closed 1h candles | Motor 2 ranks every Motor 1 candidate | 1H primary | max 10 Telegram results`);

  const [contracts, tickers] = await Promise.all([getContracts(), getTickers()]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
    throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');
  }

  const tickerMap = new Map(tickers.map((ticker) => [ticker.contract, ticker]));
  const namedContracts = contracts.filter((c) => c?.name);
  const cryptoContracts = namedContracts.filter(isSupportedCryptoContract);
  const rejectedNonCryptoOrInactive = namedContracts.length - cryptoContracts.length;
  const rejectedMissingTicker = cryptoContracts.filter((c) => !tickerMap.has(c.name)).length;
  const markets = cryptoContracts
    .filter((c) => c.name !== 'BTC_USDT' && tickerMap.has(c.name))
    .map((c) => ({
      symbol: c.name,
      quoteVolume: num(tickerMap.get(c.name).volume_24h_quote),
    }))
    .filter((m) => m.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log('Motor 2: enabled | all Motor 1 candidates retained | 1H primary ranking weight: 60%');
  let btcHourlyCandles = [];
  try {
    btcHourlyCandles = await getRecentClosedCandles('BTC_USDT', '1h', 3600, CONFIG.MOTOR2.BTC_HOURLY_CANDLES);
    console.log(`BTC hourly candles loaded for relative-strength comparison: ${btcHourlyCandles.length}`);
  } catch (error) {
    console.warn(`Motor 2 BTC-relative-strength data unavailable; candidates will remain and receive neutral BTC score: ${errorSummary(error)}`);
  }
  let checked = 0;
  let failed = 0;
  let insufficient = 0;
  let totalCandles = 0;
  let totalPages = 0;

  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const history = await getClosedHourlyCandlesWithRetry(market.symbol);
    if (history.candles.length < CONFIG.MIN_CANDLES) {
      insufficient++;
      return null;
    }
    checked++;
    totalCandles += history.candles.length;
    totalPages += history.pages;
    const analysis = analyzeTrend(market.symbol, history.candles, market.quoteVolume, history.pages, btcHourlyCandles);
    if (analysis) analysis._latestPrice = history.candles.at(-1).close;
    return analysis;
  });

  const failedMarkets = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result?.error) {
      failed++;
      failedMarkets.push({ symbol: markets[i].symbol, reason: errorSummary(result.error) });
    }
  }

  const analyzed = results.filter((r) => r && !r.error);
  const candidates = analyzed
    .filter((r) => r.bullishCandidate)
    .sort((a, b) => b.bullishScore - a.bullishScore || a.symbol.localeCompare(b.symbol));
  const motorTwoRanking = await rankWithMotorTwo(candidates);
  const selected = motorTwoRanking.slice(0, CONFIG.MAX_RESULTS);
  const telegramLines = selected.map(formatTelegramCandidate);

  const phaseCounts = analyzed.reduce((acc, item) => {
    acc[item.currentPhase] = (acc[item.currentPhase] || 0) + 1;
    return acc;
  }, {});

  console.log(`Gate.io contracts: ${contracts.length}`);
  console.log(`Active crypto contracts: ${cryptoContracts.length}`);
  console.log(`Rejected non-crypto/inactive/unknown: ${rejectedNonCryptoOrInactive}`);
  console.log(`Crypto contracts missing ticker: ${rejectedMissingTicker}`);
  console.log(`Markets eligible by minimum 24h liquidity: ${markets.length}`);
  console.log(`Markets analyzed with available closed ${CONFIG.TIMEFRAME} history inside Gate.io recent-history window: ${checked}`);
  console.log(`Markets with insufficient history: ${insufficient}`);
  console.log(`Markets with data errors after retries: ${failed}`);
  if (failedMarkets.length) {
    console.log('Failed market details:');
    for (const item of failedMarkets) console.log(`DATA_ERROR ${item.symbol} | ${item.reason}`);
  }
  console.log(`Historical candles processed: ${totalCandles}`);
  console.log(`Historical API pages processed: ${totalPages}`);
  console.log(`Motor 1 bullish-potential candidates passed to Motor 2: ${candidates.length}`);
  console.log(`Motor 2 candidates retained after ranking: ${motorTwoRanking.length}`);
  console.log(`Motor 2 selected symbols for Telegram: ${selected.length}`);
  console.log('Current phase counts:', JSON.stringify(phaseCounts));

  if (motorTwoRanking.length) {
    console.log('MOTOR 2 FULL RANKING (no Motor 1 candidate removed):');
    for (let i = 0; i < motorTwoRanking.length; i++) {
      const item = motorTwoRanking[i];
      const m = item.metrics;
      const mt = item.motor2;
      console.log(
        `${i + 1}. ${item.symbol} | motor2=${mt.rankScore} | 1h=${item.bullishScore} | ` +
        `4h=${mt.timeframe.h4.available ? mt.timeframe.h4.score : 'NA'} | ` +
        `1d=${mt.timeframe.d1.available ? mt.timeframe.d1.score : 'NA'} | ` +
        `1w=${mt.timeframe.w1.available ? mt.timeframe.w1.score : 'NA'} | ` +
        `BTCexcess=${mt.btcRelative.excessPct === null ? 'NA' : mt.btcRelative.excessPct.toFixed(2) + '%'} | ` +
        `resistanceRoom=${mt.upsideRoom.roomPct === null ? 'NA' : mt.upsideRoom.roomPct.toFixed(2) + '%'} | ` +
        `historicalHighRoom=${mt.growthCapacity.historicalHighRoomPct === null ? 'NA' : mt.growthCapacity.historicalHighRoomPct.toFixed(2) + '%'} | ` +
        `type=${mt.opportunityType} | phase=${item.currentPhase} | ` +
        `1hReturn=${m.currentReturnPct.toFixed(2)}% | ` +
        `higherTFErrors=${mt.higherTimeframeErrors.length}`
      );
    }
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | HIGH-POTENTIAL MOTOR 2 RANKING',
      'رتبه‌بندی مجدد همه نامزدهای موتور اول | اولویت 1H: ۶۰٪ | تکمیلی: 4H، 1D، 1W، قدرت نسبی BTC و ظرفیت تاریخی رشد',
      'رتبه امتیاز تحلیلی است، نه درصد احتمال یا تضمین رشد ۱۰۰٪؛ هیچ نامزدی در موتور دوم حذف نشده است.',
      '━━━━━━━━━━━━━━━━━━',
      ...telegramLines,
    ]);
    console.log('Telegram message sent.');
  } else {
    console.log('Motor 1 produced no bullish-potential candidates; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
