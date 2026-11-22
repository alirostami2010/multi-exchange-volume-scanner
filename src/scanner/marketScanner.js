/**
 * GATE.IO USDT PERPETUAL — FULL-HISTORY HOURLY TREND & BULLISH-PROBABILITY SCANNER
 * -----------------------------------------------------------------------------
 * ONE ENGINE ONLY. No Motor 2.
 * - Downloads the available closed 1h history for each eligible contract by paging
 *   backwards until Gate.io has no older candles to return.
 * - Uses the complete available history to describe the long-term/past structure.
 * - Uses adaptive recent context to describe the current market regime.
 * - Evaluates observable evidence that the next directional phase may be bullish.
 * - Volume is diagnostic only; BTC relative strength is not used as a gate or score.
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
  MIN_CANDLES: 48,
  MIN_QUOTE_VOLUME_24H: 100000,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  CONCURRENCY: 5,
  REQUEST_TIMEOUT: 20000,
  RETRIES: 4,
  MAX_RESULTS: 10,
  PAGE_PAUSE_MS: 90,
  // These are analysis horizons, NOT history download limits.
  CURRENT_CONTEXT_HOURS: 72,
  SHORT_CONTEXT_HOURS: 24,
  PRESSURE_CONTEXT_HOURS: 12,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MIN_BULLISH_SCORE: 58,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });
      if (!response.ok) {
        const error = new Error(`Gate.io HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.RETRIES) {
        const delay = error.status === 429 ? 2200 * attempt : 700 * attempt;
        await sleep(delay);
      }
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
 * Fetch all available closed hourly candles. Each page asks Gate.io for the
 * latest page ending before the previous page's oldest candle. There is no
 * configured historical lookback cap; paging ends when the exchange returns
 * no older page / no progress.
 */
async function getClosedHourlyCandles(contract) {
  const currentBucket = Math.floor(Date.now() / CONFIG.CANDLE_SECONDS) * CONFIG.CANDLE_SECONDS;
  const byTime = new Map();
  let pageEnd = currentBucket - 1;
  let pageCount = 0;
  let oldestSeen = Infinity;

  while (true) {
    // Gate.io rejects `limit` together with `from` or `to`. Use an explicit
    // 2000-hour time window per page instead (2000 points maximum per query).
    const pageStart = Math.max(1, pageEnd - ((CONFIG.CANDLE_PAGE_SIZE - 1) * CONFIG.CANDLE_SECONDS));
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
      isValidCandle(c) && c.time < currentBucket && c.time <= pageEnd
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

    // A short page means the exchange has no earlier data for this contract.
    if (raw.length < CONFIG.CANDLE_PAGE_SIZE) break;
    await sleep(CONFIG.PAGE_PAUSE_MS);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { candles, pages: pageCount };
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

function analyzeTrend(symbol, candles, quoteVolume24h, pageCount) {
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
  const phaseLabels = {
    UPTREND_PAUSE_OR_PULLBACK: 'استراحت/اصلاح در روند صعودی',
    UPWARD_TREND_CONTINUATION: 'ادامه روند رو به بالا',
    POSSIBLE_DOWNTREND_EXHAUSTION: 'احتمال تضعیف روند نزولی',
    BULLISH_TRANSITION: 'تغییر رفتار به نفع خریداران',
    SIDEWAYS_OR_CONSOLIDATING: 'رنج/تراکم',
    MIXED_TRANSITION: 'گذار نامشخص',
    ACTIVE_DOWNTREND: 'روند نزولی فعال',
  };
  return `${index + 1} — ${name} | امتیاز شواهد صعودی: ${item.bullishScore}/100 | ${phaseLabels[item.currentPhase] || item.currentPhase}`;
}

async function main() {
  console.log('\nGATE.IO FULL-HISTORY HOURLY TREND SCANNER');
  console.log('Mode: one engine | all available closed 1h history | past + current trend + bullish-potential assessment | max 10');

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

  let checked = 0;
  let failed = 0;
  let insufficient = 0;
  let totalCandles = 0;
  let totalPages = 0;

  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const history = await getClosedHourlyCandles(market.symbol);
    if (history.candles.length < CONFIG.MIN_CANDLES) {
      insufficient++;
      return null;
    }
    checked++;
    totalCandles += history.candles.length;
    totalPages += history.pages;
    return analyzeTrend(market.symbol, history.candles, market.quoteVolume, history.pages);
  });

  for (const result of results) {
    if (result?.error) failed++;
  }

  const analyzed = results.filter((r) => r && !r.error);
  const candidates = analyzed
    .filter((r) => r.bullishCandidate)
    .sort((a, b) =>
      b.bullishScore - a.bullishScore ||
      b.metrics.pressureChange - a.metrics.pressureChange ||
      b.metrics.higherLowSteps - a.metrics.higherLowSteps ||
      a.symbol.localeCompare(b.symbol)
    );
  const selected = candidates.slice(0, CONFIG.MAX_RESULTS);
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
  console.log(`Markets analyzed with complete available closed ${CONFIG.TIMEFRAME} history: ${checked}`);
  console.log(`Markets with insufficient history: ${insufficient}`);
  console.log(`Markets with data errors: ${failed}`);
  console.log(`Historical candles processed: ${totalCandles}`);
  console.log(`Historical API pages processed: ${totalPages}`);
  console.log(`Bullish-potential candidates: ${candidates.length}`);
  console.log(`Selected symbols: ${selected.length}`);
  console.log('Current phase counts:', JSON.stringify(phaseCounts));

  if (candidates.length) {
    console.log('Bullish-potential ranking:');
    for (const item of candidates) {
      const m = item.metrics;
      console.log(
        `${item.symbol} | score=${item.bullishScore} | past=${item.pastTrend} | ` +
        `current=${item.currentTrend} | phase=${item.currentPhase} | ` +
        `history=${m.candlesAvailable} candles | ` +
        `return=${m.currentReturnPct.toFixed(2)}% | ` +
        `pressureChange=${m.pressureChange.toFixed(3)} | ` +
        `higherLows=${m.higherLowSteps} | ` +
        `evidence=${JSON.stringify(item.scoreBreakdown)}`
      );
    }
  }

  if (telegramLines.length) {
    await sendTelegram([
      'GATE.IO | HOURLY BULLISH-POTENTIAL RADAR',
      'تحلیل تاریخچه کامل کندل‌های بسته‌شده یک‌ساعته',
      'این فهرست ارزیابی احتمال صعود است، نه سیگنال ورود یا تضمین حرکت.',
      '━━━━━━━━━━━━━━━━━━',
      ...telegramLines,
    ]);
    console.log('Telegram message sent.');
  } else {
    console.log('No symbol met the bullish-potential evidence threshold; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
