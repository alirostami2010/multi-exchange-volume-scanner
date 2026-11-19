
/**
 * GATE.IO USDT PERPETUAL — FOUR TIMEFRAME BULLISH RADAR
 * Timeframes: 5m confirmation + 15m / 1h / 4h / 1d analysis
 * Base scoring and four-timeframe ranking weights are preserved.
 * File: src/scanner/marketScanner.js | Node.js 20+
 */

import 'dotenv/config';

import {
  saveMarketSnapshot,
  getTradeStates,
} from '../storage/marketStorage.js';

// ========================
// CONFIG
// ========================

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',

  TIMEFRAMES: {
    '5m': { seconds: 300, limit: 100 },
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 },
    '1d': { seconds: 86400, limit: 100 },
  },

  TOP_COUNT: 20,

  MIN_QUOTE_VOLUME_24H: 100000,

  CONCURRENCY: 8,

  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,

  MIN_SCORE: 58,

  MAX_RETURN_15M: 4,
  MAX_RETURN_1H: 6,
  MAX_RETURN_4H: 12,

  NEAR_ENTRY_ATR: 1.25,

  SETUP_MAX_AGE_HOURS: {
    SWING: 240,
    'SHORT-TERM': 72,
    SCALP: 24,
  },
};

// ========================
// HELPERS
// ========================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const average = (values) =>
  values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;

const median = (values) => {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pctChange = (current, previous) =>
  !previous || previous <= 0
    ? 0
    : ((current - previous) / previous) * 100;

const formatPrice = (value) => {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);
  return value.toPrecision(5);
};

const getCandleValue = (candle) =>
  candle.turnover > 0
    ? candle.turnover
    : candle.volume;

// ========================
// HTTP
// ========================

async function fetchJSON(url) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= CONFIG.RETRIES;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(
          CONFIG.REQUEST_TIMEOUT
        ),
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

// ========================
// GATE.IO DATA
// ========================

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
    limit: String(limit),
  });

  const raw = await fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`
  );

  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid candle response: ${contract} ${interval}`
    );
  }

  const candles = raw
    .map((c) => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),
      volume: number(c.v),
      turnover: number(c.sum),
    }))
    .filter(
      (c) =>
        c.time > 0 &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  const intervalSeconds =
    CONFIG.TIMEFRAMES[interval].seconds;

  const currentBucket =
    Math.floor(
      Date.now() / 1000 / intervalSeconds
    ) * intervalSeconds;

  const closed = candles.filter(
    (c) => c.time < currentBucket
  );

  if (!includeCurrent) return closed;

  const current =
    candles.find(
      (c) => c.time === currentBucket
    ) || null;

  return {
    closed,

    current: current
      ? {
          bucketTime: currentBucket,
          open: current.open,
          high: current.high,
          low: current.low,
          close: current.close,
          volume: current.volume,
          turnover: current.turnover,
        }
      : null,
  };
}

// ========================
// CONCURRENCY
// ========================

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);

  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(
          items[index],
          index
        );
      } catch (error) {
        results[index] = {
          error: error.message,
          item: items[index],
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(limit, items.length),
      },
      () => runner()
    )
  );

  return results;
}

// ========================
// INDICATORS
// ========================

function calculateEMA(values, period) {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result = [];

  let ema = average(values.slice(0, period));

  result.push(ema);

  for (let i = period; i < values.length; i++) {
    ema =
      (values[i] - ema) * multiplier + ema;

    result.push(ema);
  }

  return result;
}

function getVolumeRatio(candles) {
  if (candles.length < 25) return 0;

  const recentAverage = average(
    candles.slice(-3).map(getCandleValue)
  );

  const baselineMedian = median(
    candles.slice(-23, -3).map(getCandleValue)
  );

  return baselineMedian > 0
    ? recentAverage / baselineMedian
    : 0;
}

function getCandleStrength(candle) {
  const range = candle.high - candle.low;

  if (range <= 0) {
    return {
      closeLocation: 0,
      bodyRatio: 0,
      bullish: false,
    };
  }

  return {
    closeLocation: clamp(
      (candle.close - candle.low) / range,
      0,
      1
    ),

    bodyRatio: clamp(
      Math.abs(candle.close - candle.open) / range,
      0,
      1
    ),

    bullish: candle.close > candle.open,
  };
}

// ========================
// PRICE STRUCTURE
// ========================

function findSwingPoints(candles, radius = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = radius;
    i < candles.length - radius;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= radius; j++) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) highs.push(current.high);
    if (isLow) lows.push(current.low);
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  if (candles.length < 25) {
    return {
      higherHigh: false,
      higherLow: false,
      breakout: false,
      bullishStructure: false,
      score: 0,
    };
  }

  const swings = findSwingPoints(
    candles.slice(-35),
    2
  );

  const higherHigh =
    swings.highs.length >= 2 &&
    swings.highs.at(-1) > swings.highs.at(-2);

  const higherLow =
    swings.lows.length >= 2 &&
    swings.lows.at(-1) > swings.lows.at(-2);

  const previous = candles.slice(-13, -1);

  const resistance = Math.max(
    ...previous.map((c) => c.high)
  );

  const last = candles.at(-1);

  const breakout =
    resistance > 0 &&
    last.close > resistance &&
    last.close > last.open;

  const bullishStructure =
    (higherHigh && higherLow) ||
    (breakout && higherLow);

  let score = 0;

  if (higherHigh) score += 30;
  if (higherLow) score += 30;
  if (breakout) score += 40;

  return {
    higherHigh,
    higherLow,
    breakout,
    bullishStructure,
    resistance,
    score,
  };
}

