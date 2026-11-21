
/**
 * GATE.IO USDT PERPETUAL — UNIFIED LONG RADAR
 * ------------------------------------------------------------
 * LONG ONLY
 *
 * Fresh unified behavioral detection engine.
 *
 * 15m = Early movement and entry behavior
 * 1h  = Structural confirmation
 * 4h  = Trend context and extension filter
 * BTC = Market risk context
 *
 * Eight bullish behaviors:
 * 1. Accumulation Breakout
 * 2. Trend Reversal
 * 3. Bull Flag
 * 4. Ascending Triangle
 * 5. Breakout Retest
 * 6. Momentum Expansion
 * 7. Trend Continuation
 * 8. Volatility Squeeze Breakout
 *
 * Report:
 * Symbol + New Trend Marker + Behavior
 *
 * File: src/scanner/marketScanner.js
 */

import { saveMarketSnapshot } from "../storage/marketStorage.js";

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  API_BASE: "https://api.gateio.ws/api/v4",
  SETTLE: "usdt",
  BTC_SYMBOL: "BTC_USDT",

  TIMEFRAMES: {
    FAST: "15m",
    MEDIUM: "1h",
    SLOW: "4h",
  },

  CANDLE_LIMITS: {
    FAST: 100,
    MEDIUM: 80,
    SLOW: 60,
  },

  MIN_QUOTE_VOLUME_24H: 100000,

  MAX_MARKETS_PER_SCAN: 0,

  CONCURRENCY: 3,
  REQUEST_DELAY_MS: 150,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,

  MIN_HISTORY_FAST: 55,
  MIN_HISTORY_MEDIUM: 30,
  MIN_HISTORY_SLOW: 15,

  // Structure detection
  STRUCTURE_LOOKBACK: 20,
  COMPRESSION_LOOKBACK: 16,

  // Consolidation
  MAX_CONSOLIDATION_RANGE: 5.0,
  MAX_AVERAGE_CANDLE_RANGE: 0.85,

  // Breakout
  MIN_BREAKOUT_VOLUME: 1.35,
  MIN_BREAKOUT_CLOSE_LOCATION: 0.68,
  MIN_BREAKOUT_BODY: 0.12,

  // Momentum
  MIN_MOMENTUM_15M: 0.65,
  MIN_MOMENTUM_1H: 0.90,
  MIN_MOMENTUM_VOLUME: 1.35,

  // Reversal
  MIN_REVERSAL_VOLUME: 1.20,

  // Trend confirmation
  MIN_1H_TREND_STRENGTH: 0.0,

  // Late movement protection
  MAX_CHANGE_4H: 15,
  MAX_CHANGE_24H: 30,
  MAX_DISTANCE_FROM_EMA: 12,

  // BTC risk protection
  BTC_MAX_DROP_1H: -2.0,
  BTC_MAX_DROP_4H: -4.0,

  // Ranking stabilization
  RANKING_MEMORY_WEIGHT: 0.65,
  RANKING_NEW_WEIGHT: 0.35,
  RANKING_SWITCH_MARGIN: 8,
  RANKING_CONFIRMATIONS: 2,

  // Signal lifetime
  SIGNAL_MAX_AGE_MINUTES: 180,
  SIGNAL_EXPIRY_MINUTES: 60,

  // Report
  MAX_REPORT_ITEMS: 30,
  TELEGRAM_MAX_LENGTH: 3900,
};

// ============================================================
// CONSTANTS
// ============================================================

const BEHAVIORS = {
  ACCUMULATION: "شکست از سکون",
  REVERSAL: "برگشت روند",
  BULL_FLAG: "پرچم صعودی",
  ASCENDING_TRIANGLE: "مثلث صعودی",
  BREAKOUT_RETEST: "شکست و پولبک",
  MOMENTUM: "انفجار مومنتوم",
  CONTINUATION: "ادامه روند صعودی",
  SQUEEZE: "خروج از فشردگی نوسان",
};

const BEHAVIOR_PRIORITY = {
  [BEHAVIORS.ACCUMULATION]: 1,
  [BEHAVIORS.REVERSAL]: 2,
  [BEHAVIORS.BREAKOUT_RETEST]: 3,
  [BEHAVIORS.SQUEEZE]: 4,
  [BEHAVIORS.MOMENTUM]: 5,
  [BEHAVIORS.BULL_FLAG]: 6,
  [BEHAVIORS.ASCENDING_TRIANGLE]: 7,
  [BEHAVIORS.CONTINUATION]: 8,
};

// ============================================================
// PERSISTENT RUNTIME MEMORY
// ============================================================

const signalMemory = new Map();
const rankingMemory = new Map();

let previousRanking = [];
let lastRequestTime = 0;

// ============================================================
// UTILITIES
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const average = (values) => {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return 0;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
};

