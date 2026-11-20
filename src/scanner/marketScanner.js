
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
 * Diagnostic counters added.
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

  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,

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

const getContractMultiplier = contract => {
  const multiplier = number(contract?.quanto_multiplier, 1);
  return multiplier > 0 ? multiplier : 1;
};

// ============================================================
// DIAGNOSTICS
// ============================================================

function createDiagnostics() {
  return {
    validData: 0,
    consolidation: 0,
    breakout: 0,
    volume: 0,
    trend: 0,
    room: 0,
    score: 0
  };
}

function formatDiagnostics(d) {
  return [
    '🔬 مراحل عبور ارزها:',
    `1️⃣ داده معتبر: ${d.validData}`,
    `2️⃣ تشکیل تراکم: ${d.consolidation}`,
    `3️⃣ شکست معتبر: ${d.breakout}`,
    `4️⃣ تأیید حجم: ${d.volume}`,
    `5️⃣ تأیید روند 1H: ${d.trend}`,
    `6️⃣ فضای رشد 4H: ${d.room}`,
    `7️⃣ امتیاز نهایی: ${d.score}`
  ].join('\n');
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

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
      });

      if (!response.ok) {
        const body = await response.text();

        const error = new Error(
          `HTTP ${response.status}: ${body.slice(0, 200)}`
        );

        error.status = response.status;
        throw error;
      }

      return await response.json();

    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        await sleep(
          error.status === 429
            ? 2500 * attempt
            : 700 * attempt
        );
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
// BREAKOUT DETECTION
// ============================================================

function analyzeBreakout(
  closed15m,
  current15m,
  livePrice,
  diagnostics
) {
  if (!current15m || !livePrice) return null;

  const consolidation = analyzeConsolidation(
    closed15m
  );

  if (!consolidation) return null;

  diagnostics.consolidation++;

  const {
    resistance,
    support,
    rangePercent
  } = consolidation;

  const breakoutPercent = pctChange(
    livePrice,
    resistance
  );

  if (
    breakoutPercent < CONFIG.MIN_BREAKOUT_PERCENT ||
    breakoutPercent > CONFIG.MAX_BREAKOUT_EXTENSION
  ) {
    return null;
  }

  const candleReturn = pctChange(
    livePrice,
    current15m.open
  );

  if (candleReturn < CONFIG.MIN_CANDLE_RETURN) {
    return null;
  }

  const currentHigh = Math.max(
    current15m.high,
    livePrice
  );

  const currentLow = Math.min(
    current15m.low,
    livePrice
  );

  const currentRange = currentHigh - currentLow;

  if (currentRange <= 0) return null;

  const closeLocation = clamp(
    (livePrice - currentLow) / currentRange,
    0,
    1
  );

  if (
    closeLocation < CONFIG.MIN_CLOSE_LOCATION
  ) {
    return null;
  }

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
// VOLUME CONFIRMATION
// ============================================================

function getCurrentVolumeRatio(
  closedCandles,
  currentCandle,
  multiplier
) {
  if (!currentCandle) return 0;

  if (
    closedCandles.length <
    CONFIG.VOLUME_BASELINE_CANDLES
  ) {
    return 0;
  }

  const baselineCandles = closedCandles.slice(
    -CONFIG.VOLUME_BASELINE_CANDLES
  );

  const baseline = median(
    baselineCandles.map(c =>
      candleValue(c, multiplier)
    )
  );

  if (baseline <= 0) return 0;

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

  if (expectedTurnover <= 0) return 0;

  return (
    candleValue(currentCandle, multiplier) /
    expectedTurnover
  );
}

// ============================================================
// 1H TREND CONFIRMATION
// ============================================================

function analyze1hTrend(candles, livePrice) {
  if (candles.length < CONFIG.EMA_PERIOD + 6) {
    return null;
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
    return null;
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

  const aboveEMA =
    lastClose > currentEMA &&
    livePrice > currentEMA;

  const positiveSlope = emaSlope > 0;

  if (!aboveEMA || !positiveSlope) {
    return null;
  }

  return {
    ema: currentEMA,
    emaSlope,
    aboveEMA,
    positiveSlope
  };
}

// ============================================================
// 4H RESISTANCE / ROOM TO GROW
// ============================================================

function analyze4hRoom(candles, livePrice) {
  const count = CONFIG.RESISTANCE_CANDLES_4H;

  if (candles.length < count) return null;

  const recent = candles.slice(-count);

  const resistance = getMax(recent, 'high');

  if (resistance <= 0) return null;

  if (livePrice >= resistance) {
    return {
      resistance,
      roomPercent: 100,
      hasOverheadResistance: false
    };
  }

  const roomPercent = pctChange(
    resistance,
    livePrice
  );

  if (
    roomPercent < CONFIG.MIN_RESISTANCE_ROOM
  ) {
    return null;
  }

  return {
    resistance,
    roomPercent,
    hasOverheadResistance: true
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
    diagnostics
  );

  if (!breakout) return null;

  // 2. Volume confirmation
  const volumeRatio = getCurrentVolumeRatio(
    candles15m,
    current15m,
    multiplier
  );

  if (volumeRatio < CONFIG.MIN_VOLUME_RATIO) {
    return null;
  }

  diagnostics.volume++;

  // 3. 1h trend
  const trend = analyze1hTrend(
    candles1h,
    livePrice
  );

  if (!trend) return null;

  diagnostics.trend++;

  // 4. 4h room
  const room = analyze4hRoom(
    candles4h,
    livePrice
  );

  if (!room) return null;

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
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.'
    );
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
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    const error = new Error(
      result.description || `Telegram HTTP ${response.status}`
    );

    error.retryAfter = result.parameters?.retry_after;
    throw error;
  }
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
      current = block;
    }
  }

  if (current) messages.push(current);

  return messages;
}

async function sendReports(report) {
  const messages = splitTelegramMessage(
    report,
    CONFIG.TELEGRAM_MAX_LENGTH - 50
  );

  for (let i = 0; i < messages.length; i++) {
    const payload =
      `📄 گزارش ${i + 1}/${messages.length}\n\n` +
      messages[i];

    try {
      await sendTelegram(payload);
    } catch (error) {
      if (!error.retryAfter) throw error;

      await sleep(error.retryAfter * 1000 + 500);
      await sendTelegram(payload);
    }

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_DELAY);
    }
  }
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
        `⚠️ ${result.item?.name || 'UNKNOWN'}: ${result.error}`
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

  await sendReports(
    buildReport(
      rankedCandidates.slice(0, CONFIG.TOP_COUNT),
      stats,
      duration,
      rankChanges
    )
  );

  console.log('\n✅ Telegram report sent.');
}

// ============================================================
// START
// ============================================================

main().catch(error => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