// ========================
// TIMEFRAME ANALYSIS
// ========================

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 30) {
    return null;
  }

  const closes = candles.map((c) => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  if (ema9.length < 3 || ema21.length < 3) {
    return null;
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const currentEma9 = ema9.at(-1);
  const currentEma21 = ema21.at(-1);
  const previousEma21 = ema21.at(-2);

  return {
    price: last.close,

    ema9: currentEma9,
    ema21: currentEma21,

    emaBullish:
      last.close > currentEma9 &&
      currentEma9 > currentEma21,

    emaSlope: currentEma21 > previousEma21,

    structure: analyzeStructure(candles),

    volumeRatio: getVolumeRatio(candles),

    strength: getCandleStrength(last),

    returns: {
      return1: pctChange(
        last.close,
        previous.close
      ),

      return4: pctChange(
        last.close,
        candles[candles.length - 5].close
      ),

      return16: pctChange(
        last.close,
        candles[candles.length - 17].close
      ),
    },
  };
}

// ========================
// DAILY ANALYSIS
// ========================

function analyzeDaily(
  candles,
  currentCandle,
  livePrice
) {
  if (!candles || candles.length < 30) {
    return null;
  }

  const base = analyzeTimeframe(candles);

  if (!base) return null;

  const closes = candles.map((c) => c.close);

  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  const last = candles.at(-1);

  const previous5 = candles.slice(-6, -1);
  const previous10 = candles.slice(-11, -1);

  const avg5Volume = average(
    previous5.map(getCandleValue)
  );

  const avg10Volume = average(
    previous10.map(getCandleValue)
  );

  const dailyVolume = getCandleValue(last);

  const volumeRatio5 =
    avg5Volume > 0
      ? dailyVolume / avg5Volume
      : 0;

  const volumeRatio10 =
    avg10Volume > 0
      ? dailyVolume / avg10Volume
      : 0;

  const previous20 = candles.slice(-21, -1);
  const previous50 = candles.slice(-51, -1);

  const resistance20 = previous20.length
    ? Math.max(...previous20.map((c) => c.high))
    : 0;

  const resistance50 = previous50.length
    ? Math.max(...previous50.map((c) => c.high))
    : 0;

  const price = number(livePrice, last.close);

  const currentOpen = number(
    currentCandle?.open,
    last.close
  );

  const currentHigh = number(
    currentCandle?.high,
    price
  );

  const currentLow = number(
    currentCandle?.low,
    price
  );

  const currentRange = currentHigh - currentLow;

  const currentCloseLocation =
    currentRange > 0
      ? clamp(
          (price - currentLow) / currentRange,
          0,
          1
        )
      : 0.5;

  const dailyReturn = pctChange(
    price,
    last.close
  );

  const dailyOpenReturn = currentCandle
    ? pctChange(price, currentOpen)
    : 0;

  const ema9Value = ema9.at(-1);
  const ema21Value = ema21.at(-1);

  const ema50Value = ema50.length
    ? ema50.at(-1)
    : 0;

  const emaBullish =
    price > ema9Value &&
    ema9Value > ema21Value;

  const ema50Bullish =
    ema50Value > 0 &&
    price > ema50Value;

  const emaSlope =
    ema21.at(-1) > ema21.at(-2);

  const breakout20 =
    resistance20 > 0 &&
    price > resistance20;

  const breakout50 =
    resistance50 > 0 &&
    price > resistance50;

  const nowSeconds = Math.floor(
    Date.now() / 1000
  );

  const dayBucket =
    Math.floor(nowSeconds / 86400) * 86400;

  const elapsedSeconds = clamp(
    nowSeconds -
      number(currentCandle?.bucketTime, dayBucket),
    300,
    86400
  );

  const dayProgress = clamp(
    elapsedSeconds / 86400,
    0.05,
    1
  );

  const currentTurnover = number(
    currentCandle?.turnover
  );

  const projectedVolumeRatio =
    currentTurnover > 0 && avg10Volume > 0
      ? (currentTurnover / dayProgress) / avg10Volume
      : 0;

  let score = 50;

  if (emaBullish) score += 10;
  if (ema50Bullish) score += 6;
  if (emaSlope) score += 5;

  if (base.structure.higherHigh) score += 6;
  if (base.structure.higherLow) score += 7;

  if (breakout20) score += 12;
  if (breakout50) score += 8;

  if (volumeRatio5 >= 1.5) score += 8;
  else if (volumeRatio5 >= 1.15) score += 4;

  if (volumeRatio10 >= 1.5) score += 6;
  else if (volumeRatio10 >= 1.15) score += 3;

  if (projectedVolumeRatio >= 2) score += 8;
  else if (projectedVolumeRatio >= 1.3) score += 4;

  if (
    currentCandle &&
    dailyOpenReturn > 0 &&
    currentCloseLocation >= 0.7
  ) {
    score += 5;
  }

  if (dailyReturn < -5) score -= 8;

  return {
    score: Math.round(clamp(score, 0, 100)),

    price,
    dailyReturn,
    dailyOpenReturn,

    emaBullish,
    ema50Bullish,
    emaSlope,

    higherHigh: base.structure.higherHigh,
    higherLow: base.structure.higherLow,

    breakout20,
    breakout50,

    volumeRatio5,
    volumeRatio10,
    projectedVolumeRatio,

    currentCandle: Boolean(currentCandle),
  };
}

function emptyDailyAnalysis(price = 0) {
  return {
    score: 50,
    price,
    dailyReturn: 0,
    dailyOpenReturn: 0,

    emaBullish: false,
    ema50Bullish: false,
    emaSlope: false,

    higherHigh: false,
    higherLow: false,

    breakout20: false,
    breakout50: false,

    volumeRatio5: 0,
    volumeRatio10: 0,
    projectedVolumeRatio: 0,

    currentCandle: false,
  };
}

// ========================
// EARLY BULLISH SCORING
// ========================

// Existing base-score logic and admission thresholds are retained.

function analyzeCoin(data) {
  const {
    symbol,
    candles,
    dailyCurrent,
    livePrice,
  } = data;

  const tf15 = analyzeTimeframe(candles['15m']);
  const tf1h = analyzeTimeframe(candles['1h']);
  const tf4h = analyzeTimeframe(candles['4h']);

  const daily =
    analyzeDaily(
      candles['1d'],
      dailyCurrent,
      livePrice
    ) || emptyDailyAnalysis(livePrice);

  if (!tf15 || !tf1h || !tf4h) return null;

  let score = 0;

  const evidence = [];
  const warnings = [];

  if (tf1h.structure.higherHigh) {
    score += 10;
    evidence.push('سقف بالاتر 1H');
  }

  if (tf1h.structure.higherLow) {
    score += 12;
    evidence.push('کف بالاتر 1H');
  }

  if (tf1h.structure.breakout) {
    score += 12;
    evidence.push('شکست سقف اخیر 1H');
  }

  if (tf15.structure.higherLow) {
    score += 7;
    evidence.push('کف بالاتر 15M');
  }

  if (tf15.structure.breakout) {
    score += 8;
    evidence.push('شکست کوتاه‌مدت 15M');
  }

  if (
    tf15.strength.bullish &&
    tf15.strength.closeLocation >= 0.75
  ) {
    score += 5;
    evidence.push('بسته‌شدن قدرتمند کندل 15M');
  }

  if (tf4h.emaBullish) {
    score += 7;
    evidence.push('وضعیت مثبت EMA در 4H');
  }

  if (tf4h.structure.higherLow) {
    score += 5;
    evidence.push('حفظ کف بالاتر 4H');
  }

  if (tf1h.emaBullish) {
    score += 7;
    evidence.push('EMA صعودی 1H');
  }

  if (tf1h.emaSlope) {
    score += 4;
    evidence.push('شیب مثبت EMA 1H');
  }

  if (tf15.emaBullish) {
    score += 4;
    evidence.push('EMA صعودی 15M');
  }

  if (tf1h.volumeRatio >= 1.5) {
    score += 7;
    evidence.push(
      `افزایش حجم 1H (${tf1h.volumeRatio.toFixed(2)}x)`
    );
  } else if (tf1h.volumeRatio >= 1.15) {
    score += 4;
    evidence.push(
      `بهبود حجم 1H (${tf1h.volumeRatio.toFixed(2)}x)`
    );
  }

  if (tf15.volumeRatio >= 1.5) {
    score += 5;
    evidence.push(
      `افزایش حجم 15M (${tf15.volumeRatio.toFixed(2)}x)`
    );
  } else if (tf15.volumeRatio >= 1.15) {
    score += 3;
  }

  if (
    tf1h.strength.bullish &&
    tf1h.strength.closeLocation >= 0.70
  ) {
    score += 5;
    evidence.push('قدرت خریداران در کندل 1H');
  }

  const return15m = tf15.returns.return1;
  const return1h = tf15.returns.return4;
  const return4h = tf1h.returns.return4;

  if (return15m > CONFIG.MAX_RETURN_15M) {
    score -= 12;
    warnings.push('رشد بیش از حد 15M');
  }

  if (return1h > CONFIG.MAX_RETURN_1H) {
    score -= 15;
    warnings.push('رشد بیش از حد 1H');
  }

  if (return4h > CONFIG.MAX_RETURN_4H) {
    score -= 18;
    warnings.push('رشد بیش از حد 4H');
  }

  const hasStructure =
    tf1h.structure.higherLow ||
    tf1h.structure.breakout ||
    tf1h.structure.higherHigh;

  if (!hasStructure) {
    score -= 15;
    warnings.push('ساختار صعودی تأیید نشده');
  }

  if (
    tf1h.volumeRatio < 0.8 &&
    tf15.volumeRatio < 0.8
  ) {
    score -= 10;
    warnings.push('حجم معاملات ضعیف');
  }

  const shortTermPositive =
    tf15.emaBullish ||
    tf15.structure.breakout ||
    tf15.structure.higherLow;

  const hourlyPositive =
    tf1h.emaBullish ||
    tf1h.structure.breakout ||
    tf1h.structure.higherLow;

  if (!shortTermPositive || !hourlyPositive) {
    return null;
  }

  score = Math.round(clamp(score, 0, 100));

  if (score < CONFIG.MIN_SCORE) return null;

  let stage = 'شروع روند صعودی';

  if (
    tf1h.structure.breakout &&
    tf15.structure.breakout
  ) {
    stage = 'شکست اولیه و تأیید صعود';
  } else if (
    tf1h.structure.higherLow &&
    tf15.structure.higherLow
  ) {
    stage = 'تشکیل ساختار صعودی';
  } else if (tf15.structure.breakout) {
    stage = 'اولین نشانه‌های حرکت';
  }

  if (daily.breakout20) {
    evidence.push('شکست مقاومت روزانه 20D');
  }

  if (daily.breakout50) {
    evidence.push('عبور از سقف 50 روزه');
  }

  if (daily.volumeRatio5 >= 1.5) {
    evidence.push(
      `حجم روزانه قوی (${daily.volumeRatio5.toFixed(2)}x)`
    );
  }

  if (daily.projectedVolumeRatio >= 1.5) {
    evidence.push(
      `شتاب حجم روز جاری (${daily.projectedVolumeRatio.toFixed(2)}x)`
    );
  }

  return {
    symbol,
    score,
    stage,

    price: tf1h.price,

    returns: {
      '15m': return15m,
      '1h': return1h,
      '4h': return4h,
      '1d': daily.dailyReturn,
    },

    volume: {
      '15m': tf15.volumeRatio,
      '1h': tf1h.volumeRatio,
      '1d': daily.volumeRatio5,
    },

    daily,

    evidence,
    warnings,

    _analysis: {
      tf15: {
        ema21: tf15.ema21,
        emaBullish: tf15.emaBullish,
        structure: tf15.structure,
      },

      tf1h: {
        emaBullish: tf1h.emaBullish,
        structure: tf1h.structure,
      },

      tf4h: {
        emaBullish: tf4h.emaBullish,
        emaSlope: tf4h.emaSlope,
        structure: tf4h.structure,
      },
    },
  };
}

// ========================
// ATR
// ========================

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    return 0;
  }

  const ranges = [];

  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose)
      )
    );
  }

  return average(ranges);
}

