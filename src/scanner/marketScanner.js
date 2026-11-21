
/**
 * GATE.IO USDT PERPETUAL — EARLY LONG BREAKOUT RADAR
 * --------------------------------------------------
 * LONG ONLY
 *
 * Strategy:
 * 15m = Fresh consolidation breakout detection
 * 1h  = Trend confirmation
 * 4h  = Overhead resistance / room-to-grow filter
 *
 * Diagnostics:
 * - Detailed 15m breakout rejection diagnostics
 * - Breakout volume details
 * - Detailed 1h EMA diagnostics
 * - Detailed 4h room diagnostics
 * - API rate-limit protection
 * - Reliable Telegram delivery
 *
 * File: src/scanner/marketScanner.js
 */

import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',

  TIMEFRAMES: {
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 }
  },

  TOP_COUNT: 30,
  MIN_QUOTE_VOLUME_24H: 100000,

  // API protection
  CONCURRENCY: 3,
  REQUEST_INTERVAL_MS: 150,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,

  // Telegram reliability
  TELEGRAM_RETRIES: 4,
  TELEGRAM_REQUEST_TIMEOUT: 15000,

  // Consolidation detection
  CONSOLIDATION_CANDLES: 12,
  MAX_CONSOLIDATION_RANGE: 5.0,

  // Breakout conditions
  MIN_BREAKOUT_PERCENT: 0.10,
  MAX_BREAKOUT_EXTENSION: 1.25,
  MIN_CANDLE_RETURN: 0.15,
  MIN_CLOSE_LOCATION: 0.65,

  // Volume
  VOLUME_BASELINE_CANDLES: 20,
  MIN_VOLUME_RATIO: 1.35,
  MIN_CANDLE_ELAPSED_SECONDS: 180,

  // Trend
  EMA_PERIOD: 20,
  EMA_SLOPE_LOOKBACK: 5,

  // 4h resistance
  RESISTANCE_CANDLES_4H: 10,
  MIN_RESISTANCE_ROOM: 0.80,

  // Ranking
  MIN_SCORE: 55
};

// ============================================================
// UTILITIES
// ============================================================

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const median = values => {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const pctChange = (current, previous) => {
  if (!previous || previous <= 0) return 0;

  return ((current - previous) / previous) * 100;
};

const formatPrice = value => {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);

  return value.toPrecision(5);
};

const formatTurnover = value =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2
  }).format(number(value));

