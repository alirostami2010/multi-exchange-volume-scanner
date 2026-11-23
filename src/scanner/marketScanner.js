/**
 * GATE.IO USDT PERPETUAL — FULL-HISTORY HOURLY TREND & BULLISH-PROBABILITY SCANNER
 * -----------------------------------------------------------------------------
 * ONE ENGINE ONLY. No Motor 2.
 * - Downloads the available closed 1h history for each eligible contract by paging
 *   backwards until Gate.io has no older candles to return.
 * - Reads recent significant trend phases, not a fixed candle-count lookback.
 * - Finds mature rests/ranges after a prior trend and early, structured bullish readiness.
 * - Uses candle price structure only: no volume data and no BTC comparison.
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
  // Swing detection is structural. A mature rest must last at least 18 closed hours
  // and contain several meaningful price turns; this rejects 1-2 hour pauses.
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MIN_BASE_HOURS: 18,
  MIN_BASE_TURNS: 3,
  MIN_BULLISH_SCORE: 62,
  MAX_BASE_RANGE_PCT: 9,
  MAX_POST_BASE_ADVANCE_PCT: 18,
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
    // Stop once the recent history already contains enough meaningful swing
    // phases to contextualize the current mature base. Do not analyze remote history.
    const accumulated = [...byTime.values()].sort((a, b) => a.time - b.time);
    const meaningfulPhases = getSignificantRecentPhases(accumulated);
    const matureBase = findMatureBase(accumulated);
    if (meaningfulPhases.length >= 6 && (matureBase?.priorPhase || meaningfulPhases.length >= 8)) break;

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
  const closePosition = mean(facts.map((f) => f.closePosition));
  const lowerWick = mean(facts.map((f) => f.lowerWick));
  const upperWick = mean(facts.map((f) => f.upperWick));
  const low = Math.min(...candles.map((c) => c.low));
  const high = Math.max(...candles.map((c) => c.high));
  return {
    slope, structure, pivots, bullish, bearish, closePosition,
    lowerWick, upperWick, low, high,
    returnPct: pct(candles.at(-1).close, candles[0].open),
    rangePct: rangePct(candles),
    closeFromLowPct: pct(candles.at(-1).close, low),
    rangePosition: clamp(safeDiv(candles.at(-1).close - low, high - low, 0.5), 0, 1),
  };
}

function getSignificantRecentPhases(candles) {
  const pivots = findPivots(candles);
  const events = [
    ...pivots.highs.map((p) => ({ ...p, type: 'H' })),
    ...pivots.lows.map((p) => ({ ...p, type: 'L' })),
  ].sort((a, b) => a.index - b.index);

  // Collapse adjacent same-side pivots, retaining the more extreme point.
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

function findMatureBase(candles) {
  const n = candles.length;
  if (n < CONFIG.MIN_BASE_HOURS + 8) return null;
  const recentPhases = getSignificantRecentPhases(candles);
  const recentPhase = recentPhases.at(-1) || null;
  const candleRanges = candles.slice(-Math.min(n, 240)).map(candleRangePct).filter((v) => v > 0);
  const typicalHourlyRange = median(candleRanges) || 0.35;
  const adaptiveRangeLimit = Math.min(
    CONFIG.MAX_BASE_RANGE_PCT,
    Math.max(3.2, typicalHourlyRange * 14),
  );

  // Search backward from the latest closed candle. The base boundary is where
  // price first expands beyond the adaptive range envelope, not a fixed lookback.
  let best = null;
  for (let start = n - CONFIG.MIN_BASE_HOURS; start >= 0; start--) {
    const segment = candles.slice(start);
    if (segment.length < CONFIG.MIN_BASE_HOURS) continue;
    const stats = summarizeCandleBehavior(segment);
    if (!stats || stats.rangePct > adaptiveRangeLimit) continue;
    if (Math.abs(stats.slope) > Math.max(0.035, typicalHourlyRange * 0.10)) continue;

    const turns = stats.pivots.highs.length + stats.pivots.lows.length;
    if (turns < CONFIG.MIN_BASE_TURNS) continue;
    const highTouches = stats.pivots.highs.filter((p) => p.price >= stats.high * 0.985).length;
    const lowTouches = stats.pivots.lows.filter((p) => p.price <= stats.low * 1.015).length;
    if (highTouches < 1 || lowTouches < 1) continue;

    // Reject a base that is merely the first pause in an active decline.
    const latter = segment.slice(Math.floor(segment.length * 0.55));
    const latterStats = summarizeCandleBehavior(latter);
    if (!latterStats || latterStats.slope < -0.025) continue;

    best = { startIndex: start, endIndex: n - 1, candles: segment, stats, turns, highTouches, lowTouches, recentPhases };
    break; // nearest valid mature base is the relevant current structure
  }
  if (!best) return null;

  // A mature base needs actual time and repeated reactions, not just a short pause.
  best.durationHours = best.candles.length;
  best.rangeLimitPct = adaptiveRangeLimit;
  best.priorPhase = [...recentPhases].reverse().find((phase) => phase.endIndex <= best.startIndex && phase.duration >= 6) || null;
  return best;
}

function assessBullishReadiness(candles, base) {
  const baseCandles = base.candles;
  const latest = candles.at(-1);
  const tailLength = Math.max(6, Math.ceil(baseCandles.length * 0.28));
  const tail = baseCandles.slice(-tailLength);
  const tailStats = summarizeCandleBehavior(tail);
  const baseStats = base.stats;
  const lows = baseStats.pivots.lows.slice(-5);
  const highs = baseStats.pivots.highs.slice(-5);
  const higherLowSteps = lows.length >= 2
    ? lows.slice(1).filter((p, i) => p.price > lows[i].price).length : 0;
  const lowerLowSteps = lows.length >= 2
    ? lows.slice(1).filter((p, i) => p.price < lows[i].price).length : 0;
  const higherHighSteps = highs.length >= 2
    ? highs.slice(1).filter((p, i) => p.price > highs[i].price).length : 0;
  const lowerHighSteps = highs.length >= 2
    ? highs.slice(1).filter((p, i) => p.price < highs[i].price).length : 0;
  const baseLow = Math.min(...baseCandles.map((c) => c.low));
  const baseHigh = Math.max(...baseCandles.map((c) => c.high));
  const advanceFromBaseLow = pct(latest.close, baseLow);
  const advanceFromBaseStart = pct(latest.close, baseCandles[0].open);
  const rangePosition = clamp(safeDiv(latest.close - baseLow, baseHigh - baseLow, 0.5), 0, 1);
  const lastFacts = baseCandles.slice(-Math.min(12, baseCandles.length)).map(candleFacts);
  const lastClosePosition = mean(lastFacts.map((f) => f.closePosition));
  const lastBullish = lastFacts.filter((f) => f.bullish).length;
  const lastBearish = lastFacts.filter((f) => f.bearish).length;
  const lowerWick = mean(lastFacts.map((f) => f.lowerWick));
  const upperWick = mean(lastFacts.map((f) => f.upperWick));

  const buyersImproving =
    (higherLowSteps >= 1 && tailStats.slope > 0.015) ||
    (lastClosePosition >= 0.60 && lastBullish > lastBearish) ||
    (lowerWick > upperWick + 0.07 && rangePosition > 0.48);
  const structureTurning = higherLowSteps >= 1 || higherHighSteps >= 1 ||
    (tailStats.slope > 0.025 && tailStats.returnPct > 0.35);
  const stillEarly = advanceFromBaseLow <= CONFIG.MAX_POST_BASE_ADVANCE_PCT &&
    advanceFromBaseStart <= CONFIG.MAX_POST_BASE_ADVANCE_PCT && rangePosition < 0.94;
  const notFreshDowntrendBounce = base.durationHours >= CONFIG.MIN_BASE_HOURS &&
    lowerLowSteps <= 1 && Math.abs(baseStats.slope) <= 0.055;

  // Pattern classification is descriptive; all candidates must pass mature-base
  // and buyer-readiness gates, so an unconfirmed first bounce is not selected.
  let pattern = 'MATURE_RANGE_PREPARING';
  const prior = base.priorPhase;
  if (prior?.direction === 'UP') pattern = 'UPTREND_REST_OR_CORRECTION';
  else if (prior?.direction === 'DOWN') pattern = 'DOWNTREND_BASED_RECOVERY';
  if (higherLowSteps >= 2 && tailStats.slope > 0.02) pattern = 'ASCENDING_RANGE';
  if (tailStats.slope > 0.035 && tailStats.returnPct > 0.8 && advanceFromBaseLow < 12) pattern = 'GRADUAL_EARLY_RISE';
  if (lowerWick > upperWick + 0.12 && higherLowSteps >= 1) pattern = 'ROUNDED_BULLISH_RECOVERY';

  const baseQuality = clamp(
    25 + Math.min(base.durationHours / 3, 20) + base.turns * 2 +
    higherLowSteps * 7 - lowerLowSteps * 8 - baseStats.rangePct * 1.2,
    0, 45,
  );
  const buyerScore = clamp(
    15 + higherLowSteps * 9 + higherHighSteps * 5 +
    (lastClosePosition - 0.5) * 25 +
    ((lastBullish - lastBearish) / Math.max(lastFacts.length, 1)) * 15 +
    (lowerWick - upperWick) * 12 + tailStats.slope * 100,
    0, 35,
  );
  const timingScore = clamp(
    20 + (stillEarly ? 10 : -15) + (rangePosition > 0.55 && rangePosition < 0.88 ? 8 : 0) -
    Math.max(0, advanceFromBaseLow - 10) * 1.5,
    0, 30,
  );
  const score = Math.round(baseQuality + buyerScore + timingScore);
  const qualifies = buyersImproving && structureTurning && stillEarly &&
    notFreshDowntrendBounce && score >= CONFIG.MIN_BULLISH_SCORE;

  return {
    qualifies, score, pattern,
    metrics: {
      baseHours: base.durationHours,
      baseRangePct: baseStats.rangePct,
      baseRangeLimitPct: base.rangeLimitPct,
      baseTurns: base.turns,
      higherLowSteps, lowerLowSteps, higherHighSteps, lowerHighSteps,
      advanceFromBaseLowPct: advanceFromBaseLow,
      advanceFromBaseStartPct: advanceFromBaseStart,
      rangePosition,
      baseSlope: baseStats.slope,
      recentSlope: tailStats.slope,
      priorTrend: prior?.direction || 'UNCONFIRMED',
      priorTrendMovePct: prior?.movePct ?? 0,
      buyersImproving,
      structureTurning,
      stillEarly,
    },
  };
}

function analyzeTrend(symbol, candles, pageCount) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_BASE_HOURS + 10) return null;
  const base = findMatureBase(candles);
  if (!base) return {
    symbol, bullishCandidate: false, bullishScore: 0,
    currentPhase: 'NO_MATURE_BASE', pattern: 'NONE',
    metrics: { candlesAvailable: candles.length, historyPages: pageCount },
  };
  const assessment = assessBullishReadiness(candles, base);
  const priorTrend = assessment.metrics.priorTrend;
  const phaseLabels = {
    UPTREND_REST_OR_CORRECTION: 'استراحت یا اصلاح پس از روند صعودی',
    DOWNTREND_BASED_RECOVERY: 'پایان روند نزولی و تشکیل پایه',
    MATURE_RANGE_PREPARING: 'رنج معتبر و آماده‌سازی صعود',
    ASCENDING_RANGE: 'رنج صعودی با کف‌های بالاتر',
    GRADUAL_EARLY_RISE: 'شروع صعود آرام و تدریجی',
    ROUNDED_BULLISH_RECOVERY: 'برگشت قوسی و تدریجی',
  };
  return {
    symbol,
    bullishCandidate: assessment.qualifies,
    bullishScore: assessment.score,
    currentPhase: assessment.pattern,
    currentPhaseLabel: phaseLabels[assessment.pattern] || assessment.pattern,
    priorTrend,
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
    `روند قبلی: ${m.priorTrend === 'UP' ? 'صعودی' : m.priorTrend === 'DOWN' ? 'نزولی' : 'نامشخص'}`,
    `استراحت: ${m.baseHours} ساعت | دامنه رنج: ${m.baseRangePct.toFixed(2)}% | کف بالاتر: ${m.higherLowSteps}`,
    `پیشروی از کف پایه: ${m.advanceFromBaseLowPct.toFixed(2)}%`,
  ].join('\n');
}

async function main() {
  console.log('\nGATE.IO | ONE-HOUR PRICE-STRUCTURE ENGINE 1');
  console.log('Closed 1h candles only | price structure only | no volume | no BTC comparison');

  const contracts = await getContracts();
  if (!Array.isArray(contracts)) throw new Error('داده قراردادهای Gate.io معتبر نیست.');

  const namedContracts = contracts.filter((c) => c?.name);
  const cryptoContracts = namedContracts.filter(isSupportedCryptoContract);
  const markets = cryptoContracts
    .map((c) => c.name)
    .sort();

  let checked = 0;
  let failed = 0;
  let insufficient = 0;
  let totalCandles = 0;
  let totalPages = 0;

  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (symbol) => {
    const history = await getClosedHourlyCandlesWithRetry(symbol);
    if (history.candles.length < CONFIG.MIN_BASE_HOURS + 10) {
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
      b.metrics.higherLowSteps - a.metrics.higherLowSteps ||
      b.metrics.baseHours - a.metrics.baseHours || a.symbol.localeCompare(b.symbol));
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
  console.log(`Mature-base bullish candidates: ${candidates.length} | selected: ${selected.length}`);

  const patternCounts = analyzed.reduce((acc, item) => {
    acc[item.currentPhase] = (acc[item.currentPhase] || 0) + 1;
    return acc;
  }, {});
  console.log('Pattern counts:', JSON.stringify(patternCounts));
  for (const item of candidates) {
    const m = item.metrics;
    console.log(`${item.symbol} | score=${item.bullishScore} | pattern=${item.currentPhase} | prior=${m.priorTrend} | base=${m.baseHours}h | range=${m.baseRangePct.toFixed(2)}% | rise=${m.advanceFromBaseLowPct.toFixed(2)}% | higherLows=${m.higherLowSteps}`);
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | ENGINE 1 — EARLY BULLISH STRUCTURE RADAR',
      'فقط کندل‌های بسته‌شده یک‌ساعته | فقط ساختار قیمت',
      'بدون استفاده از حجم معاملات و بدون مقایسه با بیت‌کوین',
      'تمرکز: پایان روند نزولی/اصلاح، رنج معتبر و آمادگی پیش از جهش',
      '━━━━━━━━━━━━━━━━━━',
      ...telegramLines,
    ]);
    console.log('Telegram message sent.');
  } else {
    console.log('No market met the mature-base + bullish-readiness requirements; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
