/**
 * GATE.IO USDT PERPETUAL — EARLY BULLISH TRANSITION RADAR
 * -----------------------------------------------------------------
 * ONE ENGINE ONLY. No Motor 2.
 * - Closed 1h candles only.
 * - Price structure only: no volume and no BTC comparison.
 * - Finds early bullish transitions after sideways bases, downtrend exhaustion,
 *   or pauses/pullbacks inside an existing uptrend.
 * - Scores seller exhaustion, improving buyer pressure, higher lows,
 *   early structure recovery and freshness before the main upward expansion.
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
  MIN_BULLISH_SCORE: 67,
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
  const closePosition = clamp((c.close - c.low) / range, 0, 1);
  return {
    bullish: body > 0,
    bearish: body < 0,
    bodyRatio: body / range,
    closePosition,
    lowerWick: clamp((Math.min(c.open, c.close) - c.low) / range, 0, 1),
    upperWick: clamp((c.high - Math.max(c.open, c.close)) / range, 0, 1),
    rangePct: c.close > 0 ? (range / c.close) * 100 : 0,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function meanRangePct(candles) {
  return mean(candles.map(c => candleFacts(c).rangePct));
}

function pctRange(candles) {
  if (!candles.length) return 0;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  const reference = mean(candles.map(c => c.close));
  return reference > 0 ? ((high - low) / reference) * 100 : 0;
}

function logSlope(candles) {
  if (candles.length < 3) return 0;
  const values = candles.map(c => Math.log(Math.max(c.close, Number.EPSILON)));
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length; i++) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator ? (numerator / denominator) * 100 : 0;
}

function pressure(candles) {
  if (!candles.length) return 0;
  return mean(candles.map(c => {
    const f = candleFacts(c);
    return (f.bodyRatio * 0.55) + ((f.closePosition - 0.5) * 0.9);
  }));
}

function sellerPressure(candles) {
  if (!candles.length) return 0;
  return mean(candles.map(c => {
    const f = candleFacts(c);
    return f.bearish ? Math.abs(f.bodyRatio) * (1.15 - f.closePosition) : 0;
  }));
}

function directionalEfficiency(candles, direction = 'down') {
  if (candles.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < candles.length; i++) {
    path += Math.abs(pct(candles[i].close, candles[i - 1].close));
  }
  const net = pct(candles.at(-1).close, candles[0].open);
  const favorable = direction === 'down' ? Math.max(0, -net) : Math.max(0, net);
  return path > 0 ? favorable / path : 0;
}

function pivotLows(candles) {
  const points = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const low = candles[i].low;
    if (candles[i - 1].low > low && candles[i - 2].low > low &&
        candles[i + 1].low > low && candles[i + 2].low > low) {
      points.push({ index: i, price: low });
    }
  }
  return points;
}

function countHigherLows(points) {
  let count = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].price > points[i - 1].price * 1.001) count++;
  }
  return count;
}

function analyzeSetup(candles, baseLength, triggerLength) {
  const baseEnd = candles.length - triggerLength;
  const baseStart = baseEnd - baseLength;
  const contextLength = Math.min(36, Math.max(18, Math.floor(baseLength * 0.5)));
  const contextStart = baseStart - contextLength;
  if (contextStart < 0) return null;

  const context = candles.slice(contextStart, baseStart);
  const base = candles.slice(baseStart, baseEnd);
  const trigger = candles.slice(baseEnd);
  if (base.length !== baseLength || trigger.length !== triggerLength) return null;

  const firstBase = base.slice(0, Math.floor(base.length / 2));
  const secondBase = base.slice(Math.floor(base.length / 2));
  const last = candles.at(-1);
  const baseLow = Math.min(...base.map(c => c.low));
  const baseHigh = Math.max(...base.map(c => c.high));
  const triggerLow = Math.min(...trigger.map(c => c.low));
  const triggerHigh = Math.max(...trigger.map(c => c.high));
  const atrPct = Math.max(median(candles.slice(-80).map(c => candleFacts(c).rangePct)), 0.01);
  const baseRange = pctRange(base);
  const baseRangeInAtr = baseRange / (atrPct * Math.sqrt(baseLength));
  const contextReturn = pct(context.at(-1).close, context[0].open);
  const baseReturn = pct(base.at(-1).close, base[0].open);
  const triggerReturn = pct(last.close, trigger[0].open);
  const totalRiseFromLow = pct(last.close, Math.min(baseLow, triggerLow));
  const triggerMoveInAtr = triggerReturn / (atrPct * Math.sqrt(triggerLength));

  const contextDownEfficiency = directionalEfficiency(context, 'down');
  const firstHalfDownPressure = sellerPressure(firstBase);
  const secondHalfDownPressure = sellerPressure(secondBase);
  const sellerFade = secondHalfDownPressure < firstHalfDownPressure * 0.88 ||
    (secondHalfDownPressure <= firstHalfDownPressure + 0.025 &&
     mean(secondBase.map(c => candleFacts(c).lowerWick)) > mean(firstBase.map(c => candleFacts(c).lowerWick)) + 0.025);

  const lows = pivotLows(base);
  const higherLowCount = countHigherLows(lows);
  const firstHalfLow = Math.min(...firstBase.map(c => c.low));
  const secondHalfLow = Math.min(...secondBase.map(c => c.low));
  const lowHold = secondHalfLow >= firstHalfLow * 0.992;
  const baseStable = lowHold || higherLowCount > 0;
  const contraction = meanRangePct(secondBase) <= meanRangePct(firstBase) * 1.08;
  const baseQuiet = baseRangeInAtr <= 2.65 || contraction;

  const basePressure = pressure(base.slice(-12));
  const triggerPressure = pressure(trigger);
  const pressureShift = triggerPressure - basePressure;
  const triggerFacts = trigger.map(candleFacts);
  const bullishCount = triggerFacts.filter(f => f.bullish).length;
  const bearishCount = triggerFacts.filter(f => f.bearish).length;
  const triggerClosePosition = mean(triggerFacts.map(f => f.closePosition));
  const bullishQuality = triggerClosePosition >= 0.57 &&
    (bullishCount >= Math.ceil(triggerLength * 0.5) ||
     triggerFacts.filter(f => f.bullish && f.closePosition >= 0.68).length >= 2);

  const microWindow = base.slice(-8);
  const microHigh = Math.max(...microWindow.map(c => c.high));
  const reclaimed = last.close > microHigh;
  const aboveBaseMean = last.close > mean(base.slice(-10).map(c => c.close));
  const buyerTurn = (pressureShift >= 0.06 && triggerClosePosition >= 0.54) ||
    (bullishCount > bearishCount && triggerClosePosition >= 0.62);

  const contextSlope = logSlope(context);
  const baseSlope = logSlope(base);
  const priorTrend = logSlope(candles.slice(Math.max(0, contextStart - 36), contextStart));
  let phase = 'SIDEWAYS_BASE';
  if (contextReturn <= -Math.max(1.2, atrPct * 2.2) || contextSlope < -0.055) phase = 'DOWNTREND_EXHAUSTION';
  else if (priorTrend > 0.045 && contextReturn < -Math.max(0.8, atrPct * 1.4)) phase = 'UPTREND_PULLBACK';

  const fresh = totalRiseFromLow <= Math.max(5.5, atrPct * 7.5) &&
    pct(last.close, candles.at(-7).close) <= Math.max(2.8, atrPct * 4.2) &&
    pct(last.close, candles.at(-13).close) <= Math.max(4.5, atrPct * 6.5);
  const notFalling = logSlope(trigger) > -0.025 && !(triggerLow < baseLow * 0.985 && triggerReturn < 0);
  const notExploded = triggerHigh <= baseHigh * 1.045 && triggerReturn <= Math.max(4.0, atrPct * 6.0);
  const contextRelevant = phase !== 'SIDEWAYS_BASE' || Math.abs(contextReturn) <= Math.max(4.5, atrPct * 7.0);

  const parts = {
    sellerExhaustion: (sellerFade ? 13 : 0) + (contextDownEfficiency > 0.22 && secondHalfDownPressure < firstHalfDownPressure ? 7 : 0),
    baseFormation: (baseStable ? 10 : 0) + (baseQuiet ? 9 : 0) + (contraction ? 4 : 0),
    buyerActivation: (buyerTurn ? 12 : 0) + (bullishQuality ? 9 : 0) + (pressureShift > 0 ? clamp(pressureShift * 35, 0, 6) : 0),
    structureReclaim: (reclaimed ? 9 : 0) + (aboveBaseMean ? 5 : 0) + Math.min(4, higherLowCount * 2),
    freshness: fresh ? 12 : 0,
    context: contextRelevant ? 4 : 0,
  };
  const penalties = {
    falling: notFalling ? 0 : 16,
    extended: fresh ? 0 : Math.min(18, Math.max(0, totalRiseFromLow - 4) * 2),
    breakoutLate: notExploded ? 0 : 14,
    weakBase: baseRangeInAtr > 4.2 ? 8 : 0,
  };
  const score = Math.round(clamp(Object.values(parts).reduce((a, b) => a + b, 0) -
    Object.values(penalties).reduce((a, b) => a + b, 0), 0, 100));

  const coreEvidence = [baseStable, baseQuiet, buyerTurn, bullishQuality, reclaimed || aboveBaseMean, fresh]
    .filter(Boolean).length;
  const qualifies = score >= CONFIG.MIN_BULLISH_SCORE && coreEvidence >= 4 &&
    baseStable && buyerTurn && bullishQuality && fresh && notFalling && notExploded;

  return {
    qualifies, score, phase,
    metrics: {
      baseHours: baseLength, triggerHours: triggerLength,
      baseRangePct: baseRange, baseRangeInAtr,
      contextReturnPct: contextReturn, baseReturnPct: baseReturn,
      triggerReturnPct: triggerReturn, triggerMoveInAtr,
      pressureImprovement: pressureShift,
      sellerPressureChange: secondHalfDownPressure - firstHalfDownPressure,
      sellerFade, buyerTurn, bullishQuality,
      higherLows: higherLowCount, lowHold, baseStable, baseQuiet, contraction,
      reclaimed, aboveBaseMean, fresh, notFalling, notExploded,
      riseFromBaseLowPct: totalRiseFromLow,
      recent6hRisePct: pct(last.close, candles.at(-7).close),
      recent12hRisePct: pct(last.close, candles.at(-13).close),
      recentBullish: bullishCount, recentBearish: bearishCount,
      recentClosePosition: triggerClosePosition, coreEvidence,
      scoreParts: parts, penalties,
      reasons: [
        sellerFade ? 'کاهش فشار فروش' : null,
        baseStable ? 'تثبیت کف‌ها' : null,
        baseQuiet ? 'تشکیل پایه کم‌نوسان' : null,
        buyerTurn ? 'چرخش فشار به نفع خریداران' : null,
        bullishQuality ? 'کیفیت مناسب کندل‌های صعودی' : null,
        reclaimed ? 'بازپس‌گیری سقف کوتاه‌مدت' : aboveBaseMean ? 'بازگشت بالای میانگین پایه' : null,
        fresh ? 'حرکت هنوز کشیده نشده' : null,
      ].filter(Boolean),
    },
  };
}

function analyzeTrend(symbol, candles, pageCount) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;
  let best = null;
  for (let baseLength = 24; baseLength <= 84; baseLength += 6) {
    for (let triggerLength = 4; triggerLength <= 8; triggerLength += 2) {
      const result = analyzeSetup(candles, baseLength, triggerLength);
      if (!result) continue;
      if (!best || result.score > best.score) best = result;
    }
  }
  if (!best) return {
    symbol, bullishCandidate: false, bullishScore: 0,
    currentPhase: 'NO_EARLY_BULLISH_TRANSITION', pattern: 'NONE',
    metrics: { candlesAvailable: candles.length, historyPages: pageCount },
  };
  const labels = {
    SIDEWAYS_BASE: 'پایان سکون و تقویت تدریجی خریداران',
    DOWNTREND_EXHAUSTION: 'تضعیف روند نزولی و احتمال آغاز صعود',
    UPTREND_PULLBACK: 'پایان اصلاح و احتمال شروع موج بعدی',
  };
  return {
    symbol,
    bullishCandidate: best.qualifies,
    bullishScore: best.score,
    currentPhase: best.phase,
    currentPhaseLabel: labels[best.phase],
    metrics: { candlesAvailable: candles.length, historyPages: pageCount, ...best.metrics },
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
    `${index + 1} — ${name} | امتیاز ساختار پیش‌صعود: ${item.bullishScore}/100`,
    `وضعیت: ${item.currentPhaseLabel}`,
    `پایه: ${m.baseHours} ساعت | فعال‌سازی: ${m.triggerHours} ساعت | دامنه پایه: ${m.baseRangePct.toFixed(2)}%`,
    `چرخش فشار خریدار: ${m.pressureImprovement.toFixed(3)} | تغییر فشار فروش: ${m.sellerPressureChange.toFixed(3)}`,
    `ثبات کف: ${m.baseStable ? 'بله' : 'خیر'} | بازپس‌گیری سقف: ${m.reclaimed ? 'بله' : 'خیر'} | رشد از کف: ${m.riseFromBaseLowPct.toFixed(2)}%`,
    `شواهد: ${m.reasons.join('، ')}`,
  ].join('\n');
}
async function main() {
  console.log('\nGATE.IO | ONE-HOUR EARLY BULLISH TRANSITION ENGINE 1');
  console.log('Closed 1h candles only | price structure only | no volume | no BTC comparison');
  console.log('Target: identify early price-behavior transition before the main expansion');
  console.log('One engine | closed 1h candles | price structure only | no indicators, volume or BTC comparison');

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
  for (const item of candidates) {
    const m = item.metrics;
    console.log(
      `${item.symbol} | score=${item.bullishScore} | context=${item.currentPhase}` +
      ` | base=${m.baseHours}h | range=${m.baseRangePct.toFixed(2)}%` +
      ` | pressureDelta=${m.pressureImprovement.toFixed(3)} | sellerDelta=${m.sellerPressureChange.toFixed(3)}` +
      ` | higherLows=${m.higherLows} | rise=${m.riseFromBaseLowPct.toFixed(2)}%` +
      ` | 6h=${m.recent6hRisePct.toFixed(2)}% | 12h=${m.recent12hRisePct.toFixed(2)}%`
    );
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | ENGINE 1 — EARLY BULLISH TRANSITION RADAR',
      'فقط کندل‌های بسته‌شده یک‌ساعته | فقط ساختار قیمت',
      'بدون استفاده از حجم معاملات و بدون مقایسه با بیت‌کوین',
      'تمرکز: شناسایی احتمال صعود پیش از شروع حرکت اصلی',
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