// ========================
// OPPORTUNITY CLASSIFICATION
// ========================

function classifyOpportunity(coin) {
  const a = coin._analysis;
  const daily = coin.daily || {};

  const dailyStrong =
    number(daily.score) >= 68 ||
    daily.breakout20 ||
    daily.breakout50;

  const fourHourStrong =
    a.tf4h.emaBullish ||
    a.tf4h.structure.higherLow ||
    a.tf4h.structure.breakout;

  if (dailyStrong && fourHourStrong) {
    return 'SWING';
  }

  if (
    fourHourStrong ||
    (
      a.tf1h.emaBullish &&
      a.tf1h.structure.higherLow
    )
  ) {
    return 'SHORT-TERM';
  }

  return 'SCALP';
}

// ========================
// TRADE SETUP
// ========================

function buildTradeSetup(coin, candles15m) {
  const price = number(
    coin.livePrice,
    coin.price
  );

  const atr = calculateATR(candles15m, 14);

  if (!price || !atr) return null;

  const ema21 = number(
    coin._analysis?.tf15?.ema21
  );

  const swingPoints = findSwingPoints(
    candles15m.slice(-60),
    2
  );

  const validSupports = [
    ema21,
    ...swingPoints.lows,
  ]
    .filter(
      (level) =>
        level > 0 &&
        level < price &&
        price - level <= atr * 3.5
    )
    .sort((a, b) => b - a);

  const support =
    validSupports[0] ||
    Math.max(0, price - atr * 1.25);

  const entryLow = support - atr * 0.25;
  const entryHigh = support + atr * 0.18;

  const structuralLow = swingPoints.lows
    .filter((level) => level < entryLow)
    .sort((a, b) => b - a)[0];

  const stopLoss = Math.min(
    entryLow - atr * 0.35,
    (structuralLow || entryLow) - atr * 0.25
  );

  const risk = Math.max(
    entryHigh - stopLoss,
    atr * 0.5
  );

  const resistanceLevels = swingPoints.highs
    .filter((level) => level > entryHigh)
    .sort((a, b) => a - b);

  const target = (multiple, index) =>
    resistanceLevels[index] &&
    resistanceLevels[index] > entryHigh + risk * 0.8
      ? Math.max(
          resistanceLevels[index],
          entryHigh + risk * multiple
        )
      : entryHigh + risk * multiple;

  const tp1 = target(1.5, 0);
  const tp2 = target(2.5, 1);
  const tp3 = target(4, 2);

  const last5m = coin._candles5m?.at(-1);
  const previous5m = coin._candles5m?.at(-2);

  const strength5m = last5m
    ? getCandleStrength(last5m)
    : null;

  const bouncedFromZone = Boolean(
    last5m &&
    last5m.low <= entryHigh &&
    last5m.close > entryHigh &&
    last5m.close > last5m.open &&
    strength5m.closeLocation >= 0.65 &&
    previous5m &&
    last5m.close > previous5m.high
  );

  return {
    entryLow,
    entryHigh,
    entryMid: (entryLow + entryHigh) / 2,

    confirmation:
      'کندل بسته‌شده ۵ دقیقه‌ای باید محدوده ورود را لمس کند، صعودی بسته شود و سقف کندل قبلی را بشکند.',

    confirmationMet: bouncedFromZone,

    stopLoss,

    tp1,
    tp2,
    tp3,

    riskReward: Number(
      ((tp1 - entryHigh) / risk).toFixed(2)
    ),

    atr,
    support,
  };
}