const formatPercent = value => {
  if (!Number.isFinite(value)) return '-';

  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}%`;
};

const getContractMultiplier = contract => {
  const multiplier = number(contract?.quanto_multiplier, 1);
  return multiplier > 0 ? multiplier : 1;
};

// ============================================================
// API REQUEST PACING
// ============================================================

let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextRequestAt);

  nextRequestAt =
    scheduledAt + CONFIG.REQUEST_INTERVAL_MS;

  const wait = scheduledAt - now;

  if (wait > 0) {
    await sleep(wait);
  }
}

function getRetryAfterMs(response) {
  const value = response?.headers?.get('retry-after');

  if (!value) return 0;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return 0;
}

// ============================================================
// DIAGNOSTICS
// ============================================================

function createDiagnostics() {
  return {
    validData: 0,
    consolidation: 0,

    // Breakout diagnostics
    breakoutChecks: 0,
    breakoutBelowResistance: 0,
    breakoutNearResistance: 0,
    breakoutAboveMax: 0,
    candleReturnRejected: 0,
    invalidCandleRange: 0,
    closeLocationRejected: 0,

    breakout: 0,
    volume: 0,
    trend: 0,
    room: 0,
    score: 0,

    // Breakout rejection samples
    breakoutSamples: [],

    // Breakout volume details
    volumeSamples: [],

    // Detailed diagnostics for volume-confirmed breakouts
    trendSamples: []
  };
}

function getTrendFailureReasons(trend) {
  const reasons = [];

  if (!trend.dataValid) {
    reasons.push('داده EMA نامعتبر');
    return reasons;
  }

  if (!trend.lastCloseAboveEMA) {
    reasons.push('قیمت بسته‌شدن زیر EMA20');
  }

  if (!trend.livePriceAboveEMA) {
    reasons.push('قیمت زنده زیر EMA20');
  }

  if (!trend.positiveSlope) {
    reasons.push('شیب EMA مثبت نیست');
  }

  return reasons;
}

function getRoomFailureReason(room) {
  if (!room.dataValid) {
    return 'داده مقاومت 4H نامعتبر';
  }

  if (!room.passed) {
    return `فضای رشد کمتر از ${CONFIG.MIN_RESISTANCE_ROOM.toFixed(2)}%`;
  }

  return 'تأیید شد';
}

function formatBreakoutDiagnostics(d) {
  const lines = [
    '🔬 تشخیص علت رد شکست 15M:',
    `🔎 تعداد بررسی شکست: ${d.breakoutChecks}`,
    `🔴 قیمت زیر مقاومت: ${d.breakoutBelowResistance}`,
    `🟡 نزدیک مقاومت، اما شکست کمتر از ${CONFIG.MIN_BREAKOUT_PERCENT.toFixed(2)}%: ${d.breakoutNearResistance}`,
    `🚀 عبور بیش از حد مجاز ${CONFIG.MAX_BREAKOUT_EXTENSION.toFixed(2)}%: ${d.breakoutAboveMax}`,
    `📉 رشد کندل کمتر از ${CONFIG.MIN_CANDLE_RETURN.toFixed(2)}%: ${d.candleReturnRejected}`,
    `⚠️ دامنه کندل نامعتبر: ${d.invalidCandleRange}`,
    `📍 موقعیت Close کمتر از ${CONFIG.MIN_CLOSE_LOCATION.toFixed(2)}: ${d.closeLocationRejected}`,
    `✅ شکست تأییدشده: ${d.breakout}`,
    '',
    '📋 نمونه ارزهای بررسی‌شده در مرحله شکست:'
  ];

  const samples = [...d.breakoutSamples]
    .sort((a, b) => {
      // Show the samples with the strongest proximity/breakout first.
      return b.breakoutPercent - a.breakoutPercent;
    })
    .slice(0, 12);

  if (!samples.length) {
    lines.push('هیچ نمونه‌ای برای بررسی شکست ثبت نشد.');
  } else {
    for (const sample of samples) {
      const status = sample.passed ? '✅' : '❌';

      lines.push(
        `${status} ${sample.symbol} | فاصله از مقاومت: ${formatPercent(sample.breakoutPercent)}`
      );

      lines.push(
        `   رشد کندل: ${formatPercent(sample.candleReturn)} | موقعیت Close: ${sample.closeLocation === null ? '-' : sample.closeLocation.toFixed(2)}`
      );

      lines.push(
        `   قیمت: ${formatPrice(sample.livePrice)} | مقاومت: ${formatPrice(sample.resistance)}`
      );

      if (sample.failedChecks.length) {
        lines.push(
          `   علت رد: ${sample.failedChecks.join('، ')}`
        );
      } else {
        lines.push('   نتیجه: تمام شروط شکست تأیید شدند.');
      }
    }
  }

  lines.push(
    '',
    'ℹ️ شمارنده‌های علت رد مستقل هستند؛ یک ارز می‌تواند هم‌زمان در چند علت رد ثبت شود.'
  );

  return lines.join('\n');
}

function formatDiagnostics(d) {
  const lines = [
    '🔬 مراحل عبور ارزها:',
    `1️⃣ داده معتبر: ${d.validData}`,
    `2️⃣ تشکیل تراکم: ${d.consolidation}`,
    `3️⃣ شکست معتبر: ${d.breakout}`,
    `4️⃣ تأیید حجم: ${d.volume}`,
    `5️⃣ تأیید روند 1H: ${d.trend}`,
    `6️⃣ فضای رشد 4H: ${d.room}`,
    `7️⃣ امتیاز نهایی: ${d.score}`,
    '',
    formatBreakoutDiagnostics(d),
    '',
    '📊 بررسی حجم شکست‌های معتبر:'
  ];

  const volumeSamples = [...d.volumeSamples]
    .sort((a, b) => b.volumeRatio - a.volumeRatio)
    .slice(0, 8);

  if (!volumeSamples.length) {
    lines.push('در این اسکن شکست معتبری برای بررسی حجم ثبت نشد.');
  } else {
    for (const sample of volumeSamples) {
      const status =
        sample.volumeRatio >= CONFIG.MIN_VOLUME_RATIO
          ? '✅'
          : '❌';

      lines.push(
        `${status} ${sample.symbol} | نسبت حجم: ${sample.volumeRatio.toFixed(2)}x`
      );

      lines.push(
        `   گردش جاری: ${formatTurnover(sample.currentTurnover)} | مبنا: ${formatTurnover(sample.baselineTurnover)}`
      );

      lines.push(
        `   حجم موردانتظار: ${formatTurnover(sample.expectedTurnover)} | زمان کندل: ${sample.elapsedSeconds}s`
      );
    }
  }

  lines.push(
    `📌 حداقل نسبت حجم موردنیاز: ${CONFIG.MIN_VOLUME_RATIO.toFixed(2)}x`
  );

  // ----------------------------------------------------------
  // 1H + 4H DIAGNOSTICS
  // ----------------------------------------------------------

  lines.push(
    '',
    '🔍 بررسی تشخیصی ارزهای دارای شکست + حجم تأییدشده:'
  );

  const trendSamples = [...d.trendSamples]
    .sort((a, b) => b.volumeRatio - a.volumeRatio)
    .slice(0, 10);

  if (!trendSamples.length) {
    lines.push(
      'ارزی با شکست و حجم تأییدشده برای بررسی 1H و 4H ثبت نشد.'
    );

    return lines.join('\n');
  }

  for (const sample of trendSamples) {
    const trendStatus = sample.trend.passed
      ? '✅'
      : '❌';

    const roomStatus = sample.room.passed
      ? '✅'
      : '❌';

    lines.push('');
    lines.push(
      `${trendStatus} ${sample.symbol} | حجم ${sample.volumeRatio.toFixed(2)}x`
    );

    lines.push(
      `   1H EMA20: ${formatPrice(sample.trend.ema)}`
    );

    lines.push(
      `   قیمت زنده: ${formatPrice(sample.trend.livePrice)} | فاصله از EMA: ${formatPercent(sample.trend.liveDistancePct)}`
    );

    lines.push(
      `   آخرین Close: ${formatPrice(sample.trend.lastClose)} | فاصله از EMA: ${formatPercent(sample.trend.closeDistancePct)}`
    );

    lines.push(
      `   شیب EMA20: ${formatPercent(sample.trend.emaSlope)}`
    );

    lines.push(
      `   شروط 1H: Close ${sample.trend.lastCloseAboveEMA ? '✅' : '❌'} | Live ${sample.trend.livePriceAboveEMA ? '✅' : '❌'} | Slope ${sample.trend.positiveSlope ? '✅' : '❌'}`
    );

    if (sample.trend.passed) {
      lines.push('   نتیجه 1H: تأیید شد');
    } else {
      lines.push(
        `   علت رد 1H: ${sample.trend.failureReasons.join('، ')}`
      );
    }

    lines.push(
      `   4H مقاومت: ${formatPrice(sample.room.resistance)}`
    );

    lines.push(
      `   فضای رشد 4H: ${formatPercent(sample.room.roomPercent)}`
    );

    lines.push(
      `   نتیجه 4H: ${roomStatus} ${getRoomFailureReason(sample.room)}`
    );
  }

  lines.push(
    '',
    'ℹ️ این بخش صرفاً تشخیصی است و در پذیرش یا رد ارزها تغییری ایجاد نمی‌کند.'
  );

  return lines.join('\n');
}

// ============================================================
// CANDLE TURNOVER
// ============================================================

const candleValue = (candle, multiplier = 1) => {
  const turnover = number(candle?.turnover);

  if (turnover > 0) return turnover;

  const volume = Math.max(0, number(candle?.volume));
  const close = Math.max(0, number(candle?.close));

  return volume * close * multiplier;
};

const getMax = (candles, field) =>
  Math.max(...candles.map(c => number(c[field])));

const getMin = (candles, field) =>
  Math.min(...candles.map(c => number(c[field])));

// ============================================================
// HTTP
// ============================================================

async function fetchJSON(url) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= CONFIG.RETRIES;
    attempt++
  ) {
    try {
      await waitForRequestSlot();

      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
      });

      if (!response.ok) {
        const retryAfterMs =
          getRetryAfterMs(response);

        const body = await response.text();

        const error = new Error(
          `HTTP ${response.status}: ${body.slice(0, 200)}`
        );

        error.status = response.status;
        error.retryAfterMs = retryAfterMs;

        throw error;
      }

      return await response.json();

    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        const exponentialBackoff =
          1500 * Math.pow(2, attempt - 1);

        const jitter = Math.floor(
          Math.random() * 500
        );

        const retryDelay =
          error.status === 429
            ? Math.max(
                error.retryAfterMs || 0,
                exponentialBackoff + jitter
              )
            : 700 * attempt + jitter;

        console.warn(
          `⚠️ API retry ${attempt}/${CONFIG.RETRIES} | ${error.status || 'NETWORK'} | wait ${Math.ceil(retryDelay / 1000)}s`
        );

        await sleep(retryDelay);
      }
    }
  }

  throw lastError;
}

// ============================================================
// GATE.IO API
// ============================================================

async function getContracts() {
  return fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/contracts`
  );
}