const median = (values) => {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (!sorted.length) return 0;

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const changePercent = (current, previous) => {
  if (!previous || previous <= 0) return 0;

  return ((current - previous) / previous) * 100;
};

const validPrice = (value) =>
  Number.isFinite(value) && value > 0;

const normalizeSymbol = (symbol) =>
  String(symbol || "").replace("/", "_").toUpperCase();

const formatPercent = (value) => {
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}%`;
};

function getReturn(candles, count) {
  if (!candles || candles.length <= count) return 0;

  return changePercent(
    candles[candles.length - 1].close,
    candles[candles.length - 1 - count].close
  );
}

// ============================================================
// REQUEST ENGINE
// ============================================================

async function requestGate(path, params = {}) {
  let attempt = 0;

  while (attempt <= CONFIG.RETRIES) {
    let timeout;

    try {
      const elapsed = Date.now() - lastRequestTime;

      if (elapsed < CONFIG.REQUEST_DELAY_MS) {
        await sleep(CONFIG.REQUEST_DELAY_MS - elapsed);
      }

      lastRequestTime = Date.now();

      const url = new URL(`${CONFIG.API_BASE}${path}`);

      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }

      const controller = new AbortController();

      timeout = setTimeout(
        () => controller.abort(),
        CONFIG.REQUEST_TIMEOUT_MS
      );

      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Gate API ${response.status}`);
      }

      return await response.json();

    } catch (error) {
      attempt++;

      if (attempt > CONFIG.RETRIES) throw error;

      await sleep(500 * attempt);

    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  throw new Error("Gate request failed");
}

// ============================================================
// MARKET DATA
// ============================================================

async function getContracts() {
  const data = await requestGate(
    `/futures/${CONFIG.SETTLE}/contracts`
  );

  return Array.isArray(data) ? data : [];
}

async function getTickers() {
  const data = await requestGate(
    `/futures/${CONFIG.SETTLE}/tickers`
  );

  return Array.isArray(data) ? data : [];
}

async function getCandles(symbol, interval, limit) {
  const data = await requestGate(
    `/futures/${CONFIG.SETTLE}/candlesticks`,
    {
      contract: symbol,
      interval,
      limit,
    }
  );

  if (!Array.isArray(data)) return [];

  return data
    .map((item) => {
      if (Array.isArray(item)) {
        return {
          time: num(item[0]),
          volume: num(item[1]),
          close: num(item[2]),
          high: num(item[3]),
          low: num(item[4]),
          open: num(item[5]),
          turnover: num(item[6]),
        };
      }

      return {
        time: num(item.t),
        volume: num(item.v),
        close: num(item.c),
        high: num(item.h),
        low: num(item.l),
        open: num(item.o),
        turnover: num(item.sum),
      };
    })
    .filter((c) =>
      validPrice(c.open) &&
      validPrice(c.close) &&
      validPrice(c.high) &&
      validPrice(c.low)
    )
    .sort((a, b) => a.time - b.time);
}

function getClosedCandles(candles, intervalSeconds) {
  const now = Math.floor(Date.now() / 1000);

  return candles.filter(
    (c) => c.time + intervalSeconds <= now
  );
}

// ============================================================
// CANDLE STRUCTURE
// ============================================================

function candleInfo(candle) {
  const range = Math.max(candle.high - candle.low, 0);

  const body = candle.close - candle.open;

  return {
    bullish: body > 0,

    bodyPercent: changePercent(
      candle.close,
      candle.open
    ),

    closeLocation: range > 0
      ? (candle.close - candle.low) / range
      : 0.5,

    upperWick: range > 0
      ? (candle.high - Math.max(candle.open, candle.close)) / range
      : 0,

    lowerWick: range > 0
      ? (Math.min(candle.open, candle.close) - candle.low) / range
      : 0,

    rangePercent: candle.close > 0
      ? (range / candle.close) * 100
      : 0,
  };
}

// ============================================================
// EMA
// ============================================================

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    ema =
      values[i] * multiplier +
      ema * (1 - multiplier);
  }

  return ema;
}

function analyzeTrend(candles) {
  const closes = candles.map((c) => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  if (!ema9 || !ema21) {
    return {
      bullish: false,
      ema9: 0,
      ema21: 0,
      distance: 0,
    };
  }

  const last = closes[closes.length - 1];

  return {
    bullish:
      ema9 > ema21 &&
      last > ema9,

    ema9,
    ema21,

    distance: changePercent(last, ema21),

    separation: changePercent(ema9, ema21),
  };
}

// ============================================================
// TURNOVER / VOLUME
// ============================================================

function getTurnover(candle) {
  if (candle.turnover > 0) return candle.turnover;

  return candle.volume * candle.close;
}

function analyzeVolume(candles) {
  if (candles.length < 22) {
    return {
      ratio: 0,
      expanded: false,
    };
  }

  const current = candles[candles.length - 1];

  const baselineCandles = candles.slice(-21, -1);

  const baseline = median(
    baselineCandles.map(getTurnover)
  );

  const currentValue = getTurnover(current);

  const ratio = baseline > 0
    ? currentValue / baseline
    : 0;

  return {
    ratio,
    expanded: ratio >= CONFIG.MIN_MOMENTUM_VOLUME,
  };
}

// ============================================================
// MARKET STRUCTURE HELPERS
// ============================================================

function getRange(candles) {
  if (!candles.length) {
    return {
      high: 0,
      low: 0,
      percent: 0,
    };
  }

  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));

  const mid = (high + low) / 2;

  return {
    high,
    low,
    percent: mid > 0
      ? ((high - low) / mid) * 100
      : 0,
  };
}

function isHigherLow(candles) {
  if (candles.length < 8) return false;

  const first = candles.slice(0, 4);
  const second = candles.slice(4);

  const low1 = Math.min(...first.map((c) => c.low));
  const low2 = Math.min(...second.map((c) => c.low));

  return low2 > low1;
}

