
/**
 * GATE.IO USDT PERPETUAL — EARLY LONG RADAR
 * ------------------------------------------------------------
 * LONG ONLY
 *
 * Main objective:
 * Detect bullish movement as early as reasonably possible.
 *
 * 15m = Early entry behavior and trigger
 * 1h  = Soft structural validation (not a strict trend requirement)
 * 4h  = Extension and major-risk protection
 * BTC = Market risk context
 *
 * Behaviors:
 * 1. شکست از سکون
 * 2. برگشت روند
 * 3. پرچم صعودی
 * 4. مثلث صعودی
 * 5. شکست و پولبک
 * 6. انفجار مومنتوم
 * 7. ادامه روند صعودی
 * 8. خروج از فشردگی نوسان
 * 9. فشار خرید زیر مقاومت
 *
 * Signal state is persisted between process restarts.
 *
 * File: src/scanner/marketScanner.js
 */

import { saveMarketSnapshot } from "../storage/marketStorage.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    MEDIUM: 60,
    SLOW: 40,
  },

  MIN_QUOTE_VOLUME_24H: 100000,
  MAX_MARKETS_PER_SCAN: 0,

  CONCURRENCY: 3,
  REQUEST_DELAY_MS: 150,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,

  MIN_HISTORY_FAST: 45,
  MIN_HISTORY_MEDIUM: 25,
  MIN_HISTORY_SLOW: 12,

  // Early detection
  EARLY_VOLUME_RATIO: 1.10,
  BREAKOUT_VOLUME_RATIO: 1.20,
  STRONG_VOLUME_RATIO: 1.50,

  MIN_EARLY_CANDLE_BODY: 0.08,
  MIN_BREAKOUT_BODY: 0.12,
  MIN_CLOSE_LOCATION: 0.62,

  // Consolidation
  CONSOLIDATION_LOOKBACK: 16,
  MAX_CONSOLIDATION_RANGE: 6.0,
  MAX_AVERAGE_CANDLE_RANGE: 1.10,

  // Early resistance approach
  RESISTANCE_DISTANCE_PERCENT: 0.45,
  MIN_HIGHER_LOW_RATIO: 0.15,

  // Momentum
  MIN_EARLY_MOMENTUM_15M: 0.30,
  MIN_STRONG_MOMENTUM_15M: 0.65,

  // Reversal
  REVERSAL_LOOKBACK: 12,
  REVERSAL_VOLUME_RATIO: 1.05,

  // Trend and extension
  MAX_CHANGE_4H: 12,
  MAX_CHANGE_24H: 25,
  MAX_DISTANCE_FROM_EMA: 11,

  // Avoid severe market collapse
  BTC_MAX_DROP_1H: -2.5,
  BTC_MAX_DROP_4H: -5.0,

  // Signal lifecycle
  SIGNAL_EXPIRY_MINUTES: 60,
  SIGNAL_REACTIVATION_MINUTES: 60,
  SIGNAL_MAX_MEMORY_DAYS: 7,

  // Ranking
  RANKING_MEMORY_WEIGHT: 0.70,
  RANKING_NEW_WEIGHT: 0.30,

  // Report
  MAX_REPORT_ITEMS: 30,
  TELEGRAM_MAX_LENGTH: 3900,

  // Persistent state
  STATE_FILENAME: "gateLongSignalState.json",
};

// ============================================================
// BEHAVIORS
// ============================================================

const BEHAVIORS = {
  ACCUMULATION: "شکست از سکون",
  PRE_BREAKOUT: "فشار خرید زیر مقاومت",
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
  [BEHAVIORS.PRE_BREAKOUT]: 2,
  [BEHAVIORS.REVERSAL]: 3,
  [BEHAVIORS.BREAKOUT_RETEST]: 4,
  [BEHAVIORS.SQUEEZE]: 5,
  [BEHAVIORS.MOMENTUM]: 6,
  [BEHAVIORS.BULL_FLAG]: 7,
  [BEHAVIORS.ASCENDING_TRIANGLE]: 8,
  [BEHAVIORS.CONTINUATION]: 9,
};

// ============================================================
// STATE
// ============================================================

const signalMemory = new Map();
const rankingMemory = new Map();

let lastRequestTime = 0;
let stateLoaded = false;
let stateSavePromise = Promise.resolve();

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

const STATE_PATH = path.join(
  currentDirectory,
  "../storage",
  CONFIG.STATE_FILENAME
);

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

function getHighest(candles) {
  return candles.length
    ? Math.max(...candles.map((c) => c.high))
    : 0;
}