async function getTickers() {
  return fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/tickers`
  );
}

async function getCandles(
  contract,
  interval,
  limit,
  includeCurrent = false
) {
  const params = new URLSearchParams({
    contract,
    interval,
    limit: String(limit)
  });

  const raw = await fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`
  );

  if (!Array.isArray(raw)) {
    throw new Error(`Invalid candles: ${contract} ${interval}`);
  }

  const candles = raw
    .map(c => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),
      volume: number(c.v),
      turnover: number(c.sum)
    }))
    .filter(c =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  const seconds = CONFIG.TIMEFRAMES[interval].seconds;

  const currentBucket =
    Math.floor(Date.now() / 1000 / seconds) * seconds;

  const closed = candles.filter(
    c => c.time < currentBucket
  );

  if (!includeCurrent) return closed;

  const current =
    candles.find(c => c.time === currentBucket) || null;

  return { closed, current };
}

// ============================================================
// CONCURRENCY
// ============================================================

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = {
          error: error.message,
          item: items[index]
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runner()
    )
  );

  return results;
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  const result = [ema];

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;

    result.push(ema);
  }

  return result;
}

// ============================================================
// 15M CONSOLIDATION
// ============================================================

function analyzeConsolidation(candles) {
  const count = CONFIG.CONSOLIDATION_CANDLES;

  if (candles.length < count) return null;

  const rangeCandles = candles.slice(-count);

  const resistance = getMax(rangeCandles, 'high');
  const support = getMin(rangeCandles, 'low');

  if (resistance <= 0 || support <= 0) return null;

  const midpoint = (resistance + support) / 2;

  const rangePercent =
    ((resistance - support) / midpoint) * 100;

  if (
    !Number.isFinite(rangePercent) ||
    rangePercent > CONFIG.MAX_CONSOLIDATION_RANGE
  ) {
    return null;
  }

  return {
    resistance,
    support,
    rangePercent
  };
}

// ============================================================
// BREAKOUT DETECTION + DETAILED DIAGNOSTICS
// ============================================================