function isLowerHigh(candles) {
  if (candles.length < 8) return false;

  const first = candles.slice(0, 4);
  const second = candles.slice(4);

  const high1 = Math.max(...first.map((c) => c.high));
  const high2 = Math.max(...second.map((c) => c.high));

  return high2 < high1;
}

function countBullish(candles) {
  return candles.filter((c) => c.close > c.open).length;
}

// ============================================================
// CONSOLIDATION DETECTION
// ============================================================

function detectConsolidation(candles) {
  if (candles.length < 40) {
    return { valid: false };
  }

  const rangeCandles = candles.slice(-17, -1);

  const range = getRange(rangeCandles);

  const averageRange = average(
    rangeCandles.map((c) => candleInfo(c).rangePercent)
  );

  const valid =
    range.percent <= CONFIG.MAX_CONSOLIDATION_RANGE &&
    averageRange <= CONFIG.MAX_AVERAGE_CANDLE_RANGE;

  return {
    valid,
    high: range.high,
    low: range.low,
    rangePercent: range.percent,
    averageRange,
  };
}

// ============================================================
// 1. ACCUMULATION BREAKOUT
// ============================================================

function detectAccumulationBreakout(candles, volume) {
  const consolidation = detectConsolidation(candles);

  if (!consolidation.valid) return null;

  const last = candles[candles.length - 1];
  const info = candleInfo(last);

  const breakout =
    last.close > consolidation.high &&
    info.closeLocation >= CONFIG.MIN_BREAKOUT_CLOSE_LOCATION &&
    info.bodyPercent >= CONFIG.MIN_BREAKOUT_BODY &&
    volume.ratio >= CONFIG.MIN_BREAKOUT_VOLUME;

  if (!breakout) return null;

  return {
    behavior: BEHAVIORS.ACCUMULATION,
    strength: 90,
    fresh: true,
  };
}

// ============================================================
// 2. TREND REVERSAL
// ============================================================