function getLowest(candles) {
  return candles.length
    ? Math.min(...candles.map((c) => c.low))
    : 0;
}

// ============================================================
// PERSISTENT SIGNAL STATE
// ============================================================

async function loadPersistentState() {
  if (stateLoaded) return;

  stateLoaded = true;

  try {
    const content = await fs.readFile(STATE_PATH, "utf8");
    const data = JSON.parse(content);

    const now = Date.now();
    const maxAge =
      CONFIG.SIGNAL_MAX_MEMORY_DAYS * 24 * 60 * 60 * 1000;

    for (const [symbol, memory] of Object.entries(
      data.signals || {}
    )) {
      if (
        memory &&
        Number.isFinite(memory.lastSeen) &&
        now - memory.lastSeen <= maxAge
      ) {
        signalMemory.set(symbol, memory);
      }
    }

    for (const [symbol, memory] of Object.entries(
      data.rankings || {}
    )) {
      if (memory && Number.isFinite(memory.stableScore)) {
        rankingMemory.set(symbol, memory);
      }
    }

    console.log(
      `[STATE] Restored ${signalMemory.size} signals and ${rankingMemory.size} rankings`
    );

  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("[STATE LOAD ERROR]", error.message);
    }
  }
}

async function savePersistentState() {
  const data = {
    savedAt: Date.now(),

    signals: Object.fromEntries(signalMemory),

    rankings: Object.fromEntries(rankingMemory),
  };

  const content = JSON.stringify(data);

  stateSavePromise = stateSavePromise
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(STATE_PATH), {
        recursive: true,
      });

      const temporaryPath = `${STATE_PATH}.tmp`;

      await fs.writeFile(
        temporaryPath,
        content,
        "utf8"
      );

      await fs.rename(temporaryPath, STATE_PATH);
    });

  try {
    await stateSavePromise;
  } catch (error) {
    console.error("[STATE SAVE ERROR]", error.message);
  }
}

// ============================================================
// REQUEST ENGINE
// ============================================================