function analyzeBreakout(
  closed15m,
  current15m,
  livePrice,
  diagnostics,
  symbol
) {
  if (!current15m || !livePrice) return null;

  const consolidation = analyzeConsolidation(
    closed15m
  );

  if (!consolidation) return null;

  diagnostics.consolidation++;
  diagnostics.breakoutChecks++;

  const {
    resistance,
    support,
    rangePercent
  } = consolidation;

  // ----------------------------------------------------------
  // Calculate all breakout measurements first.
  // This allows independent diagnostics for every condition.
  // ----------------------------------------------------------

  const breakoutPercent = pctChange(
    livePrice,
    resistance
  );

  const candleReturn = pctChange(
    livePrice,
    current15m.open
  );

  const currentHigh = Math.max(
    current15m.high,
    livePrice
  );

  const currentLow = Math.min(
    current15m.low,
    livePrice
  );

  const currentRange = currentHigh - currentLow;

  const validCandleRange =
    Number.isFinite(currentRange) &&
    currentRange > 0;

  const closeLocation = validCandleRange
    ? clamp(
        (livePrice - currentLow) / currentRange,
        0,
        1
      )
    : null;

  // ----------------------------------------------------------
  // Independent condition checks
  // ----------------------------------------------------------

  const belowResistance =
    breakoutPercent < 0;

  const nearResistance =
    breakoutPercent >= 0 &&
    breakoutPercent < CONFIG.MIN_BREAKOUT_PERCENT;

  const aboveMaximum =
    breakoutPercent > CONFIG.MAX_BREAKOUT_EXTENSION;

  const candleReturnRejected =
    candleReturn < CONFIG.MIN_CANDLE_RETURN;

  const invalidCandleRange =
    !validCandleRange;

  const closeLocationRejected =
    validCandleRange &&
    closeLocation < CONFIG.MIN_CLOSE_LOCATION;

  // ----------------------------------------------------------
  // Update independent diagnostic counters
  // One coin can be counted in multiple rejection categories.
  // ----------------------------------------------------------

  if (belowResistance) {
    diagnostics.breakoutBelowResistance++;
  }

  if (nearResistance) {
    diagnostics.breakoutNearResistance++;
  }

  if (aboveMaximum) {
    diagnostics.breakoutAboveMax++;
  }

  if (candleReturnRejected) {
    diagnostics.candleReturnRejected++;
  }

  if (invalidCandleRange) {
    diagnostics.invalidCandleRange++;
  }

  if (closeLocationRejected) {
    diagnostics.closeLocationRejected++;
  }

  // ----------------------------------------------------------
  // Collect rejection reasons
  // ----------------------------------------------------------

  const failedChecks = [];

  if (belowResistance) {
    failedChecks.push('قیمت هنوز زیر مقاومت است');
  } else if (nearResistance) {
    failedChecks.push('شکست کمتر از حداقل مجاز');
  }

  if (aboveMaximum) {
    failedChecks.push('قیمت بیش از حد از مقاومت فاصله گرفته');
  }

  if (candleReturnRejected) {
    failedChecks.push('رشد کندل کافی نیست');
  }

  if (invalidCandleRange) {
    failedChecks.push('دامنه کندل نامعتبر است');
  } else if (closeLocationRejected) {
    failedChecks.push('موقعیت قیمت در کندل ضعیف است');
  }

  const passed =
    !belowResistance &&
    !nearResistance &&
    !aboveMaximum &&
    !candleReturnRejected &&
    !invalidCandleRange &&
    !closeLocationRejected;

  // ----------------------------------------------------------
  // Store a limited number of diagnostic samples.
  // These samples do not affect trading decisions.
  // ----------------------------------------------------------

  if (diagnostics.breakoutSamples.length < 30) {
    diagnostics.breakoutSamples.push({
      symbol,
      passed,

      breakoutPercent,
      candleReturn,
      closeLocation,

      livePrice,
      resistance,
      support,
      rangePercent,

      failedChecks
    });
  }

  // ----------------------------------------------------------
  // Original acceptance logic preserved:
  // All original conditions must pass.
  // ----------------------------------------------------------

  if (!passed) return null;

  diagnostics.breakout++;

  return {
    resistance,
    support,
    rangePercent,
    breakoutPercent,
    candleReturn,
    closeLocation
  };
}

// ============================================================
// VOLUME CONFIRMATION + DIAGNOSTICS
// ============================================================

function getCurrentVolumeDetails(
  closedCandles,
  currentCandle,
  multiplier
) {
  if (!currentCandle) return null;

  if (
    closedCandles.length <
    CONFIG.VOLUME_BASELINE_CANDLES
  ) {
    return null;
  }

  const baselineCandles = closedCandles.slice(
    -CONFIG.VOLUME_BASELINE_CANDLES
  );

  const baseline = median(
    baselineCandles.map(c =>
      candleValue(c, multiplier)
    )
  );

  if (baseline <= 0) return null;

  const nowSeconds = Date.now() / 1000;

  const elapsedSeconds = clamp(
    nowSeconds - currentCandle.time,
    CONFIG.MIN_CANDLE_ELAPSED_SECONDS,
    CONFIG.TIMEFRAMES['15m'].seconds
  );

  const expectedTurnover =
    baseline *
    (
      elapsedSeconds /
      CONFIG.TIMEFRAMES['15m'].seconds
    );

  if (expectedTurnover <= 0) return null;

  const currentTurnover =
    candleValue(currentCandle, multiplier);

  const volumeRatio =
    currentTurnover / expectedTurnover;

  return {
    volumeRatio,
    currentTurnover,
    baselineTurnover: baseline,
    expectedTurnover,
    elapsedSeconds
  };
}

// ============================================================
// 1H TREND CONFIRMATION + DETAILED DIAGNOSTICS
// ============================================================