// ========================
// SETUP IDENTITY
// ========================

function isSameSetup(
  previous,
  setup,
  opportunityType
) {
  if (
    !previous?.setup ||
    !setup ||
    previous.opportunityType !== opportunityType
  ) {
    return false;
  }

  const oldMid = number(
    previous.setup.entryMid
  );

  const newMid = number(
    setup.entryMid
  );

  if (!oldMid || !newMid) return false;

  return (
    Math.abs(newMid - oldMid) / oldMid <= 0.012
  );
}

// ========================
// TRADE STATE LIFECYCLE
// ========================

function updateTradeState(
  coin,
  setup,
  previousState,
  nowMs
) {
  const opportunityType = coin.opportunityType;

  const sameSetup = isSameSetup(
    previousState,
    setup,
    opportunityType
  );

  const previous = sameSetup
    ? previousState
    : null;

  const price = number(
    coin.livePrice,
    coin.price
  );

  const now = new Date(nowMs).toISOString();

  const statusLabels = {
    ENTRY_CONFIRMED: 'ورود تأیید شده',
    NEAR_ENTRY: 'نزدیک ورود',
    WAITING: 'در انتظار',
    NEAR_EXIT: 'نزدیک خروج',
    EXIT_CONFIRMED: 'خروج قطعی',
    INVALIDATED: 'ابطال موقعیت',
    EXPIRED: 'منقضی شده',
  };

  if (!setup) {
    return {
      symbol: coin.symbol,
      opportunityType,
      status: 'WAITING',
      statusLabel: statusLabels.WAITING,
      setup: null,
      updatedAt: now,
    };
  }

  const terminal = new Set([
    'EXIT_CONFIRMED',
    'INVALIDATED',
    'EXPIRED',
  ]);

  const maxAgeHours =
    CONFIG.SETUP_MAX_AGE_HOURS[opportunityType] || 72;

  const createdAt = previous?.createdAt || now;

  const ageHours =
    (nowMs - Date.parse(createdAt)) / 3600000;

  const oldStatus = previous?.status;

  let status = previous?.status || 'WAITING';

  let enteredAt = previous?.enteredAt || null;

  let entryPrice =
    number(previous?.entryPrice, 0) || null;

  let exitReason = previous?.exitReason || null;

  if (previous && terminal.has(oldStatus)) {
    status = oldStatus;
  } else if (ageHours > maxAgeHours) {
    status = 'EXPIRED';
    exitReason = 'عمر setup از محدوده مجاز گذشت';
  } else if (
    price <= setup.stopLoss &&
    (
      oldStatus === 'ENTRY_CONFIRMED' ||
      oldStatus === 'NEAR_EXIT'
    )
  ) {
    status = 'EXIT_CONFIRMED';
    exitReason = 'حد ضرر معامله فعال لمس شد';
  } else if (price <= setup.stopLoss) {
    status = 'INVALIDATED';
    exitReason = 'شکست حد ضرر ساختاری پیش از ورود';
  } else if (
    oldStatus === 'ENTRY_CONFIRMED' ||
    oldStatus === 'NEAR_EXIT'
  ) {
    const nearTarget = price >= setup.tp1 * 0.985;

    const nearStop =
      price <= setup.stopLoss + setup.atr * 0.25;

    if (price >= setup.tp1) {
      status = 'EXIT_CONFIRMED';
      exitReason = 'هدف اول لمس شد';
    } else if (nearTarget || nearStop) {
      status = 'NEAR_EXIT';

      exitReason = nearTarget
        ? 'قیمت به هدف اول نزدیک شده'
        : 'قیمت به حد ضرر نزدیک شده';
    } else {
      status = 'ENTRY_CONFIRMED';
      exitReason = null;
    }
  } else if (
    setup.confirmationMet &&
    price > setup.entryHigh
  ) {
    status = 'ENTRY_CONFIRMED';
    enteredAt = now;
    entryPrice = price;
  } else if (
    price >=
      setup.entryLow -
        setup.atr * CONFIG.NEAR_ENTRY_ATR &&
    price <=
      setup.entryHigh +
        setup.atr * CONFIG.NEAR_ENTRY_ATR
  ) {
    status = 'NEAR_ENTRY';
  } else {
    status = 'WAITING';
  }

  return {
    symbol: coin.symbol,
    opportunityType,

    status,
    statusLabel: statusLabels[status] || status,

    setup,

    createdAt,
    updatedAt: now,

    enteredAt,
    entryPrice,

    exitReason,

    ageHours: Number(
      Math.max(0, ageHours).toFixed(1)
    ),
  };
}