function detectReversal(fast, medium, volume) {
  const recent = fast.slice(-9);

  const older = recent.slice(0, 5);
  const newer = recent.slice(5);

  const oldHigh = Math.max(...older.map((c) => c.high));
  const oldLow = Math.min(...older.map((c) => c.low));

  const newLow = Math.min(...newer.map((c) => c.low));

  const last = fast[fast.length - 1];

  const mediumTrend = analyzeTrend(medium);

  const priorDecline =
    recent[0].close > last.close &&
    newLow <= oldLow * 1.005;

  const recovery =
    last.close > oldHigh * 0.998 &&
    last.close > last.open;

  const volumeValid =
    volume.ratio >= CONFIG.MIN_REVERSAL_VOLUME;

  const hourlyRecovery =
    getReturn(medium, 2) > 0 &&
    (
      mediumTrend.bullish ||
      medium[medium.length - 1].close >
        medium[medium.length - 2].close
    );

  if (
    priorDecline &&
    recovery &&
    volumeValid &&
    hourlyRecovery
  ) {
    return {
      behavior: BEHAVIORS.REVERSAL,
      strength: 88,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 3. BULL FLAG
// ============================================================

function detectBullFlag(candles, volume) {
  if (candles.length < 25) return null;

  const impulse = candles.slice(-11, -5);
  const flag = candles.slice(-5, -1);
  const last = candles[candles.length - 1];

  const impulseChange = changePercent(
    impulse[impulse.length - 1].close,
    impulse[0].open
  );

  const impulseHigh = Math.max(
    ...impulse.map((c) => c.high)
  );

  const impulseLow = Math.min(
    ...impulse.map((c) => c.low)
  );

  const flagRange = getRange(flag);

  const retracement = changePercent(
    impulseHigh,
    Math.min(...flag.map((c) => c.low))
  );

  const pullbackValid =
    flagRange.percent < 4.5 &&
    retracement > 0 &&
    retracement < 65;

  const breakout =
    last.close > Math.max(...flag.map((c) => c.high)) &&
    last.close > last.open;

  if (
    impulseChange >= 3 &&
    impulseHigh > impulseLow &&
    pullbackValid &&
    breakout &&
    volume.ratio >= 1.15
  ) {
    return {
      behavior: BEHAVIORS.BULL_FLAG,
      strength: 82,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 4. ASCENDING TRIANGLE
// ============================================================

function detectAscendingTriangle(candles, volume) {
  if (candles.length < 30) return null;

  const base = candles.slice(-19, -1);

  const highs = base.map((c) => c.high);
  const lows = base.map((c) => c.low);

  const resistance = Math.max(...highs);

  const highDeviation =
    ((Math.max(...highs) - Math.min(...highs)) / resistance) * 100;

  const higherLows = isHigherLow(base);

  const last = candles[candles.length - 1];

  const breakout =
    last.close > resistance &&
    last.close > last.open &&
    volume.ratio >= CONFIG.MIN_BREAKOUT_VOLUME;

  if (
    highDeviation <= 1.5 &&
    higherLows &&
    breakout
  ) {
    return {
      behavior: BEHAVIORS.ASCENDING_TRIANGLE,
      strength: 83,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 5. BREAKOUT RETEST
// ============================================================

function detectBreakoutRetest(candles, volume) {
  if (candles.length < 30) return null;

  const last = candles[candles.length - 1];

  for (let age = 1; age <= 4; age++) {
    const breakoutIndex = candles.length - 1 - age;

    const before = candles.slice(
      Math.max(0, breakoutIndex - 16),
      breakoutIndex
    );

    if (before.length < 10) continue;

    const resistance = Math.max(
      ...before.map((c) => c.high)
    );

    const breakoutCandle = candles[breakoutIndex];

    if (breakoutCandle.close <= resistance) continue;

    const retestCandles = candles.slice(
      breakoutIndex + 1
    );

    const retestLow = Math.min(
      ...retestCandles.map((c) => c.low)
    );

    const heldLevel = retestLow >= resistance * 0.985;

    const recovered =
      last.close > resistance &&
      last.close > last.open;

    if (
      heldLevel &&
      recovered &&
      volume.ratio >= 1.05
    ) {
      return {
        behavior: BEHAVIORS.BREAKOUT_RETEST,
        strength: 86,
        fresh: true,
      };
    }
  }

  return null;
}

// ============================================================
// 6. MOMENTUM EXPANSION
// ============================================================

function detectMomentumExpansion(candles, volume) {
  const last = candles[candles.length - 1];

  const change15 = getReturn(candles, 1);
  const change30 = getReturn(candles, 2);
  const change1h = getReturn(candles, 4);

  const info = candleInfo(last);

  const acceleration =
    change15 > average(
      candles.slice(-5, -1).map((c, i, arr) => {
        const previous = i === 0
          ? candles[candles.length - 6]
          : arr[i - 1];

        return changePercent(c.close, previous.close);
      })
    );

  const valid =
    change15 >= CONFIG.MIN_MOMENTUM_15M &&
    change30 > 0 &&
    change1h > 0 &&
    volume.ratio >= CONFIG.MIN_MOMENTUM_VOLUME &&
    info.closeLocation >= 0.70 &&
    acceleration;

  if (!valid) return null;

  return {
    behavior: BEHAVIORS.MOMENTUM,
    strength: 89,
    fresh: true,
  };
}

// ============================================================
// 7. TREND CONTINUATION
// ============================================================

function detectTrendContinuation(fast, medium, slow, volume) {
  const trend1h = analyzeTrend(medium);
  const trend4h = analyzeTrend(slow);

  const recent = fast.slice(-7);

  const correction =
    recent.some((c) => c.close < c.open);

  const higherLow = isHigherLow(recent);

  const last = fast[fast.length - 1];

  const recovery =
    last.close > last.open &&
    last.close > calculateEMA(
      fast.map((c) => c.close),
      9
    );

  if (
    trend1h.bullish &&
    trend4h.bullish &&
    correction &&
    higherLow &&
    recovery &&
    volume.ratio >= 1.05
  ) {
    return {
      behavior: BEHAVIORS.CONTINUATION,
      strength: 76,
      fresh: false,
    };
  }

  return null;
}

// ============================================================
// 8. VOLATILITY SQUEEZE BREAKOUT
// ============================================================

function detectSqueezeBreakout(candles, volume) {
  if (candles.length < 45) return null;

  const recent = candles.slice(-17, -1);
  const older = candles.slice(-41, -17);

  const recentRange = getRange(recent);
  const olderRange = getRange(older);

  const compressed =
    recentRange.percent < 3.5 &&
    recentRange.percent < olderRange.percent * 0.65;

  const last = candles[candles.length - 1];

  const breakout =
    last.close > recentRange.high &&
    last.close > last.open &&
    volume.ratio >= CONFIG.MIN_BREAKOUT_VOLUME;

  if (compressed && breakout) {
    return {
      behavior: BEHAVIORS.SQUEEZE,
      strength: 87,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// UNIFIED BEHAVIOR ENGINE
// ============================================================

function detectBullishBehavior(fast, medium, slow) {
  const volume = analyzeVolume(fast);

  const detectors = [
    () => detectAccumulationBreakout(fast, volume),
    () => detectBreakoutRetest(fast, volume),
    () => detectReversal(fast, medium, volume),
    () => detectSqueezeBreakout(fast, volume),
    () => detectMomentumExpansion(fast, volume),
    () => detectBullFlag(fast, volume),
    () => detectAscendingTriangle(fast, volume),
    () => detectTrendContinuation(fast, medium, slow, volume),
  ];

  const results = [];

  for (const detector of detectors) {
    try {
      const result = detector();

      if (result) results.push(result);
    } catch (error) {
      console.error("[BEHAVIOR ERROR]", error.message);
    }
  }

  if (!results.length) return null;

  results.sort((a, b) => {
    if (b.strength !== a.strength) {
      return b.strength - a.strength;
    }

    return (
      BEHAVIOR_PRIORITY[a.behavior] -
      BEHAVIOR_PRIORITY[b.behavior]
    );
  });

  return {
    ...results[0],
    alternatives: results.map((r) => r.behavior),
    volumeRatio: volume.ratio,
  };
}

// ============================================================
// TREND QUALITY / LATE-MOVE FILTER
// ============================================================

function validateTrend(fast, medium, slow, ticker, btc) {
  const trend1h = analyzeTrend(medium);
  const trend4h = analyzeTrend(slow);

  const change4h = getReturn(slow, 1);
  const change24h = getReturn(slow, 6);

  const currentPrice = fast[fast.length - 1].close;

  const tooExtended =
    change4h > CONFIG.MAX_CHANGE_4H ||
    change24h > CONFIG.MAX_CHANGE_24H ||
    trend1h.distance > CONFIG.MAX_DISTANCE_FROM_EMA;

  if (tooExtended) return false;

  if (
    btc.change1h <= CONFIG.BTC_MAX_DROP_1H &&
    btc.change4h <= CONFIG.BTC_MAX_DROP_4H
  ) {
    return false;
  }

  const positiveHourlyStructure =
    trend1h.bullish ||
    getReturn(medium, 3) > 0;

  const positiveFastStructure =
    currentPrice > fast[fast.length - 2].close;

  const higherTimeframeNotCollapsing =
    !(
      getReturn(slow, 2) < -8 &&
      !trend4h.bullish
    );

  return (
    positiveHourlyStructure &&
    positiveFastStructure &&
    higherTimeframeNotCollapsing
  );
}

// ============================================================
// EARLY / CONTINUATION CLASSIFICATION
// ============================================================

function classifySignal(behavior, fast, medium) {
  const lastCandle = fast[fast.length - 1];

  const recentHourly = medium.slice(-5);

  const hourlyPositive =
    recentHourly[recentHourly.length - 1].close >
    recentHourly[0].close;

  const newTrendBehaviors = [
    BEHAVIORS.ACCUMULATION,
    BEHAVIORS.REVERSAL,
    BEHAVIORS.BREAKOUT_RETEST,
    BEHAVIORS.SQUEEZE,
    BEHAVIORS.MOMENTUM,
    BEHAVIORS.ASCENDING_TRIANGLE,
    BEHAVIORS.BULL_FLAG,
  ];

  const fresh =
    behavior.fresh &&
    newTrendBehaviors.includes(behavior.behavior);

  return {
    stage: fresh ? "NEW_TREND" : "CONTINUATION",

    marker: fresh ? "🆕" : "🟢",

    behavior: behavior.behavior,

    candleTime: lastCandle.time,

    hourlyPositive,
  };
}

// ============================================================
// INTERNAL QUALITY SCORE
// NOT DISPLAYED IN TELEGRAM
// ============================================================

function calculateQuality(
  fast,
  medium,
  slow,
  behavior,
  btc,
  quoteVolume
) {
  let score = behavior.strength;

  const trend1h = analyzeTrend(medium);
  const trend4h = analyzeTrend(slow);

  const volume = analyzeVolume(fast);

  const change15 = getReturn(fast, 1);
  const change1h = getReturn(medium, 1);

  if (trend1h.bullish) score += 5;
  if (trend4h.bullish) score += 3;

  if (volume.ratio >= 2) score += 5;
  else if (volume.ratio >= 1.5) score += 3;

  if (change15 > 0 && change1h > 0) score += 3;

  if (btc.change1h < -1) score -= 5;

  if (quoteVolume >= 1000000) score += 3;

  if (trend1h.distance > 7) score -= 8;

  return clamp(score, 0, 100);
}

// ============================================================
// RANKING MEMORY
// ============================================================

function updateRankingMemory(candidates) {
  const now = Date.now();

  const currentSymbols = new Set(
    candidates.map((c) => c.symbol)
  );

  for (const [symbol, memory] of rankingMemory) {
    if (!currentSymbols.has(symbol)) {
      memory.missingScans = (memory.missingScans || 0) + 1;

      if (memory.missingScans >= 3) {
        rankingMemory.delete(symbol);
      }
    }
  }

  for (const candidate of candidates) {
    const previous = rankingMemory.get(candidate.symbol);

    if (!previous) {
      rankingMemory.set(candidate.symbol, {
        stableScore: candidate.quality,
        previousRank: 999,
        missingScans: 0,
        pendingRank: null,
        pendingCount: 0,
        confirmedRank: 999,
      });

      candidate.stableScore = candidate.quality;

      continue;
    }

    previous.missingScans = 0;

    previous.stableScore =
      previous.stableScore * CONFIG.RANKING_MEMORY_WEIGHT +
      candidate.quality * CONFIG.RANKING_NEW_WEIGHT;

    candidate.stableScore = previous.stableScore;
  }

  const sorted = [...candidates].sort(
    (a, b) => b.stableScore - a.stableScore
  );

  const proposedRanks = new Map(
    sorted.map((candidate, index) => [
      candidate.symbol,
      index + 1,
    ])
  );

  for (const candidate of candidates) {
    const memory = rankingMemory.get(candidate.symbol);

    const proposed = proposedRanks.get(candidate.symbol);

    if (!memory) continue;

    if (memory.confirmedRank === 999) {
      memory.confirmedRank = proposed;
      continue;
    }

    const rankDifference = Math.abs(
      proposed - memory.confirmedRank
    );

    if (rankDifference === 0) {
      memory.pendingRank = null;
      memory.pendingCount = 0;
      continue;
    }

    const currentLeader = sorted[proposed - 1];

    const previousLeader = sorted[memory.confirmedRank - 1];

    const significantDifference =
      currentLeader &&
      previousLeader &&
      Math.abs(
        currentLeader.stableScore -
        previousLeader.stableScore
      ) >= CONFIG.RANKING_SWITCH_MARGIN;

    if (significantDifference) {
      if (memory.pendingRank === proposed) {
        memory.pendingCount++;
      } else {
        memory.pendingRank = proposed;
        memory.pendingCount = 1;
      }

      if (
        memory.pendingCount >=
        CONFIG.RANKING_CONFIRMATIONS
      ) {
        memory.confirmedRank = proposed;
        memory.pendingRank = null;
        memory.pendingCount = 0;
      }
    }
  }

  const finalRanking = [...candidates].sort((a, b) => {
    const rankA =
      rankingMemory.get(a.symbol)?.confirmedRank ?? 999;

    const rankB =
      rankingMemory.get(b.symbol)?.confirmedRank ?? 999;

    return rankA - rankB;
  });

  finalRanking.forEach((candidate, index) => {
    const memory = rankingMemory.get(candidate.symbol);

    if (memory) {
      candidate.rank = index + 1;
      memory.previousRank = index + 1;
    }
  });

  previousRanking = finalRanking.map((c) => c.symbol);

  return finalRanking;
}

// ============================================================
// SIGNAL MEMORY / NEW TREND MARKER
// ============================================================

function updateSignalState(candidate) {
  const now = Date.now();

  const previous = signalMemory.get(candidate.symbol);

  const candleTime = candidate.candleTime;

  if (!previous) {
    signalMemory.set(candidate.symbol, {
      firstSeen: now,
      lastSeen: now,
      lastCandleTime: candleTime,
      marker: candidate.stage === "NEW_TREND" ? "🆕" : "🟢",
      behavior: candidate.behavior,
    });

    candidate.marker =
      candidate.stage === "NEW_TREND" ? "🆕" : "🟢";

    return;
  }

  const sameCandle =
    previous.lastCandleTime === candleTime;

  const sameBehavior =
    previous.behavior === candidate.behavior;

  const elapsedMinutes =
    (now - previous.firstSeen) / 60000;

  const isFreshSignal =
    candidate.stage === "NEW_TREND" &&
    !sameBehavior &&
    !sameCandle;

  if (isFreshSignal) {
    previous.firstSeen = now;
    candidate.marker = "🆕";

  } else if (
    candidate.stage === "NEW_TREND" &&
    elapsedMinutes <= CONFIG.SIGNAL_MAX_AGE_MINUTES &&
    sameBehavior
  ) {
    candidate.marker = "🟢";

  } else {
    candidate.marker = "🟢";
  }

  previous.lastSeen = now;
  previous.lastCandleTime = candleTime;
  previous.behavior = candidate.behavior;
  previous.marker = candidate.marker;
}

// ============================================================
// BTC BENCHMARK
// ============================================================

async function getBitcoinBenchmark() {
  const [rawFast, rawMedium, rawSlow] = await Promise.all([
    getCandles(
      CONFIG.BTC_SYMBOL,
      CONFIG.TIMEFRAMES.FAST,
      CONFIG.CANDLE_LIMITS.FAST
    ),

    getCandles(
      CONFIG.BTC_SYMBOL,
      CONFIG.TIMEFRAMES.MEDIUM,
      CONFIG.CANDLE_LIMITS.MEDIUM
    ),

    getCandles(
      CONFIG.BTC_SYMBOL,
      CONFIG.TIMEFRAMES.SLOW,
      CONFIG.CANDLE_LIMITS.SLOW
    ),
  ]);

  const fast = getClosedCandles(rawFast, 900);
  const medium = getClosedCandles(rawMedium, 3600);
  const slow = getClosedCandles(rawSlow, 14400);

  if (
    fast.length < CONFIG.MIN_HISTORY_FAST ||
    medium.length < CONFIG.MIN_HISTORY_MEDIUM ||
    slow.length < CONFIG.MIN_HISTORY_SLOW
  ) {
    throw new Error("Insufficient BTC benchmark history");
  }

  return {
    change15m: getReturn(fast, 1),
    change1h: getReturn(medium, 1),
    change4h: getReturn(slow, 1),
    change24h: getReturn(slow, 6),
  };
}

// ============================================================
// COIN ANALYSIS
// ============================================================

async function analyzeCoin(ticker, btc, semaphore) {
  const symbol = normalizeSymbol(ticker.contract);

  if (!symbol || symbol === CONFIG.BTC_SYMBOL) return null;

  const quoteVolume = num(ticker.volume_24h_quote);

  if (quoteVolume < CONFIG.MIN_QUOTE_VOLUME_24H) {
    return null;
  }

  const release = await semaphore.acquire();

  try {
    const [rawFast, rawMedium, rawSlow] = await Promise.all([
      getCandles(
        symbol,
        CONFIG.TIMEFRAMES.FAST,
        CONFIG.CANDLE_LIMITS.FAST
      ),

      getCandles(
        symbol,
        CONFIG.TIMEFRAMES.MEDIUM,
        CONFIG.CANDLE_LIMITS.MEDIUM
      ),

      getCandles(
        symbol,
        CONFIG.TIMEFRAMES.SLOW,
        CONFIG.CANDLE_LIMITS.SLOW
      ),
    ]);

    const fast = getClosedCandles(rawFast, 900);
    const medium = getClosedCandles(rawMedium, 3600);
    const slow = getClosedCandles(rawSlow, 14400);

    if (
      fast.length < CONFIG.MIN_HISTORY_FAST ||
      medium.length < CONFIG.MIN_HISTORY_MEDIUM ||
      slow.length < CONFIG.MIN_HISTORY_SLOW
    ) {
      return null;
    }

    // Unified behavior detection
    const behavior = detectBullishBehavior(
      fast,
      medium,
      slow
    );

    if (!behavior) return null;

    // Market context and late movement protection
    const trendValid = validateTrend(
      fast,
      medium,
      slow,
      ticker,
      btc
    );

    if (!trendValid) return null;

    const classification = classifySignal(
      behavior,
      fast,
      medium
    );

    const quality = calculateQuality(
      fast,
      medium,
      slow,
      behavior,
      btc,
      quoteVolume
    );

    const candidate = {
      symbol,
      contract: symbol,

      price: num(
        ticker.last,
        fast[fast.length - 1].close
      ),

      behavior: behavior.behavior,

      stage: classification.stage,

      marker: classification.marker,

      candleTime: classification.candleTime,

      quality,

      score: Math.round(quality),

      volumeRatio15m: behavior.volumeRatio,

      change15m: getReturn(fast, 1),
      change1h: getReturn(medium, 1),
      change4h: getReturn(slow, 1),
      change24h: getReturn(slow, 6),

      quoteVolume24h: quoteVolume,

      btc,

      scannedAt: new Date().toISOString(),
    };

    updateSignalState(candidate);

    return candidate;

  } catch (error) {
    console.error(`[COIN ERROR] ${symbol}: ${error.message}`);

    return null;

  } finally {
    release();
  }
}

// ============================================================
// CONCURRENCY
// ============================================================

function createSemaphore(max) {
  let active = 0;
  const waiting = [];

  return {
    async acquire() {
      if (active < max) {
        active++;

        return () => {
          active--;

          const next = waiting.shift();

          if (next) next();
        };
      }

      await new Promise((resolve) => waiting.push(resolve));

      active++;

      return () => {
        active--;

        const next = waiting.shift();

        if (next) next();
      };
    },
  };
}

// ============================================================
// SIGNAL MEMORY CLEANUP
// ============================================================

function cleanupSignalMemory() {
  const now = Date.now();

  for (const [symbol, memory] of signalMemory) {
    const age =
      (now - memory.lastSeen) / 60000;

    if (age > CONFIG.SIGNAL_EXPIRY_MINUTES) {
      signalMemory.delete(symbol);
    }
  }

  for (const [symbol, memory] of rankingMemory) {
    if ((memory.missingScans || 0) >= 3) {
      rankingMemory.delete(symbol);
    }
  }
}

// ============================================================
// REPORT
// ============================================================

function formatCandidate(candidate) {
  return [
    `${candidate.marker} ${candidate.symbol}`,
    `رفتار: ${candidate.behavior}`,
  ].join("\n");
}

function buildReport(candidates, stats) {
  const lines = [
    "🚀 GATE.IO | LONG RADAR",
    "━━━━━━━━━━━━━━━━━━",
    `📊 بازار: ${stats.totalMarkets}`,
    `💧 نقدشونده: ${stats.liquidMarkets}`,
    `🔍 بررسی‌شده: ${stats.scannedMarkets}`,
    `📌 فرصت‌ها: ${candidates.length}`,
    "━━━━━━━━━━━━━━━━━━",
  ];

  if (!candidates.length) {
    lines.push(
      "",
      "در حال حاضر فرصت صعودی واجد شرایطی شناسایی نشد."
    );

    return lines.join("\n");
  }

  candidates
    .slice(0, CONFIG.MAX_REPORT_ITEMS)
    .forEach((candidate) => {
      lines.push(
        "",
        formatCandidate(candidate),
        "──────────────────"
      );
    });

  lines.push(
    "",
    "🆕 شروع روند جدید | 🟢 ادامه روند"
  );

  return lines.join("\n");
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("[TELEGRAM] Credentials not configured");

    return {
      sent: false,
      reason: "Missing credentials",
    };
  }

  const chunks = [];

  for (
    let index = 0;
    index < message.length;
    index += CONFIG.TELEGRAM_MAX_LENGTH
  ) {
    chunks.push(
      message.slice(
        index,
        index + CONFIG.TELEGRAM_MAX_LENGTH
      )
    );
  }

  for (const chunk of chunks) {
    let attempt = 0;
    let sent = false;

    while (attempt <= CONFIG.RETRIES && !sent) {
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true,
            }),
          }
        );

        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error(
            data.description || "Telegram send failed"
          );
        }

        sent = true;

      } catch (error) {
        attempt++;

        if (attempt > CONFIG.RETRIES) throw error;

        await sleep(1000 * attempt);
      }
    }

    await sleep(250);
  }

  return { sent: true };
}

// ============================================================
// TELEGRAM JSON DOCUMENT
// ============================================================

async function sendTelegramDocument(filename, content) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return;

  const boundary = `----GateScanner${Date.now()}`;

  const bodyStart = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="chat_id"`,
    "",
    chatId,
    `--${boundary}`,
    `Content-Disposition: form-data; name="document"; filename="${filename}"`,
    "Content-Type: application/json",
    "",
  ].join("\r\n");

  const bodyEnd = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(bodyStart),
    Buffer.from(content),
    Buffer.from(bodyEnd),
  ]);

  let attempt = 0;

  while (attempt <= CONFIG.RETRIES) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendDocument`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              `multipart/form-data; boundary=${boundary}`,
          },

          body,
        }
      );

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(
          data.description || "Telegram document failed"
        );
      }

      return;

    } catch (error) {
      attempt++;

      if (attempt > CONFIG.RETRIES) throw error;

      await sleep(1000 * attempt);
    }
  }
}