function analyze1hTrend(candles, livePrice) {
  if (
    candles.length <
    CONFIG.EMA_PERIOD + 6
  ) {
    return {
      dataValid: false,
      passed: false,
      failureReasons: ['تعداد کندل کافی نیست']
    };
  }

  const closes = candles.map(c => c.close);

  const emaValues = calculateEMA(
    closes,
    CONFIG.EMA_PERIOD
  );

  if (
    emaValues.length <
    CONFIG.EMA_SLOPE_LOOKBACK + 1
  ) {
    return {
      dataValid: false,
      passed: false,
      failureReasons: ['محاسبه EMA نامعتبر است']
    };
  }

  const currentEMA = emaValues.at(-1);

  const previousEMA = emaValues[
    -(CONFIG.EMA_SLOPE_LOOKBACK + 1)
  ];

  const emaSlope = pctChange(
    currentEMA,
    previousEMA
  );

  const lastClose = closes.at(-1);

  const lastCloseAboveEMA =
    lastClose > currentEMA;

  const livePriceAboveEMA =
    livePrice > currentEMA;

  const aboveEMA =
    lastCloseAboveEMA &&
    livePriceAboveEMA;

  const positiveSlope = emaSlope > 0;

  const passed =
    aboveEMA &&
    positiveSlope;

  const result = {
    dataValid: true,
    passed,

    ema: currentEMA,
    emaSlope,

    lastClose,
    livePrice,

    // Percentage distance from EMA20
    closeDistancePct: pctChange(
      lastClose,
      currentEMA
    ),

    liveDistancePct: pctChange(
      livePrice,
      currentEMA
    ),

    lastCloseAboveEMA,
    livePriceAboveEMA,
    aboveEMA,
    positiveSlope
  };

  result.failureReasons =
    getTrendFailureReasons(result);

  return result;
}

// ============================================================
// 4H RESISTANCE / ROOM TO GROW + DIAGNOSTICS
// ============================================================

function analyze4hRoom(candles, livePrice) {
  const count = CONFIG.RESISTANCE_CANDLES_4H;

  if (candles.length < count) {
    return {
      dataValid: false,
      passed: false,
      failureReason: 'تعداد کندل کافی نیست'
    };
  }

  const recent = candles.slice(-count);

  const resistance = getMax(recent, 'high');

  if (resistance <= 0) {
    return {
      dataValid: false,
      passed: false,
      failureReason: 'مقاومت نامعتبر است'
    };
  }

  if (livePrice >= resistance) {
    return {
      dataValid: true,
      passed: true,

      resistance,
      roomPercent: 100,
      hasOverheadResistance: false
    };
  }

  const roomPercent = pctChange(
    resistance,
    livePrice
  );

  const passed =
    roomPercent >= CONFIG.MIN_RESISTANCE_ROOM;

  return {
    dataValid: true,
    passed,

    resistance,
    roomPercent,
    hasOverheadResistance: true,

    failureReason: passed
      ? null
      : `فضای رشد ${roomPercent.toFixed(3)}% کمتر از حداقل ${CONFIG.MIN_RESISTANCE_ROOM.toFixed(2)}%`
  };
}

// ============================================================
// RANKING
// ============================================================

function calculateBreakoutScore({
  breakout,
  volumeRatio,
  trend,
  room
}) {
  const breakoutScore = clamp(
    65 + breakout.breakoutPercent * 15,
    0,
    100
  );

  const volumeScore = clamp(
    50 + Math.log2(Math.max(0.01, volumeRatio)) * 30,
    0,
    100
  );

  const compressionScore = clamp(
    100 - breakout.rangePercent * 12,
    0,
    100
  );

  const trendScore = clamp(
    65 + trend.emaSlope * 20,
    0,
    100
  );

  const roomScore = room.roomPercent >= 100
    ? 100
    : clamp(
        room.roomPercent * 20,
        0,
        100
      );

  const candleScore =
    breakout.closeLocation * 100;

  const score = Math.round(
    breakoutScore * 0.25 +
    volumeScore * 0.25 +
    compressionScore * 0.10 +
    trendScore * 0.20 +
    roomScore * 0.10 +
    candleScore * 0.10
  );

  return {
    score,
    components: {
      breakout: Math.round(breakoutScore),
      volume: Math.round(volumeScore),
      compression: Math.round(compressionScore),
      trend: Math.round(trendScore),
      room: Math.round(roomScore),
      candle: Math.round(candleScore)
    }
  };
}

// ============================================================
// COIN ANALYSIS
// ============================================================