// ========================
// ATTACH TRADE LIFECYCLE
// ========================

function attachTradeLifecycle(
  coin,
  candles15m,
  candles5m,
  previousStates,
  nowMs
) {
  coin.opportunityType = classifyOpportunity(coin);

  coin._candles5m = candles5m;

  const setup = buildTradeSetup(
    coin,
    candles15m
  );

  const tradeState = updateTradeState(
    coin,
    setup,
    previousStates[coin.symbol],
    nowMs
  );

  coin.tradeStatus = tradeState.status;
  coin.tradeStatusLabel = tradeState.statusLabel;
  coin.tradeSetup = tradeState.setup;
  coin.tradeState = tradeState;

  delete coin._candles5m;
  delete coin._analysis;

  return coin;
}

// ========================
// TELEGRAM
// ========================

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
        'Content-Type': 'application/json',
      },

      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),

      signal: AbortSignal.timeout(15000),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    const error = new Error(
      result.description ||
        `Telegram HTTP ${response.status}`
    );

    error.retryAfter =
      result.parameters?.retry_after;

    throw error;
  }
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text
    .split('\n\n')
    .filter(Boolean);

  const messages = [];

  let current = '';

  for (const block of blocks) {
    const candidate = current
      ? `${current}\n\n${block}`
      : block;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      messages.push(current);
      current = '';
    }

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    for (const line of block.split('\n')) {
      const next = current
        ? `${current}\n${line}`
        : line;

      if (next.length > maxLength && current) {
        messages.push(current);
        current = line;
      } else {
        current = next;
      }
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
      `📄 گزارش ${i + 1}/${messages.length}\n\n${messages[i]}`;

    try {
      await sendTelegram(payload);
    } catch (error) {
      if (!error.retryAfter) throw error;

      await sleep(
        error.retryAfter * 1000 + 500
      );

      await sendTelegram(payload);
    }

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_DELAY);
    }
  }
}

