/**
 * GATE.IO USDT PERPETUAL — PRE-BREAKOUT HOURLY PRICE-STRUCTURE RADAR
 * -----------------------------------------------------------------
 * ONE ENGINE ONLY. No Motor 2.
 * - Closed 1h candles only.
 * - Price structure only: no volume and no BTC comparison.
 * - Finds mature consolidation immediately below a meaningful resistance.
 * - Requires repeated resistance tests, protected/higher lows and improving
 *   buyer behavior while price is still below resistance.
 * - Rejects active downtrends, unconfirmed first bounces and completed breakouts.
 * - No entry, trade signal, or price target.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1h',
  CANDLE_SECONDS: 3600,
  CANDLE_PAGE_SIZE: 2000,
  MAX_RECENT_CANDLES: 9900,
  MIN_CANDLES: 60,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  CONCURRENCY: 3,
  REQUEST_TIMEOUT: 45000,
  RETRIES: 6,
  MARKET_HISTORY_RETRIES: 2,
  REQUEST_SPACING_MS: 300,
  MAX_RETRY_DELAY_MS: 60000,
  MAX_RESULTS: 10,
  PAGE_PAUSE_MS: 180,

  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,

  // A genuine base must be more than a brief pause.
  MIN_BASE_HOURS: 30,
  MAX_BASE_HOURS: 240,
  MIN_BASE_TURNS: 5,
  MIN_RESISTANCE_TOUCHES: 2,
  MIN_HIGH_TOUCH_SEPARATION: 4,

  // Pre-breakout location constraints.
  MIN_RESISTANCE_DISTANCE_PCT: 0.35,
  MAX_RESISTANCE_DISTANCE_PCT: 4.0,
  RESISTANCE_CLUSTER_TOLERANCE_PCT: 1.35,
  MAX_BASE_RANGE_PCT: 12,
  MAX_BASE_SLOPE_ABS: 0.045,
  MAX_RECENT_DOWNSLOPE: -0.012,
  MAX_ADVANCE_FROM_BASE_LOW_PCT: 12,
  MAX_BASE_START_ADVANCE_PCT: 12,

  MIN_BULLISH_SCORE: 62,
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

    const accumulated = [...byTime.values()].sort((a, b) => a.time - b.time);
    const phases = getSignificantRecentPhases(accumulated);
    const base = findMatureBase(accumulated);
    if (phases.length >= 6 && base?.durationHours >= CONFIG.MIN_BASE_HOURS) break;
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

function getSignificantRecentPhases(candles) {
  const pivots = findPivots(candles);
  const events = [
    ...pivots.highs.map((p) => ({ ...p, type: 'H' })),
    ...pivots.lows.map((p) => ({ ...p, type: 'L' })),
  ].sort((a, b) => a.index - b.index);
  const swings = [];
  for (const point of events) {
    const last = swings.at(-1);
    if (!last || last.type !== point.type) swings.push(point);
    else if ((point.type === 'H' && point.price > last.price) ||
             (point.type === 'L' && point.price < last.price)) swings[swings.length - 1] = point;
  }
  const phases = [];
  for (let i = 1; i < swings.length; i++) {
    const a = swings[i - 1];
    const b = swings[i];
    const movePct = pct(b.price, a.price);
    const duration = b.index - a.index;
    if (duration < 3 || Math.abs(movePct) < 1.2) continue;
    phases.push({
      direction: movePct > 0 ? 'UP' : 'DOWN',
      startIndex: a.index,
      endIndex: b.index,
      duration,
      movePct,
      from: a.price,
      to: b.price,
    });
  }
  return phases.slice(-8);
}

function findResistance(baseCandles) {
  // Resistance is built from confirmed swing highs, not simply the highest
  // price of the whole chart. The last three candles are excluded so a fresh
  // breakout cannot redefine its own resistance and pass the pre-breakout test.
  const usable = baseCandles.slice(0, Math.max(0, baseCandles.length - 3));
  if (usable.length < 18) return null;
  const pivots = findPivots(usable).highs;
  if (pivots.length < 2) return null;
  const top = Math.max(...pivots.map((p) => p.price));
  const cluster = pivots.filter((p) => pct(top, p.price) <= CONFIG.RESISTANCE_CLUSTER_TOLERANCE_PCT);
  if (cluster.length < CONFIG.MIN_RESISTANCE_TOUCHES) return null;
  const resistance = median(cluster.map((p) => p.price));
  const separated = [];
  for (const p of cluster) {
    const last = separated.at(-1);
    if (!last || p.index - last.index >= CONFIG.MIN_HIGH_TOUCH_SEPARATION) separated.push(p);
    else if (p.price > last.price) separated[separated.length - 1] = p;
  }
  if (separated.length < CONFIG.MIN_RESISTANCE_TOUCHES) return null;
  return {
    price: resistance,
    touches: separated.length,
    touchIndices: separated.map((p) => p.index),
    clusterRangePct: pct(top, Math.min(...cluster.map((p) => p.price))),
  };
}

function findMatureBase(candles) {
  const n = candles.length;
  if (n < CONFIG.MIN_BASE_HOURS + 10) return null;
  const recentPhases = getSignificantRecentPhases(candles);
  const candleRanges = candles.slice(-Math.min(n, 240)).map(candleRangePct).filter((v) => v > 0);
  const typicalHourlyRange = median(candleRanges) || 0.35;
  const adaptiveRangeLimit = Math.min(CONFIG.MAX_BASE_RANGE_PCT, Math.max(3.0, typicalHourlyRange * 18));

  let best = null;
  const maxStart = Math.max(0, n - CONFIG.MIN_BASE_HOURS);
  for (let start = maxStart; start >= Math.max(0, n - CONFIG.MAX_BASE_HOURS); start--) {
    const segment = candles.slice(start);
    if (segment.length < CONFIG.MIN_BASE_HOURS || segment.length > CONFIG.MAX_BASE_HOURS) continue;
    const stats = summarizeCandleBehavior(segment);
    if (!stats || stats.rangePct > adaptiveRangeLimit) continue;
    if (Math.abs(stats.slope) > CONFIG.MAX_BASE_SLOPE_ABS) continue;
    const turns = stats.pivots.highs.length + stats.pivots.lows.length;
    if (turns < CONFIG.MIN_BASE_TURNS) continue;

    const resistance = findResistance(segment);
    if (!resistance) continue;
    const baseLow = Math.min(...segment.map((c) => c.low));
    const latest = candles.at(-1);
    const distancePct = pct(resistance.price, latest.close);
    // Price must still be below the resistance, but close enough to test it.
    if (distancePct < CONFIG.MIN_RESISTANCE_DISTANCE_PCT || distancePct > CONFIG.MAX_RESISTANCE_DISTANCE_PCT) continue;
    // A wick/close that already pushed decisively through the level is not an early setup.
    if (latest.close >= resistance.price * 0.996) continue;
    if (latest.high > resistance.price * 1.012) continue;

    const latter = segment.slice(Math.floor(segment.length * 0.62));
    const latterStats = summarizeCandleBehavior(latter);
    if (!latterStats || latterStats.slope < CONFIG.MAX_RECENT_DOWNSLOPE) continue;

    const lows = stats.pivots.lows.slice(-6);
    const higherLowSteps = lows.length >= 2
      ? lows.slice(1).filter((p, i) => p.price > lows[i].price * 1.001).length : 0;
    const lowerLowSteps = lows.length >= 2
      ? lows.slice(1).filter((p, i) => p.price < lows[i].price * 0.999).length : 0;
    if (higherLowSteps < 2 || lowerLowSteps > 0) continue;

    const advanceFromLow = pct(latest.close, baseLow);
    const advanceFromStart = pct(latest.close, segment[0].open);
    if (advanceFromLow > CONFIG.MAX_ADVANCE_FROM_BASE_LOW_PCT ||
        advanceFromStart > CONFIG.MAX_BASE_START_ADVANCE_PCT) continue;

    const priorPhase = [...recentPhases].reverse().find((phase) =>
      phase.endIndex <= start && phase.duration >= 6
    ) || null;
    best = {
      startIndex: start,
      endIndex: n - 1,
      candles: segment,
      stats,
      turns,
      resistance,
      durationHours: segment.length,
      rangeLimitPct: adaptiveRangeLimit,
      higherLowSteps,
      lowerLowSteps,
      advanceFromLow,
      advanceFromStart,
      latterStats,
      priorPhase,
    };
    break;
  }
  return best;
}

function assessPreBreakoutReadiness(candles, base) {
  const latest = candles.at(-1);
  const segment = base.candles;
  const tail = segment.slice(-Math.max(10, Math.ceil(segment.length * 0.30)));
  const tailStats = summarizeCandleBehavior(tail);
  const baseStats = base.stats;
  const resistance = base.resistance.price;
  const distanceToResistancePct = pct(resistance, latest.close);
  const baseLow = Math.min(...segment.map((c) => c.low));
  const baseHigh = Math.max(...segment.map((c) => c.high));
  const rangePosition = clamp(safeDiv(latest.close - baseLow, baseHigh - baseLow, 0.5), 0, 1);

  const recentFacts = segment.slice(-12).map(candleFacts);
  const recentBullish = recentFacts.filter((f) => f.bullish).length;
  const recentBearish = recentFacts.filter((f) => f.bearish).length;
  const recentClosePosition = mean(recentFacts.map((f) => f.closePosition));
  const recentUpperWick = mean(recentFacts.map((f) => f.upperWick));
  const recentLowerWick = mean(recentFacts.map((f) => f.lowerWick));

  const lows = baseStats.pivots.lows.slice(-6);
  const highs = baseStats.pivots.highs.slice(-6);
  const higherLowSteps = base.higherLowSteps;
  const lowerLowSteps = base.lowerLowSteps;
  const lowerHighSteps = highs.length >= 2
    ? highs.slice(1).filter((p, i) => p.price < highs[i].price * 0.999).length : 0;
  const highCompression = highs.length >= 2 && lowerHighSteps >= 1;

  const buyerPressureImproving =
    (tailStats.pressure > 0.04 && tailStats.pressure > baseStats.pressure - 0.02) ||
    (recentClosePosition >= 0.58 && recentBullish >= recentBearish) ||
    (recentLowerWick > recentUpperWick + 0.06 && tailStats.slope > 0);

  const baseNotFalling = tailStats.slope >= CONFIG.MAX_RECENT_DOWNSLOPE &&
    baseStats.slope >= -0.015 && lowerLowSteps === 0;
  const priceStillBelowResistance = distanceToResistancePct >= CONFIG.MIN_RESISTANCE_DISTANCE_PCT &&
    distanceToResistancePct <= CONFIG.MAX_RESISTANCE_DISTANCE_PCT &&
    latest.close < resistance * 0.996 && latest.high <= resistance * 1.012;
  const nearResistance = distanceToResistancePct <= 2.8;
  const compressedStructure = higherLowSteps >= 2 && base.resistance.touches >= CONFIG.MIN_RESISTANCE_TOUCHES;
  const notAlreadyExtended = base.advanceFromLow <= CONFIG.MAX_ADVANCE_FROM_BASE_LOW_PCT &&
    base.advanceFromStart <= CONFIG.MAX_BASE_START_ADVANCE_PCT && rangePosition < 0.90;
  const noActiveDowntrend = baseNotFalling && baseStats.structure.direction !== 'DOWN';

  // Reject prior DOWN phases unless the base has clearly neutralized the decline:
  // repeated higher lows, no fresh lower low, non-negative recent slope and buyer pressure.
  const priorDowntrendNeutralized = base.priorPhase?.direction !== 'DOWN' ||
    (higherLowSteps >= 2 && lowerLowSteps === 0 && tailStats.slope >= 0 && buyerPressureImproving);

  const qualifies = priceStillBelowResistance && nearResistance && compressedStructure &&
    notAlreadyExtended && noActiveDowntrend && priorDowntrendNeutralized && buyerPressureImproving;

  const baseQuality = clamp(
    12 + Math.min(base.durationHours / 8, 12) + base.resistance.touches * 5 +
    higherLowSteps * 7 - baseStats.rangePct * 0.8 - lowerHighSteps * 0.5,
    0, 40,
  );
  const buyerScore = clamp(
    8 + higherLowSteps * 7 + Math.max(0, tailStats.pressure) * 35 +
    (recentClosePosition - 0.5) * 18 +
    ((recentBullish - recentBearish) / Math.max(recentFacts.length, 1)) * 12 +
    (recentLowerWick - recentUpperWick) * 8,
    0, 30,
  );
  const timingScore = clamp(
    30 - Math.abs(distanceToResistancePct - 1.6) * 5 -
    Math.max(0, base.advanceFromLow - 7) * 1.5 -
    Math.max(0, distanceToResistancePct - 2.8) * 3,
    0, 30,
  );
  const score = Math.round(baseQuality + buyerScore + timingScore);

  let pattern = 'PRE_BREAKOUT_COMPRESSION';
  if (base.priorPhase?.direction === 'DOWN') pattern = 'DOWNTREND_NEUTRALIZED_PRE_BREAKOUT';
  else if (base.priorPhase?.direction === 'UP') pattern = 'UPTREND_REST_PRE_BREAKOUT';
  if (higherLowSteps >= 3 && highCompression) pattern = 'ASCENDING_COMPRESSION_PRE_BREAKOUT';

  return {
    qualifies: qualifies && score >= CONFIG.MIN_BULLISH_SCORE,
    score,
    pattern,
    metrics: {
      baseHours: base.durationHours,
      baseRangePct: baseStats.rangePct,
      baseRangeLimitPct: base.rangeLimitPct,
      baseTurns: base.turns,
      resistance: resistance,
      resistanceTouches: base.resistance.touches,
      resistanceDistancePct: distanceToResistancePct,
      higherLowSteps,
      lowerLowSteps,
      lowerHighSteps,
      advanceFromBaseLowPct: base.advanceFromLow,
      advanceFromBaseStartPct: base.advanceFromStart,
      rangePosition,
      baseSlope: baseStats.slope,
      recentSlope: tailStats.slope,
      recentPressure: tailStats.pressure,
      priorTrend: base.priorPhase?.direction || 'UNCONFIRMED',
      priorTrendMovePct: base.priorPhase?.movePct ?? 0,
      buyerPressureImproving,
      baseNotFalling,
      priceStillBelowResistance,
      priorDowntrendNeutralized,
      noActiveDowntrend,
      notAlreadyExtended,
    },
  };
}

function analyzeTrend(symbol, candles, pageCount) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;
  const base = findMatureBase(candles);
  if (!base) return {
    symbol,
    bullishCandidate: false,
    bullishScore: 0,
    currentPhase: 'NO_PRE_BREAKOUT_BASE',
    pattern: 'NONE',
    metrics: { candlesAvailable: candles.length, historyPages: pageCount },
  };

  const assessment = assessPreBreakoutReadiness(candles, base);
  const phaseLabels = {
    PRE_BREAKOUT_COMPRESSION: 'فشردگی معتبر زیر مقاومت و پیش از شکست',
    DOWNTREND_NEUTRALIZED_PRE_BREAKOUT: 'خنثی‌شدن روند نزولی و آمادگی زیر مقاومت',
    UPTREND_REST_PRE_BREAKOUT: 'استراحت روند صعودی زیر مقاومت بعدی',
    ASCENDING_COMPRESSION_PRE_BREAKOUT: 'فشردگی صعودی با کف‌های بالاتر زیر مقاومت',
  };
  return {
    symbol,
    bullishCandidate: assessment.qualifies,
    bullishScore: assessment.score,
    currentPhase: assessment.pattern,
    currentPhaseLabel: phaseLabels[assessment.pattern] || assessment.pattern,
    priorTrend: assessment.metrics.priorTrend,
    metrics: {
      candlesAvailable: candles.length,
      historyPages: pageCount,
      ...assessment.metrics,
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
    `${index + 1} — ${name} | امتیاز ساختاری: ${item.bullishScore}/100`,
    `الگو: ${item.currentPhaseLabel}`,
    `مقاومت: ${m.resistance} | فاصله تا مقاومت: ${m.resistanceDistancePct.toFixed(2)}%`,
    `استراحت: ${m.baseHours} ساعت | دامنه پایه: ${m.baseRangePct.toFixed(2)}% | برخورد مقاومت: ${m.resistanceTouches}`,
    `کف بالاتر: ${m.higherLowSteps} | پیشروی از کف پایه: ${m.advanceFromBaseLowPct.toFixed(2)}%`,
  ].join('\n');
}

async function main() {
  console.log('\nGATE.IO | ONE-HOUR PRE-BREAKOUT PRICE-STRUCTURE ENGINE 1');
  console.log('Closed 1h candles only | price structure only | no volume | no BTC comparison');
  console.log('Target: mature compression below resistance before bullish breakout');

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
      b.metrics.resistanceTouches - a.metrics.resistanceTouches ||
      b.metrics.higherLowSteps - a.metrics.higherLowSteps ||
      a.metrics.resistanceDistancePct - b.metrics.resistanceDistancePct ||
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
  console.log(`Pre-breakout candidates: ${candidates.length} | selected: ${selected.length}`);

  const patternCounts = analyzed.reduce((acc, item) => {
    acc[item.currentPhase] = (acc[item.currentPhase] || 0) + 1;
    return acc;
  }, {});
  console.log('Pattern counts:', JSON.stringify(patternCounts));
  for (const item of candidates) {
    const m = item.metrics;
    console.log(
      `${item.symbol} | score=${item.bullishScore} | pattern=${item.currentPhase}` +
      ` | prior=${m.priorTrend} | base=${m.baseHours}h | range=${m.baseRangePct.toFixed(2)}%` +
      ` | resistanceDistance=${m.resistanceDistancePct.toFixed(2)}% | touches=${m.resistanceTouches}` +
      ` | higherLows=${m.higherLowSteps} | rise=${m.advanceFromBaseLowPct.toFixed(2)}%`
    );
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | ENGINE 1 — PRE-BREAKOUT STRUCTURE RADAR',
      'فقط کندل‌های بسته‌شده یک‌ساعته | فقط ساختار قیمت',
      'بدون استفاده از حجم معاملات و بدون مقایسه با بیت‌کوین',
      'تمرکز: فشردگی معتبر زیر مقاومت، کف‌های بالاتر و آمادگی پیش از شکست',
      '━━━━━━━━━━━━━━━━━━',
      ...telegramLines,
    ]);
    console.log('Telegram message sent.');
  } else {
    console.log('No market met strict pre-breakout requirements; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