function analyzeCoin(data, diagnostics) {
  const {
    symbol,
    candles15m,
    candles1h,
    candles4h,
    current15m,
    livePrice,
    contract
  } = data;

  if (
    candles15m.length < 25 ||
    candles1h.length < 30 ||
    candles4h.length < 15 ||
    !current15m ||
    !livePrice
  ) {
    return null;
  }

  const multiplier = getContractMultiplier(contract);

  // 1. Detect breakout
  const breakout = analyzeBreakout(
    candles15m,
    current15m,
    livePrice,
    diagnostics,
    symbol
  );

  if (!breakout) return null;

  // 2. Calculate volume details
  const volumeDetails = getCurrentVolumeDetails(
    candles15m,
    current15m,
    multiplier
  );

  if (!volumeDetails) return null;

  const {
    volumeRatio,
    currentTurnover,
    baselineTurnover,
    expectedTurnover,
    elapsedSeconds
  } = volumeDetails;

  // Save diagnostic sample BEFORE volume filtering.
  diagnostics.volumeSamples.push({
    symbol,
    volumeRatio,
    currentTurnover,
    baselineTurnover,
    expectedTurnover,
    elapsedSeconds
  });

  if (volumeRatio < CONFIG.MIN_VOLUME_RATIO) {
    return null;
  }

  diagnostics.volume++;

  // ----------------------------------------------------------
  // 3. Evaluate BOTH 1h and 4h
  //    4h is evaluated even when 1h fails.
  //    This section is diagnostic and does not change
  //    the original acceptance conditions.
  // ----------------------------------------------------------

  const trend = analyze1hTrend(
    candles1h,
    livePrice
  );

  const room = analyze4hRoom(
    candles4h,
    livePrice
  );

  // Save detailed diagnostic sample for every
  // volume-confirmed breakout.
  diagnostics.trendSamples.push({
    symbol,
    volumeRatio,

    trend: {
      dataValid: trend.dataValid,
      passed: trend.passed,

      ema: trend.ema,
      emaSlope: trend.emaSlope,

      lastClose: trend.lastClose,
      livePrice: trend.livePrice,

      closeDistancePct: trend.closeDistancePct,
      liveDistancePct: trend.liveDistancePct,

      lastCloseAboveEMA: trend.lastCloseAboveEMA,
      livePriceAboveEMA: trend.livePriceAboveEMA,
      positiveSlope: trend.positiveSlope,

      failureReasons: trend.failureReasons || []
    },

    room: {
      dataValid: room.dataValid,
      passed: room.passed,

      resistance: room.resistance,
      roomPercent: room.roomPercent,
      hasOverheadResistance: room.hasOverheadResistance,

      failureReason: room.failureReason
    }
  });

  // Original 1h acceptance condition preserved.
  if (!trend.passed) return null;

  diagnostics.trend++;

  // Original 4h acceptance condition preserved.
  if (!room.passed) return null;

  diagnostics.room++;

  // 5. Ranking
  const ranking = calculateBreakoutScore({
    breakout,
    volumeRatio,
    trend,
    room
  });

  if (ranking.score < CONFIG.MIN_SCORE) {
    return null;
  }

  diagnostics.score++;

  const strength =
    ranking.score >= 85
      ? 'شکست صعودی بسیار قوی'
      : ranking.score >= 75
        ? 'شکست صعودی قوی'
        : ranking.score >= 65
          ? 'شکست صعودی معتبر'
          : 'شروع شکست صعودی';

  const stage =
    breakout.breakoutPercent <= 0.50
      ? 'شروع حرکت'
      : breakout.breakoutPercent <= 0.90
        ? 'شتاب حرکت'
        : 'شکست در حال گسترش';

  return {
    symbol,

    price: livePrice,
    livePrice,

    score: ranking.score,
    strength,
    stage,

    pressureScore: breakout.closeLocation * 100,
    pressureQuality: 'BREAKOUT_PRICE_ACTION',
    closeLocation: breakout.closeLocation,

    momentum: {
      '15m': breakout.candleReturn,
      '1h': trend.emaSlope,
      '4h': pctChange(
        candles4h.at(-1).close,
        candles4h.at(-2).close
      )
    },

    volume: {
      '15m': volumeRatio,
      '1h': 0,
      '4h': 0
    },

    components: ranking.components,

    breakout: {
      resistance: breakout.resistance,
      support: breakout.support,
      extension: breakout.breakoutPercent,
      consolidationRange: breakout.rangePercent
    },

    trend: {
      ema: trend.ema,
      emaSlope: trend.emaSlope
    },

    room: {
      resistance: room.resistance,
      percent: room.roomPercent,
      hasOverheadResistance: room.hasOverheadResistance
    },

    confirmations: [
      '15m_BREAKOUT',
      '15m_VOLUME',
      '1h_TREND',
      '4h_ROOM'
    ],

    contract
  };
}

// ============================================================
// TELEGRAM — RELIABLE DELIVERY
// ============================================================

function getNestedErrorCodes(error) {
  const codes = new Set();
  const visited = new Set();

  function inspect(value, depth = 0) {
    if (!value || depth > 5) return;

    if (typeof value !== 'object') return;
    if (visited.has(value)) return;

    visited.add(value);

    if (value.code) {
      codes.add(String(value.code).toUpperCase());
    }

    if (value.cause) {
      inspect(value.cause, depth + 1);
    }

    if (Array.isArray(value.errors)) {
      for (const item of value.errors) {
        inspect(item, depth + 1);
      }
    } else if (value.errors) {
      inspect(value.errors, depth + 1);
    }
  }

  inspect(error);

  return [...codes];
}

function isRetryableTelegramError(error) {
  const status = Number(error?.status);

  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ECONNABORTED'
  ]);

  const codes = getNestedErrorCodes(error);

  if (codes.some(code => retryableCodes.has(code))) {
    return true;
  }

  if (
    error instanceof TypeError &&
    /fetch failed|network|socket/i.test(error.message)
  ) {
    return true;
  }

  if (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError'
  ) {
    return true;
  }

  return false;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    const error = new Error(
      'TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.'
    );

    error.permanent = true;
    throw error;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(
        CONFIG.TELEGRAM_REQUEST_TIMEOUT
      )
    }
  );

  let result = null;

  try {
    result = await response.json();
  } catch {
    // Invalid or empty response body.
  }

  if (!response.ok || !result?.ok) {
    const error = new Error(
      result?.description ||
      `Telegram HTTP ${response.status}`
    );

    error.status = response.status;

    error.retryAfter =
      number(result?.parameters?.retry_after, 0);

    error.retryAfterMs =
      error.retryAfter * 1000;

    throw error;
  }

  return true;
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text.split('\n\n').filter(Boolean);
  const messages = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current
      ? `${current}\n\n${block}`
      : block;

    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) messages.push(current);

      if (block.length > maxLength) {
        let remaining = block;

        while (remaining.length > maxLength) {
          messages.push(
            remaining.slice(0, maxLength)
          );

          remaining = remaining.slice(maxLength);
        }

        current = remaining;
      } else {
        current = block;
      }
    }
  }

  if (current) messages.push(current);

  return messages;
}