// ========================
// REPORT GROUPS
// ========================

const GROUPS = [
  {
    key: 'SWING',
    title: '🟣 فرصت‌های حرکت بزرگ (SWING)',
  },
  {
    key: 'SHORT-TERM',
    title: '🔵 فرصت‌های کوتاه‌مدت (SHORT-TERM)',
  },
  {
    key: 'SCALP',
    title: '🟡 فرصت‌های لحظه‌ای (SCALP)',
  },
];

// ========================
// BUILD REPORT
// ========================

    

function buildReport(
  candidates,
  stats,
  duration,
  rankChanges = null
) {
  // حفظ گروه‌بندی و ترتیب رتبه‌بندی فعلی
  const selected = GROUPS.flatMap((group) =>
    candidates
      .filter(
        (coin) => coin.opportunityType === group.key
      )
      .slice(0, CONFIG.TOP_COUNT)
  );

  const blocks = [[
    '🚀 GATE.IO | BULLISH RADAR',
    '━━━━━━━━━━━━━━━━━━',
    '🟢↑ بهبود رتبه | 🔴↓ افت رتبه | ➖ ثابت | 🆕 جدید',
    '✅ تأیید واقعی ورود 5M | 🟡 نزدیک ورود | ⏳ انتظار تأیید',
    `📌 کاندید: ${selected.length}/${candidates.length} | قرارداد: ${stats.active} | نقدشونده: ${stats.liquid}`,
    `🔍 موفق: ${stats.success} | خطا: ${stats.errors} | ⏱ ${(duration / 1000).toFixed(1)} ثانیه`,
    '━━━━━━━━━━━━━━━━━━',
  ].join('\n')];

  if (!selected.length) {
    blocks.push(
      '❌ در این اسکن ارزی شرایط لازم را نداشت.'
    );
  }

  let printed = 0;

  for (const group of GROUPS) {
    const coins = selected.filter(
      (coin) => coin.opportunityType === group.key
    );

    blocks.push(
      `${group.title}\nتعداد: ${coins.length}\n━━━━━━━━━━━━━━━━━━`
    );

    if (!coins.length) {
      blocks.push('— موردی در این گروه نیست.');
      continue;
    }

    const coinBlocks = [];

    for (const coin of coins) {
      printed++;

      const movement = rankChanges?.[coin.symbol];

      let rankText = '▫️';

      if (movement?.status === 'NEW') {
        rankText = '🆕';
      } else if (movement?.status === 'UP') {
        rankText = `🟢↑${movement.change}`;
      } else if (movement?.status === 'DOWN') {
        rankText = `🔴↓${Math.abs(movement.change)}`;
      } else if (movement?.status === 'SAME') {
        rankText = '➖';
      }

      const setup = coin.tradeSetup;

      // فقط تأیید واقعی کندل بسته‌شده 5 دقیقه‌ای
      const entryConfirmed =
        setup?.confirmationMet === true;

      let entryMark = '⏳';
      let statusText = 'در انتظار تأیید 5M';

      if (entryConfirmed) {
        entryMark = '✅';
        statusText = '';
      } else if (coin.tradeStatus === 'NEAR_ENTRY') {
        entryMark = '🟡';
        statusText = 'نزدیک ورود';
      } else if (
        [
          'INVALIDATED',
          'EXPIRED',
          'EXIT_CONFIRMED',
          'NEAR_EXIT',
        ].includes(coin.tradeStatus)
      ) {
        entryMark = '⚠️';
        statusText =
          coin.tradeStatusLabel || 'وضعیت غیرورودی';
      }

      const firstLine =
        `${printed}. ${coin.symbol} ${rankText} ${entryMark} | پایه ${coin.score} | رتبه ${coin.rankScore ?? '-'}`;

      const lines = [firstLine];

      // ورود تأییدشده فقط تیک دارد و متن اضافه نمی‌گیرد
      if (statusText) {
        lines.push(`   ${statusText}`);
      }

      coinBlocks.push(lines.join('\n'));
    }

    // جداکننده بین ارزها؛ بدون جابه‌جایی یا حذف از گروه
    blocks.push(
      coinBlocks.join('\n────────────○○○○──')
    );
  }

  blocks.push(
    '━━━━━━━━━━━━━━━━━━\nℹ️ ورود فقط با تأیید واقعی کندل بسته‌شده ۵ دقیقه‌ای معتبر است. این سیگنال‌ها تضمین سود نیستند.'
  );

  return blocks.join('\n\n');
}

      

      