async function sendTelegramReport(output) {
  try {
    await sendTelegramMessage(output.report);

    await sendTelegramDocument(
      `gate-long-radar-${Date.now()}.json`,
      JSON.stringify(output, null, 2)
    );

    return true;

  } catch (error) {
    console.error("[TELEGRAM ERROR]", error.message);

    return false;
  }
}

// ============================================================
// MAIN SCANNER
// ============================================================

export async function scanGateMarkets() {
  const startedAt = Date.now();

  console.log("\n========================================");
  console.log("GATE.IO UNIFIED LONG RADAR");
  console.log("========================================\n");

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers(),
  ]);

  const tickerMap = new Map(
    tickers.map((ticker) => [
      normalizeSymbol(ticker.contract),
      ticker,
    ])
  );

  const activeContracts = contracts.filter(
    (contract) =>
      contract.in_delisting !== true &&
      contract.in_delisting !== "true" &&
      contract.trade_status !== "untradable"
  );

  const liquidMarkets = activeContracts
    .map((contract) => {
      const symbol = normalizeSymbol(contract.name);

      const ticker = tickerMap.get(symbol);

      if (!ticker) return null;

      return {
        contract,
        ticker,
        symbol,
        quoteVolume: num(ticker.volume_24h_quote),
      };
    })
    .filter(
      (item) =>
        item &&
        item.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H &&
        item.symbol !== CONFIG.BTC_SYMBOL
    )
    .sort(
      (a, b) => b.quoteVolume - a.quoteVolume
    );

  const marketsToScan =
    CONFIG.MAX_MARKETS_PER_SCAN > 0
      ? liquidMarkets.slice(
          0,
          CONFIG.MAX_MARKETS_PER_SCAN
        )
      : liquidMarkets;

  console.log(
    `[MARKETS] ${activeContracts.length} total | ${liquidMarkets.length} liquid`
  );

  const btc = await getBitcoinBenchmark();

  console.log(
    `[BTC] 15m ${formatPercent(btc.change15m)} | 1h ${formatPercent(btc.change1h)} | 4h ${formatPercent(btc.change4h)}`
  );

  const semaphore = createSemaphore(CONFIG.CONCURRENCY);

  const results = [];

  let successful = 0;
  let failed = 0;
  let completed = 0;

  const workers = marketsToScan.map(async (market) => {
    try {
      const result = await analyzeCoin(
        market.ticker,
        btc,
        semaphore
      );

      successful++;

      if (result) results.push(result);

    } catch (error) {
      failed++;

      console.error(
        `[MARKET ERROR] ${market.symbol}: ${error.message}`
      );

    } finally {
      completed++;

      if (completed % 50 === 0) {
        console.log(
          `[PROGRESS] ${completed}/${marketsToScan.length} | Candidates: ${results.length}`
        );
      }
    }
  });

  await Promise.all(workers);

  // Stable ranking
  const rankedCandidates = updateRankingMemory(results);

  cleanupSignalMemory();

  const stats = {
    totalMarkets: activeContracts.length,
    liquidMarkets: liquidMarkets.length,
    scannedMarkets: marketsToScan.length,
    successful,
    failed,
    candidates: rankedCandidates.length,
    durationMs: Date.now() - startedAt,
  };

  const report = buildReport(
    rankedCandidates,
    stats
  );

  const output = {
    success: true,

    exchange: "GATE.IO",

    market: "USDT PERPETUAL",

    strategy: "UNIFIED LONG RADAR",

    scannedAt: new Date().toISOString(),

    stats,

    btc,

    candidates: rankedCandidates,

    rankedCandidates,

    rankChanges: [],

    historyCount: 0,

    summaryCount: rankedCandidates.length,

    report,
  };

  // Preserve existing storage integration
  try {
    const storageResult =
      await saveMarketSnapshot(rankedCandidates);

    if (storageResult) {
      output.historyCount =
        storageResult.historyCount ??
        output.historyCount;

      output.summaryCount =
        storageResult.summaryCount ??
        output.summaryCount;

      output.rankChanges =
        storageResult.rankChanges ??
        output.rankChanges;
    }

  } catch (error) {
    console.error(
      "[STORAGE ERROR]",
      error.message
    );
  }

  console.log("\n========================================");
  console.log("SCAN FINISHED");
  console.log("========================================");

  console.log(`Markets: ${stats.totalMarkets}`);
  console.log(`Liquid: ${stats.liquidMarkets}`);
  console.log(`Scanned: ${stats.scannedMarkets}`);
  console.log(`Successful: ${stats.successful}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Candidates: ${stats.candidates}`);
  console.log(`Duration: ${stats.durationMs}ms`);

  console.log("========================================\n");

  console.log(report);

  await sendTelegramReport(output);

  return output;
}

// ============================================================
// AUTO START ON IMPORT
// IMPORTANT:
// src/index.js imports this file.
// Preserve existing execution interface.
// ============================================================

try {
  const output = await scanGateMarkets();

  console.log("\n[SCANNER RESULT]");

  console.log(
    JSON.stringify(
      {
        success: output.success,
        totalMarkets: output.stats?.totalMarkets,
        liquidMarkets: output.stats?.liquidMarkets,
        scannedMarkets: output.stats?.scannedMarkets,
        successfulMarkets: output.stats?.successful,
        failedMarkets: output.stats?.failed,
        candidates: output.stats?.candidates,
        durationMs: output.stats?.durationMs,
      },
      null,
      2
    )
  );

  console.log("\nScan completed.\n");

} catch (error) {
  console.error(
    "\n[SCANNER FATAL ERROR]",
    error
  );

  process.exitCode = 1;
}