async function sendTelegramWithRetry(message, messageIndex) {
  let lastError = null;
  let attemptsMade = 0;

  for (
    let attempt = 1;
    attempt <= CONFIG.TELEGRAM_RETRIES;
    attempt++
  ) {
    attemptsMade = attempt;

    try {
      await sendTelegram(message);

      return {
        sent: true,
        attempts: attempt
      };

    } catch (error) {
      lastError = error;

      const retryable =
        isRetryableTelegramError(error);

      if (
        !retryable ||
        attempt >= CONFIG.TELEGRAM_RETRIES
      ) {
        break;
      }

      const exponentialBackoff =
        1500 * Math.pow(2, attempt - 1);

      const jitter = Math.floor(
        Math.random() * 700
      );

      const retryAfterMs = Math.max(
        number(error.retryAfterMs, 0),
        number(error.retryAfter, 0) * 1000
      );

      const delay =
        error.status === 429
          ? Math.max(
              retryAfterMs,
              exponentialBackoff + jitter
            )
          : exponentialBackoff + jitter;

      console.warn(
        `⚠️ Telegram retry ${attempt}/${CONFIG.TELEGRAM_RETRIES - 1} | Message ${messageIndex} | ${error.status || error.code || error.name || 'NETWORK'} | wait ${Math.ceil(delay / 1000)}s`
      );

      await sleep(delay);
    }
  }

  return {
    sent: false,
    attempts: attemptsMade,
    error: lastError
  };
}

async function sendReports(report) {
  const messages = splitTelegramMessage(
    report,
    CONFIG.TELEGRAM_MAX_LENGTH - 50
  );

  let sentCount = 0;
  let failedCount = 0;

  const failures = [];

  console.log(
    `\n📨 Telegram: sending ${messages.length} report message(s)...`
  );

  for (let i = 0; i < messages.length; i++) {
    const payload =
      `📄 گزارش ${i + 1}/${messages.length}\n\n` +
      messages[i];

    const result = await sendTelegramWithRetry(
      payload,
      `${i + 1}/${messages.length}`
    );

    if (result.sent) {
      sentCount++;

      console.log(
        `✅ Telegram message ${i + 1}/${messages.length} sent.`
      );

    } else {
      failedCount++;

      const errorMessage =
        result.error?.message || 'Unknown Telegram error';

      failures.push({
        message: i + 1,
        error: errorMessage
      });

      console.error(
        `❌ Telegram message ${i + 1}/${messages.length} failed after ${result.attempts} attempt(s): ${errorMessage}`
      );
    }

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_DELAY);
    }
  }

  const deliveryResult = {
    sent: failedCount === 0,
    total: messages.length,
    sentCount,
    failedCount,
    failures
  };

  if (failedCount > 0) {
    console.warn(
      `⚠️ Telegram delivery incomplete: ${sentCount}/${messages.length} messages sent.`
    );
  } else {
    console.log(
      `✅ Telegram delivery completed: ${sentCount}/${messages.length} messages sent.`
    );
  }

  return deliveryResult;
}

// ============================================================
// REPORT
// ============================================================