// ========================
// MAIN SCANNER
// ========================

async function main() {
  const startedAt = Date.now();
  const nowMs = Date.now();

  console.log(
    '\n🚀 GATE.IO FOUR TIMEFRAME BULLISH RADAR'
  );

  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  );

  console.log(
    '🎯 Target: Early detection of strong bullish moves'
  );

  console.log(
    '⏱ Timeframes: 5m confirmation / 15m / 1h / 4h / 1d'
  );

  console.log(
    '📈 Ranking: Base + Multi-Timeframe Momentum + Persistence'
  );

  const [
    contracts,
    tickers,
    previousTradeStates,
  ] = await Promise.all([
    getContracts(),
    getTickers(),
    getTradeStates(),
  ]);

  if (
    !Array.isArray(contracts) ||
    !Array.isArray(tickers)
  ) {
    throw new Error(
      'داده قراردادها یا تیکرهای Gate.io معتبر نیست.'
    );
  }

  const tickerMap = new Map(
    tickers.map((ticker) => [
      ticker.contract,
      ticker,
    ])
  );

  const activeContracts = contracts.filter(
    (contract) =>
      contract?.name &&
      contract.in_delisting !== true &&
      tickerMap.has(contract.name)
  );

  const liquidMarkets = activeContracts
    .map((contract) => {
      const ticker = tickerMap.get(contract.name);

      return {
        symbol: contract.name,
        ticker,

        quoteVolume: number(
          ticker.volume_24h_quote
        ),

        lastPrice: number(ticker.last),
      };
    })
    .filter(
      (market) =>
        market.lastPrice > 0 &&
        market.quoteVolume >=
          CONFIG.MIN_QUOTE_VOLUME_24H
    )
    .sort(
      (a, b) =>
        b.quoteVolume - a.quoteVolume
    );

  console.log(
    `📊 Active contracts: ${activeContracts.length}`
  );

  console.log(
    `💧 Liquid contracts: ${liquidMarkets.length}`
  );

  console.log(
    '🔍 Scanning all liquid contracts...\n'
  );

  let success = 0;
  let errors = 0;

  const analyzed = await mapLimit(
    liquidMarkets,
    CONFIG.CONCURRENCY,
    async (market) => {
      const [
        candles5mData,
        candles15mData,
        candles1h,
        candles4h,
        candles1dData,
      ] = await Promise.all([
        getCandles(
          market.symbol,
          '5m',
          CONFIG.TIMEFRAMES['5m'].limit,
          true
        ),

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
        ),

        getCandles(
          market.symbol,
          '1d',
          CONFIG.TIMEFRAMES['1d'].limit,
          true
        ),
      ]);

      const candles5m = candles5mData.closed;
      const candles15m = candles15mData.closed;
      const candles1d = candles1dData.closed;

      if (
        candles5m.length < 30 ||
        candles15m.length < 30 ||
        candles1h.length < 30 ||
        candles4h.length < 30
      ) {
        throw new Error(
          'کندل کافی برای تحلیل تایم‌فریم‌ها دریافت نشد.'
        );
      }

      success++;

      const candidate = analyzeCoin({
        symbol: market.symbol,

        candles: {
          '15m': candles15m,
          '1h': candles1h,
          '4h': candles4h,
          '1d': candles1d,
        },

        dailyCurrent: candles1dData.current,
        livePrice: market.lastPrice,
      });

      if (!candidate) return null;

      candidate.livePrice = market.lastPrice;

      candidate.live15m = candles15mData.current;
      candidate.live1d = candles1dData.current;

      candidate.opportunityType =
        classifyOpportunity(candidate);

      candidate._candles5m = candles5m;

      const setup = buildTradeSetup(
        candidate,
        candles15m
      );

      const tradeState = updateTradeState(
        candidate,
        setup,
        previousTradeStates[market.symbol],
        nowMs
      );

      candidate.tradeStatus = tradeState.status;
      candidate.tradeStatusLabel =
        tradeState.statusLabel;

      candidate.tradeSetup = tradeState.setup;
      candidate.tradeState = tradeState;

      delete candidate._analysis;
      delete candidate._candles5m;

      return candidate;
    }
  );

  const candidates = [];

  for (const result of analyzed) {
    if (result?.error) {
      errors++;
      continue;
    }

    if (result) {
      candidates.push(result);
    }
  }

  // ========================
  // TRADE STATE STORAGE
  // ========================

  const updatedTradeStates = {
    ...previousTradeStates,
  };

  for (const coin of candidates) {
    updatedTradeStates[coin.symbol] =
      coin.tradeState;
  }

  // ========================
  // MARKET DATA STORAGE
  // ========================

  let rankChanges = null;
  let rankedCandidates = candidates;

  try {
    const storageResult = await saveMarketSnapshot(
      candidates,
      {
        tradeStates: updatedTradeStates,
      }
    );

    rankChanges = storageResult.rankChanges;

    rankedCandidates =
      storageResult.rankedCandidates;

    console.log('\n💾 MARKET DATA SAVED');

    console.log(
      `Snapshots: ${storageResult.snapshotsSaved}`
    );

    console.log(
      `History records: ${storageResult.historyCount}`
    );

    console.log(
      `Coin summaries: ${storageResult.summaryCount}`
    );

    console.log(
      `Trade states: ${storageResult.tradeStateCount}`
    );

    console.log(
      '📊 Four-timeframe ranking + opportunity/status ordering calculated.'
    );
  } catch (storageError) {
    console.error(
      '⚠️ MARKET STORAGE FAILED:',
      storageError
    );

    rankedCandidates = [...candidates].sort(
      (a, b) => {
        const groups = {
          SWING: 0,
          'SHORT-TERM': 1,
          SCALP: 2,
        };

        const statuses = {
          ENTRY_CONFIRMED: 0,
          NEAR_ENTRY: 1,
          WAITING: 2,
          NEAR_EXIT: 3,
          EXIT_CONFIRMED: 4,
          INVALIDATED: 5,
          EXPIRED: 6,
        };

        return (
          (groups[a.opportunityType] ?? 9) -
            (groups[b.opportunityType] ?? 9) ||

          (statuses[a.tradeStatus] ?? 9) -
            (statuses[b.tradeStatus] ?? 9) ||

          number(b.rankScore) -
            number(a.rankScore) ||

          b.score - a.score
        );
      }
    );
  }

  // ========================
  // CONSOLE REPORT
  // ========================

  const duration = Date.now() - startedAt;

  const stats = {
    active: activeContracts.length,
    liquid: liquidMarkets.length,
    success,
    errors,
  };

  console.log(
    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  );

  console.log('🏆 TOP BULLISH OPPORTUNITIES');

  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  );

  for (const group of GROUPS) {
    const groupCoins = rankedCandidates.filter(
      (coin) =>
        coin.opportunityType === group.key
    );

    console.log(
      `\n${group.title} (${groupCoins.length})`
    );

    groupCoins
      .slice(0, CONFIG.TOP_COUNT)
      .forEach((coin, index) => {
        console.log(
          `${index + 1}. ${coin.symbol} | ${coin.tradeStatusLabel} | Base: ${coin.score} | Rank: ${coin.rankScore ?? '-'} | ${coin.stage}`
        );

        if (coin.tradeSetup) {
          console.log(
            `   Entry ${formatPrice(coin.tradeSetup.entryLow)}-${formatPrice(coin.tradeSetup.entryHigh)} | SL ${formatPrice(coin.tradeSetup.stopLoss)} | TP1 ${formatPrice(coin.tradeSetup.tp1)} | RR ${coin.tradeSetup.riskReward}R`
          );
        }
      });
  }

  console.log(
    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  );

  console.log(
    `Candidates: ${rankedCandidates.length}`
  );

  console.log(
    `Successful analyses: ${success}`
  );

  console.log(
    `Errors: ${errors}`
  );

  console.log(
    `Duration: ${(duration / 1000).toFixed(1)}s`
  );

  console.log(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
  );

  // ========================
  // TELEGRAM REPORT
  // ========================

  const report = buildReport(
    rankedCandidates,
    stats,
    duration,
    rankChanges
  );

  await sendReports(report);

  console.log(
    '✅ Telegram report sent successfully.'
  );
}

main().catch((error) => {
  console.error(
    '\n❌ SCANNER FAILED:',
    error
  );

  process.exitCode = 1;
});
