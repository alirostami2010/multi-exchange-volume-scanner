
/**
 * GATE.IO USDT PERPETUAL — INDEPENDENT LONG RADAR
 * ------------------------------------------------------------
 * LONG ONLY
 *
 * هدف:
 * 1) کشف شروع حرکت صعودی قبل از جهش‌های بزرگ
 * 2) شناسایی ارزهای قدرتمند حتی هنگام نزول BTC
 * 3) تشخیص افزایش قیمت همراه با افزایش گردش مالی
 * 4) تشخیص استمرار حرکت در تایم‌فریم‌های 15m و 1h و 4h
 * 5) جداسازی حرکت اولیه از حرکت پیشرفته
 *
 * TIMEFRAMES:
 * 15m = کشف حرکت تازه و شتاب اولیه
 * 1h  = تأیید استمرار و قدرت حرکت
 * 4h  = بررسی جهت کلی و فضای حرکت
 * BTC = معیار سنجش قدرت مستقل ارز
 *
 * IMPORTANT:
 * Buy pressure is ESTIMATED from candle structure and turnover.
 * It is NOT verified taker-buy volume.
 *
 * FILE:
 * src/scanner/marketScanner.js
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
    MEDIUM: 60,
    SLOW: 40,
  },

  // Liquidity protection
  MIN_QUOTE_VOLUME_24H: 100000,
  MAX_MARKETS_PER_SCAN: 0,

  // Request control
  CONCURRENCY: 3,
  REQUEST_DELAY_MS: 150,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,

  // Analysis
  VOLUME_BASELINE_CANDLES: 20,
  MIN_HISTORY_FAST: 25,
  MIN_HISTORY_MEDIUM: 15,
  MIN_HISTORY_SLOW: 10,

  // Early movement thresholds
  EARLY_MIN_CHANGE_15M: 0.25,
  EARLY_MIN_CHANGE_1H: 0.50,
  EARLY_MIN_CHANGE_4H: 0.50,

  // Strong movement thresholds
  STRONG_CHANGE_15M: 0.80,
  STRONG_CHANGE_1H: 1.50,

  // Turnover expansion
  MIN_TURNOVER_RATIO: 1.25,
  STRONG_TURNOVER_RATIO: 2.0,

  // Relative strength
  MIN_RELATIVE_STRENGTH: 0.50,
  STRONG_RELATIVE_STRENGTH: 2.0,

  // Avoid extreme late entries in early category
  EARLY_MAX_CHANGE_24H: 18,
  ADVANCED_MIN_CHANGE_24H: 20,

  // Abnormal candle protection
  MAX_SINGLE_CANDLE_CHANGE_15M: 12,
  MAX_SINGLE_CANDLE_CHANGE_1H: 35,

  // Ranking
  MIN_SCORE: 35,

  // Reporting
  MAX_REPORT_ITEMS: 30,
  TELEGRAM_MAX_LENGTH: 3900,

  // BTC benchmark
  BTC_SYMBOL_ALIASES: ["BTC_USDT", "BTCUSDT"],
};

// ============================================================
// UTILITIES
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
};

const percentChange = (current, previous) => {
  if (!previous || previous <= 0) return 0;
  return ((current - previous) / previous) * 100;
};

const median = (values) => {
  const clean = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (!clean.length) return 0;

  const middle = Math.floor(clean.length / 2);

  return clean.length % 2
    ? clean[middle]
    : (clean[middle - 1] + clean[middle]) / 2;
};

const average = (values) => {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return 0;

  return clean.reduce((sum, value) => sum + value, 0) /
    clean.length;
};

const formatPercent = (value) => {
  const sign = value > 0 ? "+" : "";
  return `${sign}${round(value)}%`;
};

const normalizeSymbol = (symbol) =>
  String(symbol || "").replace("/", "_").toUpperCase();

const isValidPrice = (value) =>
  Number.isFinite(value) && value > 0;

// ============================================================
// REQUEST ENGINE
// ============================================================

let lastRequestTime = 0;

async function requestGate(path, params = {}) {
  let attempt = 0;

  while (attempt <= CONFIG.RETRIES) {
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

      const timeout = setTimeout(
        () => controller.abort(),
        CONFIG.REQUEST_TIMEOUT_MS
      );

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        throw new Error(
          `Gate API ${response.status}: ${errorText.slice(0, 200)}`
        );
      }

      return await response.json();
    } catch (error) {
      attempt++;

      if (attempt > CONFIG.RETRIES) {
        throw error;
      }

      await sleep(500 * attempt);
    }
  }

  throw new Error("Request failed");
}

// ============================================================
// MARKET DATA
// ============================================================

async function getContracts() {
  const result = await requestGate(
    `/futures/${CONFIG.SETTLE}/contracts`
  );

  return Array.isArray(result) ? result : [];
}

async function getTickers() {
  const result = await requestGate(
    `/futures/${CONFIG.SETTLE}/tickers`
  );

  return Array.isArray(result) ? result : [];
}

async function getCandles(symbol, interval, limit) {
  const result = await requestGate(
    `/futures/${CONFIG.SETTLE}/candlesticks`,
    {
      contract: symbol,
      interval,
      limit,
    }
  );

  if (!Array.isArray(result)) return [];

  return result
    .map((item) => {
      // Gate.io normally returns candle objects.
      // Array support is retained as a defensive fallback.
      if (Array.isArray(item)) {
        return {
          time: toNumber(item[0]),
          volume: toNumber(item[1]),
          close: toNumber(item[2]),
          high: toNumber(item[3]),
          low: toNumber(item[4]),
          open: toNumber(item[5]),
          turnover: toNumber(item[6]),
        };
      }

      return {
        time: toNumber(item.t),
        volume: toNumber(item.v),
        close: toNumber(item.c),
        high: toNumber(item.h),
        low: toNumber(item.l),
        open: toNumber(item.o),
        turnover: toNumber(item.sum),
      };
    })
    .filter(
      (candle) =>
        isValidPrice(candle.open) &&
        isValidPrice(candle.close) &&
        isValidPrice(candle.high) &&
        isValidPrice(candle.low)
    )
    .sort((a, b) => a.time - b.time);
}

function getClosedCandles(candles, intervalSeconds) {
  const now = Math.floor(Date.now() / 1000);

  return candles.filter(
    (candle) => candle.time + intervalSeconds <= now
  );
}

// ============================================================
// CANDLE ANALYSIS
// ============================================================

function analyzeCandle(candle) {
  const range = Math.max(candle.high - candle.low, 0);

  const body = candle.close - candle.open;

  const bodyPercent = percentChange(
    candle.close,
    candle.open
  );

  const closeLocation =
    range > 0
      ? (candle.close - candle.low) / range
      : 0.5;

  const upperWick =
    range > 0
      ? (candle.high - Math.max(candle.open, candle.close)) /
        range
      : 0;

  const lowerWick =
    range > 0
      ? (Math.min(candle.open, candle.close) - candle.low) /
        range
      : 0;

  return {
    bullish: body > 0,
    bodyPercent: round(bodyPercent),
    closeLocation: round(closeLocation, 3),
    upperWick: round(upperWick, 3),
    lowerWick: round(lowerWick, 3),
    rangePercent: round(
      percentChange(candle.high, candle.low)
    ),
  };
}

function getReturn(candles, count) {
  if (!candles || candles.length < count + 1) return 0;

  const current = candles[candles.length - 1].close;
  const previous = candles[candles.length - 1 - count].close;

  return percentChange(current, previous);
}

function getTurnover(candle) {
  if (candle.turnover > 0) return candle.turnover;

  return candle.volume * candle.close;
}

function analyzeTurnover(candles) {
  if (!candles || candles.length < 5) {
    return {
      ratio: 0,
      current: 0,
      baseline: 0,
      expanded: false,
    };
  }

  const currentCandle = candles[candles.length - 1];
  const current = getTurnover(currentCandle);

  const baselineCandles = candles.slice(
    -CONFIG.VOLUME_BASELINE_CANDLES - 1,
    -1
  );

  const baselineValues = baselineCandles
    .map(getTurnover)
    .filter((value) => value > 0);

  const baseline = median(baselineValues);

  const ratio = baseline > 0 ? current / baseline : 0;

  return {
    ratio: round(ratio, 2),
    current: round(current, 2),
    baseline: round(baseline, 2),
    expanded: ratio >= CONFIG.MIN_TURNOVER_RATIO,
  };
}

// ============================================================
// ESTIMATED BUY PRESSURE
// ============================================================

function estimateBuyPressure(candles) {
  if (!candles || candles.length < 4) {
    return {
      score: 0,
      label: "داده ناکافی",
      bullishCandles: 0,
      averageCloseLocation: 0,
    };
  }

  const recent = candles.slice(-4);

  let bullishCandles = 0;
  let weightedPressure = 0;
  let totalWeight = 0;

  for (const candle of recent) {
    const structure = analyzeCandle(candle);
    const turnover = Math.max(getTurnover(candle), 1);

    if (structure.bullish) bullishCandles++;

    const candlePressure =
      structure.closeLocation * 0.55 +
      (structure.bullish ? 0.30 : 0) +
      (1 - structure.upperWick) * 0.15;

    weightedPressure += candlePressure * turnover;
    totalWeight += turnover;
  }

  const score =
    totalWeight > 0
      ? (weightedPressure / totalWeight) * 100
      : 0;

  let label = "ضعیف";

  if (score >= 75) label = "قوی";
  else if (score >= 62) label = "مناسب";
  else if (score >= 50) label = "متوسط";

  return {
    score: round(score),
    label,
    bullishCandles,
    averageCloseLocation: round(
      average(recent.map((c) => analyzeCandle(c).closeLocation)),
      3
    ),
  };
}

// ============================================================
// MOMENTUM ANALYSIS
// ============================================================

function analyzeFastTimeframe(candles) {
  if (candles.length < CONFIG.MIN_HISTORY_FAST) {
    return {
      valid: false,
      reason: "تاریخچه 15 دقیقه کافی نیست",
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const change15m = percentChange(
    last.close,
    previous.close
  );

  const change30m = getReturn(candles, 2);
  const change1h = getReturn(candles, 4);
  const change2h = getReturn(candles, 8);

  const candleStructure = analyzeCandle(last);
  const turnover = analyzeTurnover(candles);
  const pressure = estimateBuyPressure(candles);

  const previousChanges = candles
    .slice(-5, -1)
    .map((candle, index, array) => {
      const previousCandle = array[index - 1];
      if (!previousCandle) return 0;

      return percentChange(
        candle.close,
        previousCandle.close
      );
    });

  const previousMomentum = average(previousChanges);

  const acceleration = change15m - previousMomentum;

  const abnormalCandle =
    Math.abs(change15m) >
    CONFIG.MAX_SINGLE_CANDLE_CHANGE_15M;

  const positiveMomentum =
    change15m >= CONFIG.EARLY_MIN_CHANGE_15M ||
    change30m >= CONFIG.EARLY_MIN_CHANGE_15M ||
    change1h >= CONFIG.EARLY_MIN_CHANGE_1H;

  const priceAndTurnover =
    positiveMomentum &&
    turnover.ratio >= CONFIG.MIN_TURNOVER_RATIO;

  return {
    valid: true,

    change15m: round(change15m),
    change30m: round(change30m),
    change1h: round(change1h),
    change2h: round(change2h),

    acceleration: round(acceleration),

    candleStructure,
    turnover,
    pressure,

    positiveMomentum,
    priceAndTurnover,
    abnormalCandle,

    lastPrice: last.close,
  };
}

function analyzeMediumTimeframe(candles) {
  if (candles.length < CONFIG.MIN_HISTORY_MEDIUM) {
    return {
      valid: false,
      reason: "تاریخچه یک‌ساعته کافی نیست",
    };
  }

  const change1h = getReturn(candles, 1);
  const change3h = getReturn(candles, 3);
  const change6h = getReturn(candles, 6);
  const change12h = getReturn(candles, 12);

  const turnover = analyzeTurnover(candles);
  const pressure = estimateBuyPressure(candles);

  const recent = candles.slice(-6);

  const bullishCount = recent.filter(
    (candle) => candle.close > candle.open
  ).length;

  const continuity = bullishCount / recent.length;

  const rising =
    change1h > 0 &&
    (change3h > 0 || change6h > 0);

  return {
    valid: true,

    change1h: round(change1h),
    change3h: round(change3h),
    change6h: round(change6h),
    change12h: round(change12h),

    turnover,
    pressure,

    bullishCount,
    continuity: round(continuity, 2),
    rising,
  };
}

function analyzeSlowTimeframe(candles) {
  if (candles.length < CONFIG.MIN_HISTORY_SLOW) {
    return {
      valid: false,
      reason: "تاریخچه چهار‌ساعته کافی نیست",
    };
  }

  const change4h = getReturn(candles, 1);
  const change8h = getReturn(candles, 2);
  const change12h = getReturn(candles, 3);
  const change24h = getReturn(candles, 6);

  const recent = candles.slice(-6);

  const bullishCount = recent.filter(
    (candle) => candle.close > candle.open
  ).length;

  const continuity = bullishCount / recent.length;

  const rising =
    change4h > 0 &&
    (change8h > 0 || change12h > 0);

  return {
    valid: true,

    change4h: round(change4h),
    change8h: round(change8h),
    change12h: round(change12h),
    change24h: round(change24h),

    bullishCount,
    continuity: round(continuity, 2),
    rising,
  };
}

// ============================================================
// BTC BENCHMARK
// ============================================================

function analyzeBitcoin(candles) {
  const fast = analyzeFastTimeframe(candles);
  const medium = analyzeMediumTimeframe(candles);
  const slow = analyzeSlowTimeframe(candles);

  return {
    valid: fast.valid && medium.valid && slow.valid,

    change15m: fast.change15m || 0,
    change1h: medium.change1h || 0,
    change4h: slow.change4h || 0,
    change24h: slow.change24h || 0,

    fast,
    medium,
    slow,
  };
}

function calculateRelativeStrength(coin, btc) {
  return {
    rs15m: round(coin.fast.change15m - btc.change15m),
    rs1h: round(coin.medium.change1h - btc.change1h),
    rs4h: round(coin.slow.change4h - btc.change4h),
    rs24h: round(coin.change24h - btc.change24h),
  };
}

// ============================================================
// MOVEMENT CLASSIFICATION
// ============================================================

function classifyMovement(data) {
  const {
    fast,
    medium,
    slow,
    relative,
    change24h,
  } = data;

  const independent =
    (
      relative.rs1h >= CONFIG.MIN_RELATIVE_STRENGTH ||
      relative.rs4h >= CONFIG.MIN_RELATIVE_STRENGTH
    );

  const strongIndependent =
    (
      relative.rs1h >= CONFIG.STRONG_RELATIVE_STRENGTH ||
      relative.rs4h >= CONFIG.STRONG_RELATIVE_STRENGTH
    );

  const earlyMomentum =
    fast.change15m >= CONFIG.EARLY_MIN_CHANGE_15M ||
    fast.change30m >= CONFIG.EARLY_MIN_CHANGE_15M ||
    fast.change1h >= CONFIG.EARLY_MIN_CHANGE_1H;

  const volumeConfirmed =
    fast.turnover.ratio >= CONFIG.MIN_TURNOVER_RATIO ||
    medium.turnover.ratio >= CONFIG.MIN_TURNOVER_RATIO;

  const strongMomentum =
    fast.change15m >= CONFIG.STRONG_CHANGE_15M ||
    medium.change1h >= CONFIG.STRONG_CHANGE_1H;

  const advanced =
    change24h >= CONFIG.ADVANCED_MIN_CHANGE_24H;

  const early =
    earlyMomentum &&
    volumeConfirmed &&
    !advanced &&
    !fast.abnormalCandle;

  if (advanced) {
    return {
      stage: "ADVANCED",
      stageLabel: "حرکت پیشرفته",
      independent,
      strongIndependent,
      eligible: true,
    };
  }

  if (early && independent) {
    return {
      stage: "EARLY_INDEPENDENT",
      stageLabel: "شروع حرکت مستقل",
      independent: true,
      strongIndependent,
      eligible: true,
    };
  }

  if (early) {
    return {
      stage: "EARLY",
      stageLabel: "شروع حرکت",
      independent,
      strongIndependent,
      eligible: true,
    };
  }

  if (
    strongMomentum &&
    volumeConfirmed &&
    (medium.rising || slow.rising)
  ) {
    return {
      stage: "STRONG",
      stageLabel: "رشد قدرتمند",
      independent,
      strongIndependent,
      eligible: true,
    };
  }

  if (
    medium.rising &&
    volumeConfirmed &&
    independent
  ) {
    return {
      stage: "INDEPENDENT",
      stageLabel: "قدرت مستقل از BTC",
      independent: true,
      strongIndependent,
      eligible: true,
    };
  }

  return {
    stage: "WATCH",
    stageLabel: "زیر نظر",
    independent,
    strongIndependent,
    eligible: false,
  };
}

// ============================================================
// SCORING
// ============================================================

function scoreMomentum(fast, medium, slow) {
  let score = 0;

  score += clamp(fast.change15m * 5, 0, 15);
  score += clamp(fast.change30m * 2.5, 0, 10);
  score += clamp(fast.change1h * 2, 0, 12);

  score += clamp(medium.change3h * 1.2, 0, 8);
  score += clamp(medium.change6h * 0.7, 0, 6);

  score += clamp(slow.change4h * 0.8, 0, 5);

  return score;
}

function scoreTurnover(fast, medium) {
  let score = 0;

  score += clamp(
    (fast.turnover.ratio - 1) * 10,
    0,
    15
  );

  score += clamp(
    (medium.turnover.ratio - 1) * 6,
    0,
    10
  );

  return score;
}

function scorePressure(fast, medium) {
  const score =
    fast.pressure.score * 0.65 +
    medium.pressure.score * 0.35;

  return clamp((score - 45) * 0.35, 0, 12);
}

function scoreRelativeStrength(relative) {
  let score = 0;

  score += clamp(relative.rs15m * 1.5, 0, 5);
  score += clamp(relative.rs1h * 1.5, 0, 10);
  score += clamp(relative.rs4h * 0.8, 0, 8);

  return score;
}

function scoreContinuity(medium, slow) {
  return clamp(
    medium.continuity * 7 +
    slow.continuity * 5,
    0,
    12
  );
}

function scoreAcceleration(fast) {
  return clamp(fast.acceleration * 3, 0, 8);
}

function calculateScore(data) {
  const {
    fast,
    medium,
    slow,
    relative,
    classification,
    quoteVolume,
  } = data;

  let score = 0;

  score += scoreMomentum(fast, medium, slow);
  score += scoreTurnover(fast, medium);
  score += scorePressure(fast, medium);
  score += scoreRelativeStrength(relative);
  score += scoreContinuity(medium, slow);
  score += scoreAcceleration(fast);

  // Liquidity quality
  if (quoteVolume >= 1000000) score += 5;
  else if (quoteVolume >= 500000) score += 3;
  else if (quoteVolume >= 200000) score += 2;

  // Independent movement bonus
  if (classification.independent) score += 5;
  if (classification.strongIndependent) score += 4;

  // Early movement bonus
  if (classification.stage === "EARLY_INDEPENDENT") {
    score += 8;
  } else if (classification.stage === "EARLY") {
    score += 5;
  }

  // Advanced moves remain visible but lose early-entry priority.
  if (classification.stage === "ADVANCED") {
    score -= 8;
  }

  // Penalize extreme one-candle spikes.
  if (fast.abnormalCandle) score -= 15;

  // Penalize weak close location.
  if (fast.candleStructure.closeLocation < 0.45) {
    score -= 5;
  }

  // Penalize negative medium trend.
  if (!medium.rising && medium.change1h < 0) {
    score -= 5;
  }

  return Math.round(clamp(score, 0, 100));
}

// ============================================================
// COIN ANALYSIS
// ============================================================

async function analyzeCoin(ticker, btc, semaphore) {
  const symbol = normalizeSymbol(ticker.contract);

  if (!symbol || symbol === CONFIG.BTC_SYMBOL) {
    return null;
  }

  const quoteVolume = toNumber(
    ticker.volume_24h_quote
  );

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

    const fastCandles = getClosedCandles(rawFast, 15 * 60);
    const mediumCandles = getClosedCandles(rawMedium, 60 * 60);
    const slowCandles = getClosedCandles(rawSlow, 4 * 60 * 60);

    if (
      fastCandles.length < CONFIG.MIN_HISTORY_FAST ||
      mediumCandles.length < CONFIG.MIN_HISTORY_MEDIUM ||
      slowCandles.length < CONFIG.MIN_HISTORY_SLOW
    ) {
      return null;
    }

    const fast = analyzeFastTimeframe(fastCandles);
    const medium = analyzeMediumTimeframe(mediumCandles);
    const slow = analyzeSlowTimeframe(slowCandles);

    if (!fast.valid || !medium.valid || !slow.valid) {
      return null;
    }

    const lastPrice = toNumber(
      ticker.last,
      fast.lastPrice
    );

    const change24h = toNumber(
      ticker.change_percentage
    );

    const relative = calculateRelativeStrength(
      {
        fast,
        medium,
        slow,
        change24h,
      },
      btc
    );

    const classification = classifyMovement({
      fast,
      medium,
      slow,
      relative,
      change24h,
    });

    if (!classification.eligible) {
      return null;
    }

    const candidateData = {
      fast,
      medium,
      slow,
      relative,
      classification,
      quoteVolume,
    };

    const score = calculateScore({
      ...candidateData,
      change24h,
    });

    if (score < CONFIG.MIN_SCORE) {
      return null;
    }

    const result = {
      symbol,
      contract: symbol,

      price: lastPrice,
      lastPrice,

      score,

      stage: classification.stage,
      stageLabel: classification.stageLabel,

      independent: classification.independent,
      strongIndependent: classification.strongIndependent,

      change24h: round(change24h),

      change15m: fast.change15m,
      change30m: fast.change30m,
      change1h: medium.change1h,
      change3h: medium.change3h,
      change4h: slow.change4h,
      change6h: medium.change6h,

      relativeStrength: relative,

      volumeRatio15m: fast.turnover.ratio,
      volumeRatio1h: medium.turnover.ratio,

      turnover15m: fast.turnover.current,
      turnover1h: medium.turnover.current,

      buyPressure: {
        score: fast.pressure.score,
        label: fast.pressure.label,
        estimated: true,
      },

      mediumBuyPressure: {
        score: medium.pressure.score,
        label: medium.pressure.label,
        estimated: true,
      },

      continuity1h: medium.continuity,
      continuity4h: slow.continuity,

      acceleration15m: fast.acceleration,

      quoteVolume24h: quoteVolume,

      btcChange15m: btc.change15m,
      btcChange1h: btc.change1h,
      btcChange4h: btc.change4h,
      btcChange24h: btc.change24h,

      btcCondition:
        btc.change1h < 0 || btc.change4h < 0
          ? "BTC نزولی"
          : "BTC خنثی/صعودی",

      diagnostics: {
        fast,
        medium,
        slow,
        relative,
        classification,
      },

      scannedAt: new Date().toISOString(),
    };

    return result;
  } catch (error) {
    return null;
  } finally {
    release();
  }
}

// ============================================================
// CONCURRENCY CONTROL
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
// RANKING
// ============================================================

const STAGE_PRIORITY = {
  EARLY_INDEPENDENT: 1,
  EARLY: 2,
  STRONG: 3,
  INDEPENDENT: 4,
  ADVANCED: 5,
};

function rankCandidates(candidates) {
  return candidates.sort((a, b) => {
    const stageA = STAGE_PRIORITY[a.stage] || 99;
    const stageB = STAGE_PRIORITY[b.stage] || 99;

    // Early independent opportunities get first priority.
    if (stageA !== stageB) {
      return stageA - stageB;
    }

    if (b.score !== a.score) {
      return b.score - a.score;
    }

    if (
      b.relativeStrength.rs1h !==
      a.relativeStrength.rs1h
    ) {
      return (
        b.relativeStrength.rs1h -
        a.relativeStrength.rs1h
      );
    }

    return b.volumeRatio15m - a.volumeRatio15m;
  });
}

// ============================================================
// REPORT HELPERS
// ============================================================

function stageEmoji(stage) {
  const map = {
    EARLY_INDEPENDENT: "🟢",
    EARLY: "🚀",
    STRONG: "🔥",
    INDEPENDENT: "💎",
    ADVANCED: "⚠️",
  };

  return map[stage] || "👀";
}

function formatCandidate(candidate, index) {
  const relative = candidate.relativeStrength;

  return [
    `${index + 1}) ${stageEmoji(candidate.stage)} ${candidate.symbol}`,
    `امتیاز: ${candidate.score}/100 | ${candidate.stageLabel}`,
    `قیمت: ${candidate.price}`,
    `15m: ${formatPercent(candidate.change15m)} | 1h: ${formatPercent(candidate.change1h)} | 4h: ${formatPercent(candidate.change4h)}`,
    `24h: ${formatPercent(candidate.change24h)}`,
    `حجم: 15m ${candidate.volumeRatio15m}x | 1h ${candidate.volumeRatio1h}x`,
    `قدرت نسبت به BTC: 1h ${formatPercent(relative.rs1h)} | 4h ${formatPercent(relative.rs4h)}`,
    `فشار خرید تخمینی: ${candidate.buyPressure.label} (${candidate.buyPressure.score})`,
    `وضعیت BTC: ${candidate.btcCondition}`,
  ].join("\n");
}

function buildReport(candidates, stats, btc) {
  const early = candidates.filter(
    (item) =>
      item.stage === "EARLY_INDEPENDENT" ||
      item.stage === "EARLY"
  );

  const strong = candidates.filter(
    (item) =>
      item.stage === "STRONG" ||
      item.stage === "INDEPENDENT"
  );

  const advanced = candidates.filter(
    (item) => item.stage === "ADVANCED"
  );

  const lines = [
    "🚀 GATE.IO | INDEPENDENT LONG RADAR",
    "━━━━━━━━━━━━━━━━━━",
    "🎯 کشف شروع حرکت و رشد مستقل از BTC",
    "⏱ تایم‌فریم: 15m | 1h | 4h",
    "",
    `📊 کل بازار: ${stats.totalMarkets}`,
    `💧 بازار نقدشونده: ${stats.liquidMarkets}`,
    `✅ بررسی موفق: ${stats.successful}`,
    `📌 فرصت‌های شناسایی‌شده: ${candidates.length}`,
    "",
    `₿ وضعیت BTC: 15m ${formatPercent(btc.change15m)} | 1h ${formatPercent(btc.change1h)} | 4h ${formatPercent(btc.change4h)}`,
    "",
    `🟢 شروع حرکت: ${early.length}`,
    `🔥 رشد قدرتمند: ${strong.length}`,
    `⚠️ حرکت پیشرفته: ${advanced.length}`,
    "━━━━━━━━━━━━━━━━━━",
  ];

  const groups = [
    {
      title: "🟢 شروع حرکت / فرصت‌های اولیه",
      items: early,
    },
    {
      title: "🔥 رشد قدرتمند",
      items: strong,
    },
    {
      title: "⚠️ حرکت پیشرفته / جهش‌های بزرگ",
      items: advanced,
    },
  ];

  for (const group of groups) {
    if (!group.items.length) continue;

    lines.push("", group.title, "━━━━━━━━━━━━━━━━━━");

    group.items
      .slice(0, CONFIG.MAX_REPORT_ITEMS)
      .forEach((candidate, index) => {
        lines.push(
          formatCandidate(candidate, index),
          "──────────────────"
        );
      });
  }

  if (!candidates.length) {
    lines.push(
      "",
      "در این اسکن موقعیت واجد شرایطی پیدا نشد."
    );
  }

  lines.push(
    "",
    "ℹ️ فشار خرید از ساختار کندل و گردش مالی تخمین زده شده است؛ داده قطعی Taker Buy نیست."
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
    return {
      sent: false,
      reason: "Telegram credentials are not configured",
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
  }

  return { sent: true };
}

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
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
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
      `gate-independent-radar-${Date.now()}.json`,
      JSON.stringify(output, null, 2)
    );

    return true;
  } catch (error) {
    console.error(
      "[TELEGRAM ERROR]",
      error.message
    );

    return false;
  }
}

// ============================================================
// MAIN SCANNER
// ============================================================

export async function scanGateMarkets() {
  const startedAt = Date.now();

  console.log("\n========================================");
  console.log("GATE.IO INDEPENDENT LONG RADAR STARTED");
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
        quoteVolume: toNumber(ticker.volume_24h_quote),
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
    `[MARKETS] Total: ${activeContracts.length} | Liquid: ${liquidMarkets.length} | Scanning: ${marketsToScan.length}`
  );

  // BTC data is fetched only once per scan.
  let btcCandles;

  try {
    btcCandles = await getCandles(
      CONFIG.BTC_SYMBOL,
      CONFIG.TIMEFRAMES.FAST,
      CONFIG.CANDLE_LIMITS.FAST
    );

    const btcFastCandles = getClosedCandles(
      btcCandles,
      15 * 60
    );

    const [btc1hRaw, btc4hRaw] = await Promise.all([
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

    const btc1h = getClosedCandles(btc1hRaw, 60 * 60);
    const btc4h = getClosedCandles(btc4hRaw, 4 * 60 * 60);

    const btc = analyzeBitcoin([
      ...btcFastCandles,
    ]);

    // Use timeframe-specific BTC returns.
    const btcBenchmark = {
      ...btc,
      valid:
        btcFastCandles.length >= CONFIG.MIN_HISTORY_FAST &&
        btc1h.length >= CONFIG.MIN_HISTORY_MEDIUM &&
        btc4h.length >= CONFIG.MIN_HISTORY_SLOW,

      change15m: getReturn(btcFastCandles, 1),
      change1h: getReturn(btc1h, 1),
      change4h: getReturn(btc4h, 1),
      change24h: getReturn(btc4h, 6),
    };

    if (!btcBenchmark.valid) {
      throw new Error("BTC benchmark history is insufficient");
    }

    const semaphore = createSemaphore(
      CONFIG.CONCURRENCY
    );

    const results = [];
    let successful = 0;
    let failed = 0;

    let completed = 0;

    const workers = marketsToScan.map(async (market) => {
      const result = await analyzeCoin(
        market.ticker,
        btcBenchmark,
        semaphore
      );

      completed++;

      if (result) {
        successful++;
        results.push(result);
      } else {
        failed++;
      }

      if (completed % 50 === 0) {
        console.log(
          `[PROGRESS] ${completed}/${marketsToScan.length} | Candidates: ${results.length}`
        );
      }
    });

    await Promise.all(workers);

    const rankedCandidates = rankCandidates(results);

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
      stats,
      btcBenchmark
    );

    const output = {
      success: true,

      exchange: "GATE.IO",
      market: "USDT PERPETUAL",

      strategy: "INDEPENDENT LONG RADAR",

      scannedAt: new Date().toISOString(),

      stats,

      btc: {
        change15m: round(btcBenchmark.change15m),
        change1h: round(btcBenchmark.change1h),
        change4h: round(btcBenchmark.change4h),
        change24h: round(btcBenchmark.change24h),
      },

      candidates: rankedCandidates,

      // Compatibility aliases for existing consumers.
      rankedCandidates,
      rankChanges: [],
      historyCount: 0,
      summaryCount: rankedCandidates.length,

      report,
    };

    // Persist scan snapshot.
    try {
      const storageResult = await saveMarketSnapshot(
        rankedCandidates
      );

      if (storageResult) {
        output.historyCount =
          storageResult.historyCount ?? output.historyCount;

        output.summaryCount =
          storageResult.summaryCount ?? output.summaryCount;

        output.rankChanges =
          storageResult.rankChanges ?? output.rankChanges;
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
    console.log(`Candidates: ${stats.candidates}`);
    console.log(`Duration: ${stats.durationMs}ms`);
    console.log("========================================\n");

    console.log(report);

    await sendTelegramReport(output);

    return output;
  } catch (error) {
    console.error(
      "[SCANNER FATAL ERROR]",
      error.message
    );

    const output = {
      success: false,
      error: error.message,
      scannedAt: new Date().toISOString(),
    };

    return output;
  }
}

// ============================================================
// OPTIONAL DIRECT EXECUTION
// ============================================================

const isDirectExecution =
  process.argv[1] &&
  import.meta.url.endsWith(
    process.argv[1].replace(/\\/g, "/")
  );

if (isDirectExecution) {
  scanGateMarkets()
    .then((result) => {
      console.log(
        "[SCANNER RESULT]",
        result.success
          ? `${result.candidates?.length || 0} candidates`
          : result.error
      );

      process.exitCode = result.success ? 0 : 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