function buildReport(
  candidates,
  stats,
  duration,
  rankChanges
) {
  const lines = [
    '🚀 GATE.IO | EARLY LONG BREAKOUT RADAR',
    '━━━━━━━━━━━━━━━━━━',
    '🎯 شکست تازه محدوده تراکم + تأیید حجم',
    '⏱ تحلیل: 15M | 1H | 4H',
    '🔄 اجرای اسکن هر ۵ دقیقه؛ بدون دخالت در امتیاز',
    `📊 بازار: ${stats.active} | نقدشونده: ${stats.liquid}`,
    `✅ دریافت موفق: ${stats.success} | خطا: ${stats.errors}`,
    `⏱ زمان اسکن: ${(duration / 1000).toFixed(1)} ثانیه`,
    '━━━━━━━━━━━━━━━━━━',
    formatDiagnostics(stats.diagnostics),
    '━━━━━━━━━━━━━━━━━━'
  ];

  if (!candidates.length) {
    lines.push(
      '🔎 در این اسکن شکست صعودی واجد شرایط پیدا نشد.'
    );

    return lines.join('\n');
  }

  candidates.forEach((coin, index) => {
    const change = rankChanges?.[coin.symbol];

    const rankIcon =
      !change || change.status === 'NEW'
        ? '🆕'
        : change.status === 'UP'
          ? `🟢↑${change.change}`
          : change.status === 'DOWN'
            ? `🔴↓${Math.abs(change.change)}`
            : '➖';

    lines.push(
      `${index + 1}. ${coin.symbol} ${rankIcon} | ⭐ ${coin.score}/100`
    );

    lines.push(
      `🚀 ${coin.stage} | رشد 15m: +${coin.momentum['15m'].toFixed(2)}%`
    );

    lines.push(
      `📊 حجم: ${coin.volume['15m'].toFixed(2)}x | شکست: +${coin.breakout.extension.toFixed(2)}% | محدوده: ${coin.breakout.consolidationRange.toFixed(2)}%`
    );

    lines.push('');
  });

  lines.push(
    '━━━━━━━━━━━━━━━━━━',
    'ℹ️ این گزارش کاندیدای شکست است؛ نه تضمین ادامه رشد یا دستور ورود.'
  );

  return lines.join('\n');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const startedAt = Date.now();

  const diagnostics = createDiagnostics();

  console.log('\n🚀 GATE.IO EARLY LONG BREAKOUT RADAR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('⏱ Analysis: 15m / 1h / 4h');
  console.log('🎯 Strategy: Consolidation Breakout + Volume');
  console.log('🔄 Scan schedule does not affect score');
  console.log(
    `🛡 API protection: Concurrency ${CONFIG.CONCURRENCY} | Interval ${CONFIG.REQUEST_INTERVAL_MS}ms`
  );

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers()
  ]);

  if (
    !Array.isArray(contracts) ||
    !Array.isArray(tickers)
  ) {
    throw new Error(
      'داده قراردادها یا تیکرها معتبر نیست.'
    );
  }

  const tickerMap = new Map(
    tickers.map(ticker => [
      ticker.contract,
      ticker
    ])
  );

  const activeContracts = contracts.filter(
    contract =>
      contract?.name &&
      contract.in_delisting !== true &&
      tickerMap.has(contract.name)
  );

  const liquidMarkets = activeContracts
    .map(contract => {
      const ticker = tickerMap.get(contract.name);

      return {
        symbol: contract.name,
        contract,
        ticker,
        quoteVolume: number(ticker.volume_24h_quote),
        lastPrice: number(ticker.last)
      };
    })
    .filter(market =>
      market.lastPrice > 0 &&
      market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log(`📊 Active: ${activeContracts.length}`);
  console.log(`💧 Liquid: ${liquidMarkets.length}`);

  let success = 0;
  let errors = 0;

  const results = await mapLimit(
    liquidMarkets,
    CONFIG.CONCURRENCY,
    async market => {
      const [
        candles15Data,
        candles1h,
        candles4h
      ] = await Promise.all([
        getCandles(
          market.symbol,
          '15m',
          CONFIG.TIMEFRAMES['15m'].limit,
          true
        ),

        getCandles(
          market.symbol,
          '1h',
          CONFIG.TIMEFRAMES['1h'].limit
        ),

        getCandles(
          market.symbol,
          '4h',
          CONFIG.TIMEFRAMES['4h'].limit
        )
      ]);

      if (
        candles15Data.closed.length < 25 ||
        candles1h.length < 30 ||
        candles4h.length < 15 ||
        !candles15Data.current
      ) {
        throw new Error(
          'کندل کافی یا کندل جاری 15m دریافت نشد.'
        );
      }

      // Valid market data received.
      diagnostics.validData++;

      const coin = analyzeCoin({
        symbol: market.symbol,

        candles15m: candles15Data.closed,
        candles1h,
        candles4h,

        current15m: candles15Data.current,

        livePrice: market.lastPrice,

        contract: market.contract
      }, diagnostics);

      success++;

      return coin;
    }
  );

  const candidates = [];

  for (const result of results) {
    if (result?.error) {
      errors++;

      console.error(
        `⚠️ ${result.item?.symbol || 'UNKNOWN'}: ${result.error}`
      );

      continue;
    }

    if (result) candidates.push(result);
  }

  // ----------------------------------------------------------
  // STORAGE + RANKING
  // ----------------------------------------------------------

  const storageResult = await saveMarketSnapshot(candidates);

  const rankedCandidates =
    storageResult.rankedCandidates || candidates;

  const rankChanges = storageResult.rankChanges || {};

  const duration = Date.now() - startedAt;

  const stats = {
    active: activeContracts.length,
    liquid: liquidMarkets.length,
    success,
    errors,
    diagnostics
  };

  // ----------------------------------------------------------
  // CONSOLE
  // ----------------------------------------------------------

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏆 TOP LONG BREAKOUT CANDIDATES');

  rankedCandidates
    .slice(0, CONFIG.TOP_COUNT)
    .forEach((coin, index) => {
      console.log(
        `${index + 1}. ${coin.symbol} | ${coin.score}/100 | Volume ${coin.volume['15m'].toFixed(2)}x | Breakout ${coin.breakout?.extension?.toFixed(2) ?? '-'}%`
      );
    });

  console.log('\n' + formatDiagnostics(diagnostics));

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Candidates: ${rankedCandidates.length}`);
  console.log(`Successful: ${success}`);
  console.log(`Errors: ${errors}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

  console.log(
    `💾 History: ${storageResult.historyCount} | Summaries: ${storageResult.summaryCount}`
  );

  // ----------------------------------------------------------
  // TELEGRAM
  // ----------------------------------------------------------

  const report = buildReport(
    rankedCandidates.slice(0, CONFIG.TOP_COUNT),
    stats,
    duration,
    rankChanges
  );

  const telegramResult = await sendReports(report);

  if (telegramResult.sent) {
    console.log('\n✅ All Telegram reports sent successfully.');
  } else {
    console.warn(
      '\n⚠️ Scan completed, but Telegram delivery was incomplete.'
    );

    console.warn(
      `📨 Sent: ${telegramResult.sentCount}/${telegramResult.total}`
    );
  }

  console.log('\n✅ SCAN COMPLETED.');
}

// ============================================================
// START
// ============================================================

main().catch(error => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