async function requestGate(endpoint, params = {}) {
  let attempt = 0;

  while (attempt <= CONFIG.RETRIES) {
    let timeout;

    try {
      const elapsed = Date.now() - lastRequestTime;

      if (elapsed < CONFIG.REQUEST_DELAY_MS) {
        await sleep(CONFIG.REQUEST_DELAY_MS - elapsed);
      }

      lastRequestTime = Date.now();

      const url = new URL(
        `${CONFIG.API_BASE}${endpoint}`
      );

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
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Gate API ${response.status}`);
      }

      return await response.json();

    } catch (error) {
      attempt++;

      if (attempt > CONFIG.RETRIES) {
        throw error;
      }

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
// CANDLE ANALYSIS
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
      ? (
          candle.high -
          Math.max(candle.open, candle.close)
        ) / range
      : 0,

    lowerWick: range > 0
      ? (
          Math.min(candle.open, candle.close) -
          candle.low
        ) / range
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
      separation: 0,
    };
  }

  const last = closes[closes.length - 1];

  return {
    bullish: ema9 > ema21 && last > ema9,

    ema9,
    ema21,

    distance: changePercent(last, ema21),

    separation: changePercent(ema9, ema21),
  };
}

// ============================================================
// VOLUME ANALYSIS
// ============================================================

function getTurnover(candle) {
  if (candle.turnover > 0) {
    return candle.turnover;
  }

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
    expanded: ratio >= CONFIG.EARLY_VOLUME_RATIO,
  };
}

// ============================================================
// STRUCTURE HELPERS
// ============================================================

function getRange(candles) {
  if (!candles.length) {
    return {
      high: 0,
      low: 0,
      percent: 0,
    };
  }

  const high = getHighest(candles);
  const low = getLowest(candles);

  const middle = (high + low) / 2;

  return {
    high,
    low,
    percent: middle > 0
      ? ((high - low) / middle) * 100
      : 0,
  };
}

function isHigherLow(candles) {
  if (candles.length < 8) return false;

  const first = candles.slice(0, 4);
  const second = candles.slice(4);

  const low1 = getLowest(first);
  const low2 = getLowest(second);

  return low2 > low1;
}

function isLowerHigh(candles) {
  if (candles.length < 8) return false;

  const first = candles.slice(0, 4);
  const second = candles.slice(4);

  return getHighest(second) < getHighest(first);
}

// ============================================================
// CONSOLIDATION
// ============================================================

function detectConsolidation(candles) {
  const lookback = CONFIG.CONSOLIDATION_LOOKBACK;

  if (candles.length < lookback + 5) {
    return { valid: false };
  }

  const base = candles.slice(-lookback - 1, -1);

  const range = getRange(base);

  const averageRange = average(
    base.map((c) => candleInfo(c).rangePercent)
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
    candles: base,
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
    info.closeLocation >= CONFIG.MIN_CLOSE_LOCATION &&
    info.bodyPercent >= CONFIG.MIN_BREAKOUT_BODY &&
    volume.ratio >= CONFIG.BREAKOUT_VOLUME_RATIO;

  if (!breakout) return null;

  return {
    behavior: BEHAVIORS.ACCUMULATION,
    strength: 91,
    fresh: true,
  };
}

// ============================================================
// 2. EARLY PRE-BREAKOUT PRESSURE
// ============================================================

function detectPreBreakout(candles, volume) {
  const consolidation = detectConsolidation(candles);

  if (!consolidation.valid) return null;

  const last = candles[candles.length - 1];
  const info = candleInfo(last);

  const distance = changePercent(
    consolidation.high,
    last.close
  );

  const nearResistance =
    distance >= 0 &&
    distance <= CONFIG.RESISTANCE_DISTANCE_PERCENT;

  const risingLows = isHigherLow(
    candles.slice(-9, -1)
  );

  const bullishPressure =
    last.close > last.open &&
    info.closeLocation >= 0.55 &&
    info.bodyPercent >= CONFIG.MIN_EARLY_CANDLE_BODY;

  const volumeValid =
    volume.ratio >= CONFIG.EARLY_VOLUME_RATIO;

  if (
    nearResistance &&
    risingLows &&
    bullishPressure &&
    volumeValid
  ) {
    return {
      behavior: BEHAVIORS.PRE_BREAKOUT,
      strength: 89,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 3. TREND REVERSAL
// ============================================================

function detectReversal(fast, medium, volume) {
  const recent = fast.slice(-CONFIG.REVERSAL_LOOKBACK);

  if (recent.length < 9) return null;

  const previous = recent.slice(0, -3);
  const latest = recent.slice(-3);

  const previousLow = getLowest(previous);
  const latestLow = getLowest(latest);

  const last = fast[fast.length - 1];
  const previousCandle = fast[fast.length - 2];

  const shortEMA = calculateEMA(
    fast.slice(-20).map((c) => c.close),
    9
  );

  if (!shortEMA) return null;

  const bottomStabilizing =
    latestLow >= previousLow * 0.997;

  const reclaim =
    last.close > shortEMA &&
    last.close > previousCandle.high * 0.998;

  const bullishCandle =
    last.close > last.open &&
    candleInfo(last).closeLocation >= 0.60;

  const volumeValid =
    volume.ratio >= CONFIG.REVERSAL_VOLUME_RATIO;

  const hourlyNotCollapsing =
    getReturn(medium, 2) > -2.5;

  if (
    bottomStabilizing &&
    reclaim &&
    bullishCandle &&
    volumeValid &&
    hourlyNotCollapsing
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
// 4. BULL FLAG
// ============================================================

function detectBullFlag(candles, volume) {
  if (candles.length < 25) return null;

  const impulse = candles.slice(-12, -6);
  const flag = candles.slice(-6, -1);
  const last = candles[candles.length - 1];

  const impulseChange = changePercent(
    impulse[impulse.length - 1].close,
    impulse[0].open
  );

  const impulseHigh = getHighest(impulse);

  const flagLow = getLowest(flag);
  const flagHigh = getHighest(flag);

  const flagRange = getRange(flag);

  const retracement = changePercent(
    impulseHigh,
    flagLow
  );

  const controlledPullback =
    flagRange.percent < 5 &&
    retracement >= 0 &&
    retracement < 65;

  const earlyRecovery =
    last.close > last.open &&
    last.close > flag[flag.length - 1].high;

  if (
    impulseChange >= 2.5 &&
    controlledPullback &&
    earlyRecovery &&
    volume.ratio >= 1.05
  ) {
    return {
      behavior: BEHAVIORS.BULL_FLAG,
      strength: 83,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 5. ASCENDING TRIANGLE
// ============================================================

function detectAscendingTriangle(candles, volume) {
  if (candles.length < 30) return null;

  const base = candles.slice(-19, -1);

  const resistance = getHighest(base);

  const deviation =
    resistance > 0
      ? ((resistance - getLowest(
          base.map((c) => ({
            ...c,
            high: c.high,
          }))
        )) / resistance) * 100
      : 0;

  const risingLows = isHigherLow(base);

  const last = candles[candles.length - 1];

  const approaching =
    last.close >= resistance * 0.995;

  const pressure =
    last.close > last.open &&
    candleInfo(last).closeLocation >= 0.58;

  if (
    deviation <= 5 &&
    risingLows &&
    approaching &&
    pressure &&
    volume.ratio >= 1.05
  ) {
    return {
      behavior: BEHAVIORS.ASCENDING_TRIANGLE,
      strength: 82,
      fresh: true,
    };
  }

  return null;
}

// ============================================================
// 6. BREAKOUT RETEST
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

    const resistance = getHighest(before);

    const breakoutCandle = candles[breakoutIndex];

    if (breakoutCandle.close <= resistance) continue;

    const retest = candles.slice(
      breakoutIndex + 1
    );

    const retestLow = getLowest(retest);

    const held =
      retestLow >= resistance * 0.985;

    const recovered =
      last.close > last.open &&
      last.close > resistance * 0.998;

    if (
      held &&
      recovered &&
      volume.ratio >= 1.0
    ) {
      return {
        behavior: BEHAVIORS.BREAKOUT_RETEST,
        strength: 87,
        fresh: true,
      };
    }
  }

  return null;
}

// ============================================================
// 7. EARLY MOMENTUM EXPANSION
// ============================================================

function detectMomentumExpansion(candles, volume) {
  const last = candles[candles.length - 1];

  const change15 = getReturn(candles, 1);
  const change30 = getReturn(candles, 2);

  const info = candleInfo(last);

  const previousCandles = candles.slice(-5, -1);

  const previousAverageBody = average(
    previousCandles.map((c) =>
      Math.abs(changePercent(c.close, c.open))
    )
  );

  const expandingBody =
    Math.abs(info.bodyPercent) >
    previousAverageBody * 1.15;

  const valid =
    change15 >= CONFIG.MIN_EARLY_MOMENTUM_15M &&
    change30 > 0 &&
    last.close > last.open &&
    info.closeLocation >= 0.65 &&
    volume.ratio >= CONFIG.EARLY_VOLUME_RATIO &&
    expandingBody;

  if (!valid) return null;

  return {
    behavior: BEHAVIORS.MOMENTUM,
    strength: change15 >= CONFIG.MIN_STRONG_MOMENTUM_15M
      ? 90
      : 84,
    fresh: true,
  };
}

// ============================================================
// 8. TREND CONTINUATION
// ============================================================

function detectTrendContinuation(fast, medium, slow, volume) {
  const trend1h = analyzeTrend(medium);
  const trend4h = analyzeTrend(slow);

  const recent = fast.slice(-8);

  const correction = recent.some(
    (c) => c.close < c.open
  );

  const higherLow = isHigherLow(recent);

  const last = fast[fast.length - 1];

  const ema9 = calculateEMA(
    fast.map((c) => c.close),
    9
  );

  const recovery =
    ema9 &&
    last.close > last.open &&
    last.close > ema9;

  if (
    trend1h.bullish &&
    trend4h.bullish &&
    correction &&
    higherLow &&
    recovery &&
    volume.ratio >= 1.0
  ) {
    return {
      behavior: BEHAVIORS.CONTINUATION,
      strength: 77,
      fresh: false,
    };
  }

  return null;
}

// ============================================================
// 9. VOLATILITY SQUEEZE BREAKOUT
// ============================================================

function detectSqueezeBreakout(candles, volume) {
  if (candles.length < 45) return null;

  const recent = candles.slice(-17, -1);
  const older = candles.slice(-41, -17);

  const recentRange = getRange(recent);
  const olderRange = getRange(older);

  const compressed =
    recentRange.percent < 4.5 &&
    olderRange.percent > 0 &&
    recentRange.percent < olderRange.percent * 0.75;

  const last = candles[candles.length - 1];

  const breakout =
    last.close > recentRange.high &&
    last.close > last.open &&
    candleInfo(last).closeLocation >= 0.62 &&
    volume.ratio >= CONFIG.BREAKOUT_VOLUME_RATIO;

  if (compressed && breakout) {
    return {
      behavior: BEHAVIORS.SQUEEZE,
      strength: 88,
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
    () => detectPreBreakout(fast, volume),
    () => detectReversal(fast, medium, volume),
    () => detectBreakoutRetest(fast, volume),
    () => detectSqueezeBreakout(fast, volume),
    () => detectMomentumExpansion(fast, volume),
    () => detectBullFlag(fast, volume),
    () => detectAscendingTriangle(fast, volume),
    () => detectTrendContinuation(
      fast,
      medium,
      slow,
      volume
    ),
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
// MARKET AND EXTENSION VALIDATION
// ============================================================

function validateTrend(fast, medium, slow, btc) {
  const trend1h = analyzeTrend(medium);

  const change4h = getReturn(slow, 1);
  const change24h = getReturn(slow, 6);

  const currentPrice = fast[fast.length - 1].close;

  // Prevent entering after an already extended move.
  const tooExtended =
    change4h > CONFIG.MAX_CHANGE_4H ||
    change24h > CONFIG.MAX_CHANGE_24H ||
    trend1h.distance > CONFIG.MAX_DISTANCE_FROM_EMA;

  if (tooExtended) return false;

  // Avoid severe BTC collapse.
  if (
    btc.change1h <= CONFIG.BTC_MAX_DROP_1H &&
    btc.change4h <= CONFIG.BTC_MAX_DROP_4H
  ) {
    return false;
  }

  // Soft hourly validation:
  // A positive 1h trend is NOT mandatory.
  // Early reversals are allowed if the hourly decline
  // is not excessively strong.
  const hourlyNotCollapsing =
    getReturn(medium, 2) > -3.5;

  if (!hourlyNotCollapsing) return false;

  // Do not require the 15m candle to be above EMA21.
  // Only reject a clear immediate breakdown.
  const previous = fast[fast.length - 2];

  const fastStructureValid =
    currentPrice >= previous.close * 0.992;

  if (!fastStructureValid) return false;

  return true;
}

// ============================================================
// INTERNAL QUALITY SCORE
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

  if (trend1h.bullish) score += 3;
  if (trend4h.bullish) score += 2;

  if (volume.ratio >= 2) score += 5;
  else if (volume.ratio >= 1.5) score += 3;

  if (change15 > 0) score += 2;
  if (change1h > 0) score += 2;

  if (btc.change1h < -1) score -= 4;

  if (quoteVolume >= 1000000) score += 3;

  if (trend1h.distance > 7) score -= 8;

  return clamp(score, 0, 100);
}

// ============================================================
// SIGNAL LIFECYCLE
// ============================================================

function updateSignalState(candidate) {
  const now = Date.now();

  const previous = signalMemory.get(candidate.symbol);

  const candleTime = candidate.candleTime;

  if (!previous) {
    signalMemory.set(candidate.symbol, {
      firstSeen: now,
      lastSeen: now,
      lastSignalCandle: candleTime,
      lastCandleTime: candleTime,
      behavior: candidate.behavior,
      active: true,
      missingScans: 0,
      marker: "🆕",
    });

    candidate.marker = "🆕";
    candidate.stage = "NEW_TREND";

    return;
  }

  const elapsedSinceLastSeen =
    (now - previous.lastSeen) / 60000;

  const wasInactive =
    previous.active === false ||
    elapsedSinceLastSeen > CONFIG.SIGNAL_REACTIVATION_MINUTES;

  const isNewCandle =
    candleTime > (previous.lastSignalCandle || 0);

  // A changed behavior on the same market movement
  // does not automatically create a new signal.
  const isNewSignal =
    wasInactive &&
    isNewCandle;

  if (isNewSignal) {
    previous.firstSeen = now;
    previous.lastSignalCandle = candleTime;

    candidate.marker = "🆕";
    candidate.stage = "NEW_TREND";

  } else {
    candidate.marker = "🟢";
    candidate.stage = "CONTINUATION";

    if (isNewCandle) {
      previous.lastSignalCandle = candleTime;
    }
  }

  previous.lastSeen = now;
  previous.lastCandleTime = candleTime;
  previous.behavior = candidate.behavior;
  previous.active = true;
  previous.missingScans = 0;
  previous.marker = candidate.marker;
}

function updateMissingSignals(currentSymbols) {
  for (const [symbol, memory] of signalMemory) {
    if (currentSymbols.has(symbol)) continue;

    memory.missingScans =
      (memory.missingScans || 0) + 1;

    if (memory.missingScans >= 2) {
      memory.active = false;
    }
  }
}

function cleanupSignalMemory() {
  const now = Date.now();

  const maxAge =
    CONFIG.SIGNAL_MAX_MEMORY_DAYS * 24 * 60 * 60 * 1000;

  for (const [symbol, memory] of signalMemory) {
    if (now - memory.lastSeen > maxAge) {
      signalMemory.delete(symbol);
    }
  }

  for (const [symbol, memory] of rankingMemory) {
    if (
      (memory.missingScans || 0) >= 5 ||
      now - (memory.lastSeen || 0) > maxAge
    ) {
      rankingMemory.delete(symbol);
    }
  }
}

// ============================================================
// STABLE RANKING
// ============================================================

function updateRankingMemory(candidates) {
  const currentSymbols = new Set(
    candidates.map((c) => c.symbol)
  );

  for (const [symbol, memory] of rankingMemory) {
    if (!currentSymbols.has(symbol)) {
      memory.missingScans =
        (memory.missingScans || 0) + 1;
    }
  }

  for (const candidate of candidates) {
    const previous = rankingMemory.get(candidate.symbol);

    if (!previous) {
      rankingMemory.set(candidate.symbol, {
        stableScore: candidate.quality,
        missingScans: 0,
        lastSeen: Date.now(),
      });

      candidate.stableScore = candidate.quality;

      continue;
    }

    previous.stableScore =
      previous.stableScore *
        CONFIG.RANKING_MEMORY_WEIGHT +
      candidate.quality *
        CONFIG.RANKING_NEW_WEIGHT;

    previous.missingScans = 0;
    previous.lastSeen = Date.now();

    candidate.stableScore = previous.stableScore;
  }

  const sorted = [...candidates].sort(
    (a, b) => b.stableScore - a.stableScore
  );

  sorted.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });

  return sorted;
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

      await new Promise((resolve) => {
        waiting.push(resolve);
      });

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
// COIN ANALYSIS
// ============================================================

async function analyzeCoin(ticker, btc, semaphore) {
  const symbol = normalizeSymbol(ticker.contract);

  if (!symbol || symbol === CONFIG.BTC_SYMBOL) {
    return null;
  }

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

    const behavior = detectBullishBehavior(
      fast,
      medium,
      slow
    );

    if (!behavior) return null;

    const trendValid = validateTrend(
      fast,
      medium,
      slow,
      btc
    );

    if (!trendValid) return null;

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

      stage: "NEW_TREND",
      marker: "🆕",

      candleTime: fast[fast.length - 1].time,

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
    console.error(
      `[COIN ERROR] ${symbol}: ${error.message}`
    );

    return null;

  } finally {
    release();
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
  const visibleCandidates = candidates.slice(
    0,
    CONFIG.MAX_REPORT_ITEMS
  );

  const lines = [
    "🚀 GATE.IO | EARLY LONG RADAR",
    "━━━━━━━━━━━━━━━━━━",
    `📊 بازار: ${stats.totalMarkets}`,
    `💧 نقدشونده: ${stats.liquidMarkets}`,
    `🔍 بررسی‌شده: ${stats.scannedMarkets}`,
    `📌 فرصت‌ها: ${candidates.length}`,
    `📋 نمایش: ${visibleCandidates.length}`,
    "━━━━━━━━━━━━━━━━━━",
  ];

  if (!candidates.length) {
    lines.push(
      "",
      "در حال حاضر فرصت صعودی واجد شرایطی شناسایی نشد."
    );

    return lines.join("\n");
  }

  visibleCandidates.forEach((candidate) => {
    lines.push(
      "",
      formatCandidate(candidate),
      "──────────────────"
    );
  });

  lines.push(
    "",
    "🆕 شروع تازه | 🟢 ادامه موقعیت قبلی"
  );

  if (candidates.length > visibleCandidates.length) {
    lines.push(
      "",
      `تعداد ${candidates.length - visibleCandidates.length} فرصت دیگر در فایل JSON موجود است.`
    );
  }

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

        if (attempt > CONFIG.RETRIES) {
          throw error;
        }

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

      if (attempt > CONFIG.RETRIES) {
        throw error;
      }

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
  console.log("GATE.IO EARLY LONG RADAR");
  console.log("========================================\n");

  await loadPersistentState();

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

  // Mark disappeared candidates as inactive only after
  // consecutive scans without a valid signal.
  updateMissingSignals(
    new Set(results.map((candidate) => candidate.symbol))
  );

  // Stable internal ranking.
  const rankedCandidates = updateRankingMemory(results);

  cleanupSignalMemory();

  // Persist lifecycle and ranking state.
  await savePersistentState();

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

    strategy: "EARLY LONG RADAR",

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

  // Preserve existing storage integration.
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
