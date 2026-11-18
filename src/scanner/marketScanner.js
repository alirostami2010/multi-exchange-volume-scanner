/**
 * GATE.IO USDT PERPETUAL — ACCUMULATION & PRE-PUMP RADAR
 * Node.js 20+
 *
 * هدف:
 * 1) شناسایی افت قبلی و تشکیل Base
 * 2) سنجش احتمالی جذب عرضه و فرسودگی فروشندگان
 * 3) سنجش فشردگی نوسان و ساختار کف‌ها
 * 4) تأیید چندتایم‌فریمی 1H و 15M
 * 5) رتبه‌بندی تمام کاندیدهای واجد شرایط
 * 6) ارسال فقط 20 کاندید برتر به تلگرام
 *
 * نکته:
 * OHLCV به‌تنهایی جریان واقعی سفارشات خرید/فروش را نشان نمی‌دهد.
 * Absorption در این فایل یک تخمین آماری است، نه اثبات ورود پول هوشمند.
 */

const CONFIG = {
  API_BASE: "https://api.gateio.ws/api/v4",
  SETTLE: "usdt",

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  MAX_TELEGRAM_COINS: 20,
  MAX_PER_MESSAGE: 10,

  // فیلتر اولیه بازار
  MIN_24H_TURNOVER: 200000,
  MIN_LAST_PRICE: 0.0000001,

  // داده‌های تایم‌فریم اصلی
  MAIN_INTERVAL: "4h",
  MAIN_LIMIT: 180,

  // محدوده انباشت: 18 تا 36 کندل 4 ساعته
  BASE_WINDOWS: [18, 24, 30, 36],

  // حداکثر محدوده بررسی افت قبلی
  DECLINE_LOOKBACK: 72,
  MIN_DECLINE_PCT: 8,
  MAX_DECLINE_PCT: 70,

  // کیفیت محدوده
  MIN_BASE_WIDTH_PCT: 1,
  MAX_BASE_WIDTH_PCT: 20,
  MAX_BASE_AGE_HOURS: 168,

  // محدودیت فاصله قیمت فعلی تا محدوده
  MAX_DISTANCE_ABOVE_BASE_PCT: 12,
  MAX_BREAKOUT_EXTENSION_PCT: 5,

  // حداقل امتیازها
  MIN_ACCUMULATION_SCORE: 35,
  MIN_ABSORPTION_SCORE: 25,
  MIN_FINAL_SCORE: 52,

  // بررسی عمیق فقط برای کاندیدهای اولیه
  DEEP_SCAN_LIMIT: 120,
  H1_LIMIT: 120,
  M15_LIMIT: 96,

  // نقدشوندگی
  MIN_BASE_TURNOVER: 10000,

  // هم‌زمانی و درخواست‌ها
  CONCURRENCY: 5,
  DEEP_CONCURRENCY: 4,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,
  RETRY_DELAY_MS: 700,

  // امتیاز نهایی
  WEIGHTS: {
    accumulation: 0.38,
    absorption: 0.27,
    prePump: 0.25,
    market: 0.10
  },

  TELEGRAM_RETRY_LIMIT: 4
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const avg = values => {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
};

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pct = (a, b) => {
  if (!b) return 0;
  return ((a - b) / b) * 100;
};

const safeRatio = (a, b) => b > 0 ? a / b : 0;

function formatPrice(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);
  return value.toPrecision(6);
}

function formatMoney(value) {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function scoreLabel(score) {
  if (score >= 85) return "بسیار قوی";
  if (score >= 75) return "قوی";
  if (score >= 65) return "قابل توجه";
  if (score >= 52) return "متوسط";
  return "ضعیف";
}

function stageLabel(candidate) {
  if (candidate.prePumpScore >= 75 && candidate.breakoutConfirmed) {
    return "شروع حرکت";
  }

  if (candidate.prePumpScore >= 65) {
    return "نزدیک شروع حرکت";
  }

  if (candidate.absorptionScore >= 65 && candidate.accumulationScore >= 60) {
    return "جذب عرضه / انباشت";
  }

  if (candidate.accumulationScore >= 55) {
    return "در حال انباشت";
  }

  return "تشکیل محدوده";
}

async function fetchJson(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError;

  for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || 2;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        await sleep(CONFIG.RETRY_DELAY_MS * (attempt + 1));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("API request failed");
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;

        try {
          results[index] = await worker(items[index], index);
        } catch (error) {
          results[index] = {
            error: true,
            message: error.message
          };
        }
      }
    }
  );

  await Promise.all(workers);
  return results;
}

/* -------------------------------------------------------
   MARKET DATA
------------------------------------------------------- */

async function getContracts() {
  const data = await fetchJson(
    `/futures/${CONFIG.SETTLE}/contracts`
  );

  return data.filter(contract =>
    contract &&
    contract.type === "direct" &&
    contract.status === "trading" &&
    contract.in_delisting !== true &&
    contract.name?.endsWith("_USDT")
  );
}

async function getTickers() {
  const data = await fetchJson(
    `/futures/${CONFIG.SETTLE}/tickers`
  );

  return new Map(
    data.map(ticker => [
      ticker.contract,
      {
        last: num(ticker.last),
        turnover24h: num(ticker.volume_24h_quote),
        change24h: num(ticker.change_percentage),
        fundingRate: num(ticker.funding_rate),
        high24h: num(ticker.high_24h),
        low24h: num(ticker.low_24h),
        bid: num(ticker.highest_bid),
        ask: num(ticker.lowest_ask)
      }
    ])
  );
}

async function getCandles(contract, interval, limit) {
  const data = await fetchJson(
    `/futures/${CONFIG.SETTLE}/candlesticks`,
    {
      contract,
      interval,
      limit
    }
  );

  if (!Array.isArray(data)) return [];

  const now = Math.floor(Date.now() / 1000);
  const intervalSeconds = {
    "15m": 900,
    "1h": 3600,
    "4h": 14400
  }[interval];

  return data
    .map(c => ({
      time: num(c.t),
      open: num(c.o),
      high: num(c.h),
      low: num(c.l),
      close: num(c.c),
      volume: num(c.v),
      turnover: num(c.sum)
    }))
    .filter(c =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0 &&
      c.high >= c.low &&
      c.turnover >= 0 &&
      c.time + intervalSeconds <= now
    )
    .sort((a, b) => a.time - b.time);
}

/* -------------------------------------------------------
   BASIC CANDLE METRICS
------------------------------------------------------- */

function candleMetrics(candle) {
  const range = Math.max(candle.high - candle.low, 1e-12);
  const body = Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high - Math.max(candle.open, candle.close);

  const lowerWick =
    Math.min(candle.open, candle.close) - candle.low;

  const closePosition =
    clamp((candle.close - candle.low) / range, 0, 1);

  return {
    rangePct: (range / candle.close) * 100,
    bodyRatio: body / range,
    upperWickRatio: upperWick / range,
    lowerWickRatio: lowerWick / range,
    closePosition,
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open
  };
}

function averageRangePct(candles) {
  return avg(candles.map(c => {
    const m = candleMetrics(c);
    return m.rangePct;
  }));
}

function averageTurnover(candles) {
  return avg(candles.map(c => c.turnover));
}

function getAtrPercent(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const selected = candles.slice(-(period + 1));
  const trueRanges = [];

  for (let i = 1; i < selected.length; i++) {
    const current = selected[i];
    const previous = selected[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trueRanges.push(tr);
  }

  const atr = avg(trueRanges);
  const lastClose = selected[selected.length - 1].close;

  return lastClose > 0 ? (atr / lastClose) * 100 : 0;
}

/* -------------------------------------------------------
   PREVIOUS DECLINE
------------------------------------------------------- */

function findPreviousDecline(candles, baseStart) {
  const lookbackStart = Math.max(
    0,
    baseStart - CONFIG.DECLINE_LOOKBACK
  );

  const history = candles.slice(lookbackStart, baseStart);

  if (history.length < 12) return null;

  let best = null;

  // پیدا کردن قله و کف متوالی؛
  // قله باید قبل از کف تشکیل شده باشد.
  for (let peakIndex = 2; peakIndex < history.length - 5; peakIndex++) {
    const peak = history[peakIndex];

    const peakIsLocal =
      peak.high >= history[peakIndex - 1].high &&
      peak.high >= history[peakIndex - 2].high &&
      peak.high >= history[peakIndex + 1].high;

    if (!peakIsLocal) continue;

    const afterPeak = history.slice(peakIndex + 1);
    if (afterPeak.length < 4) continue;

    const trough = Math.min(...afterPeak.map(c => c.low));
    const declinePct = ((peak.high - trough) / peak.high) * 100;

    if (
      declinePct < CONFIG.MIN_DECLINE_PCT ||
      declinePct > CONFIG.MAX_DECLINE_PCT
    ) continue;

    const troughIndex = afterPeak.findIndex(c => c.low === trough);
    const actualTroughIndex = peakIndex + 1 + troughIndex;

    if (actualTroughIndex <= peakIndex) continue;

    const candidate = {
      peak: peak.high,
      trough,
      declinePct,
      peakTime: peak.time,
      troughTime: history[actualTroughIndex].time,
      peakIndex: lookbackStart + peakIndex,
      troughIndex: lookbackStart + actualTroughIndex
    };

    if (!best || candidate.declinePct > best.declinePct) {
      best = candidate;
    }
  }

  return best;
}

/* -------------------------------------------------------
   BASE STRUCTURE
------------------------------------------------------- */

function analyzeBase(base, currentPrice) {
  if (base.length < 18) return null;

  const highs = base.map(c => c.high);
  const lows = base.map(c => c.low);
  const closes = base.map(c => c.close);

  const zoneHigh = Math.max(...highs);
  const zoneLow = Math.min(...lows);

  if (zoneLow <= 0 || zoneHigh <= 0) return null;

  const zoneWidthPct = ((zoneHigh - zoneLow) / zoneLow) * 100;

  if (
    zoneWidthPct < CONFIG.MIN_BASE_WIDTH_PCT ||
    zoneWidthPct > CONFIG.MAX_BASE_WIDTH_PCT
  ) return null;

  const priceAboveBasePct =
    ((currentPrice - zoneHigh) / zoneHigh) * 100;

  const priceBelowBasePct =
    ((zoneLow - currentPrice) / zoneLow) * 100;

  if (priceBelowBasePct > 3) return null;

  if (
    priceAboveBasePct >
    CONFIG.MAX_DISTANCE_ABOVE_BASE_PCT
  ) return null;

  const baseTurnover = averageTurnover(base);

  if (baseTurnover < CONFIG.MIN_BASE_TURNOVER) return null;

  const last5 = base.slice(-5);
  const previous5 = base.slice(-10, -5);

  const recentTurnover = averageTurnover(last5);
  const previousTurnover = averageTurnover(previous5);

  const recentRange = averageRangePct(last5);
  const previousRange = averageRangePct(previous5);

  const atrRecent = getAtrPercent(base.slice(-20), 10);
  const atrPrevious = getAtrPercent(base.slice(-35, -15), 10);

  const closePosition = avg(
    last5.map(c => candleMetrics(c).closePosition)
  );

  // کف‌های بالاتر
  const firstThirdLow = Math.min(...lows.slice(0, Math.floor(lows.length / 3)));
  const middleThirdLow = Math.min(...lows.slice(
    Math.floor(lows.length / 3),
    Math.floor((lows.length * 2) / 3)
  ));
  const lastThirdLow = Math.min(...lows.slice(
    Math.floor((lows.length * 2) / 3)
  ));

  const higherLowStructure =
    middleThirdLow >= firstThirdLow * 0.995 &&
    lastThirdLow >= middleThirdLow * 0.995;

  // تعداد تست‌های نزدیک کف
  const floorTolerance = zoneLow * 1.025;
  const floorTests = base.filter(c => c.low <= floorTolerance).length;

  const recentFloorTests = base.slice(-10)
    .filter(c => c.low <= floorTolerance).length;

  // فشار نزولی: مقدار حرکت نزولی نسبت به گردش مالی
  const bearish = base.filter(c => c.close < c.open);
  const bearishTurnover = averageTurnover(bearish);

  const bearishProgress = bearish.length
    ? avg(bearish.map(c =>
        Math.max(0, (c.open - c.close) / c.open * 100)
      ))
    : 0;

  const downsideEfficiency =
    safeRatio(bearishProgress, bearishTurnover);

  // آیا کف در پایان محدوده حفظ شده؟
  const floorHeld =
    Math.min(...base.slice(-6).map(c => c.low)) >= zoneLow * 0.985;

  // رشد قیمت با حجم کمتر از میانگین یا افت فشار فروش
  const volumeRatio = safeRatio(recentTurnover, previousTurnover);
  const rangeRatio = safeRatio(recentRange, previousRange);

  return {
    zoneHigh,
    zoneLow,
    zoneWidthPct,
    baseTurnover,
    recentTurnover,
    previousTurnover,
    volumeRatio,
    recentRange,
    previousRange,
    rangeRatio,
    atrRecent,
    atrPrevious,
    closePosition,
    higherLowStructure,
    floorTests,
    recentFloorTests,
    downsideEfficiency,
    floorHeld,
    priceAboveBasePct,
    lastClose: closes[closes.length - 1],
    baseStartTime: base[0].time,
    baseEndTime: base[base.length - 1].time
  };
}

/* -------------------------------------------------------
   SUPPLY ABSORPTION ESTIMATION
------------------------------------------------------- */

function calculateAbsorption(base, metrics) {
  let score = 0;

  const last12 = base.slice(-12);
  const candleData = last12.map(c => ({
    candle: c,
    metrics: candleMetrics(c)
  }));

  const medianTurnover = median(
    base.slice(0, -3).map(c => c.turnover)
  );

  const highVolumeCandles = candleData.filter(item =>
    item.candle.turnover > medianTurnover * 1.5
  );

  // 1) حجم بالا با پیشروی نزولی کم
  const highVolumeNoProgress = highVolumeCandles.filter(item => {
    const m = item.metrics;
    const downMove = Math.max(
      0,
      (item.candle.open - item.candle.close) / item.candle.open
    );

    return (
      downMove < 0.012 &&
      (m.lowerWickRatio > 0.25 || m.closePosition > 0.55)
    );
  }).length;

  score += Math.min(25, highVolumeNoProgress * 8);

  // 2) برگشت از کف با سایه پایینی
  const rejectionCandles = candleData.filter(item =>
    item.metrics.lowerWickRatio >= 0.35 &&
    item.metrics.closePosition >= 0.55
  ).length;

  score += Math.min(20, rejectionCandles * 5);

  // 3) حفظ کف پس از چندین تست
  if (metrics.floorTests >= 2 && metrics.floorHeld) score += 15;
  if (metrics.floorTests >= 4 && metrics.floorHeld) score += 5;

  // 4) کاهش پیشروی نزولی
  if (metrics.downsideEfficiency > 0 &&
      metrics.downsideEfficiency < 0.000001) {
    score += 5;
  }

  // 5) کاهش فشار فروش در کندل‌های اخیر
  const early = base.slice(-12, -6);
  const late = base.slice(-6);

  const earlyBearishTurnover = early
    .filter(c => c.close < c.open)
    .reduce((sum, c) => sum + c.turnover, 0);

  const lateBearishTurnover = late
    .filter(c => c.close < c.open)
    .reduce((sum, c) => sum + c.turnover, 0);

  if (earlyBearishTurnover > 0 &&
      lateBearishTurnover < earlyBearishTurnover * 0.75) {
    score += 15;
  }

  // 6) بسته شدن کندل‌ها در نیمه بالایی
  if (metrics.closePosition >= 0.58) score += 10;

  // 7) کاهش رنج بدون از دست رفتن کف
  if (metrics.rangeRatio > 0 && metrics.rangeRatio < 0.8 &&
      metrics.floorHeld) {
    score += 10;
  }

  return clamp(score);
}

/* -------------------------------------------------------
   ACCUMULATION SCORE
------------------------------------------------------- */

function calculateAccumulation(base, metrics, decline) {
  let score = 0;

  // افت قبلی: وجود یک تخلیه قابل توجه
  if (decline.declinePct >= 12 && decline.declinePct <= 55) {
    score += 15;
  } else if (decline.declinePct > 55) {
    score += 8;
  }

  // حفظ کف
  if (metrics.floorHeld) score += 15;

  // کف‌های بالاتر
  if (metrics.higherLowStructure) score += 15;

  // محدوده نسبتاً فشرده
  if (metrics.zoneWidthPct <= 10) score += 12;
  else if (metrics.zoneWidthPct <= 15) score += 7;

  // کاهش نوسان
  if (metrics.rangeRatio > 0 && metrics.rangeRatio <= 0.75) {
    score += 12;
  } else if (metrics.rangeRatio <= 0.9) {
    score += 7;
  }

  // کاهش ATR
  if (
    metrics.atrPrevious > 0 &&
    metrics.atrRecent < metrics.atrPrevious * 0.8
  ) {
    score += 10;
  }

  // تکرار تست کف بدون شکست
  if (metrics.floorTests >= 2) score += 7;
  if (metrics.floorTests >= 4) score += 4;

  // بسته شدن قیمت در نیمه بالایی محدوده
  if (metrics.closePosition >= 0.55) score += 10;

  return clamp(score);
}

/* -------------------------------------------------------
   4H CANDIDATE DETECTOR
------------------------------------------------------- */

function analyze4h(contract, ticker, candles) {
  if (candles.length < 100) return null;

  const currentPrice = ticker.last;
  if (!currentPrice || currentPrice < CONFIG.MIN_LAST_PRICE) return null;

  const candidates = [];

  for (const windowSize of CONFIG.BASE_WINDOWS) {
    const baseStart = candles.length - windowSize;
    const base = candles.slice(baseStart);

    if (base.length !== windowSize) continue;

    const metrics = analyzeBase(base, currentPrice);
    if (!metrics) continue;

    const decline = findPreviousDecline(candles, baseStart);
    if (!decline) continue;

    const ageHours =
      (Date.now() / 1000 - metrics.baseEndTime) / 3600;

    if (ageHours > CONFIG.MAX_BASE_AGE_HOURS) continue;

    const accumulationScore =
      calculateAccumulation(base, metrics, decline);

    const absorptionScore =
      calculateAbsorption(base, metrics);

    const baseDistance = metrics.priceAboveBasePct;

    const breakoutConfirmed =
      currentPrice > metrics.zoneHigh &&
      baseDistance <= CONFIG.MAX_BREAKOUT_EXTENSION_PCT;

    const extensionPenalty =
      baseDistance > 5 ? 20 :
      baseDistance > 3 ? 10 :
      0;

    const marketScore = clamp(
      50 +
      (Math.min(ticker.turnover24h / 1_000_000, 5) * 8) -
      Math.max(0, ticker.change24h - 12) * 2
    );

    const candidate = {
      contract,
      price: currentPrice,
      turnover24h: ticker.turnover24h,
      change24h: ticker.change24h,
      fundingRate: ticker.fundingRate,

      zoneHigh: metrics.zoneHigh,
      zoneLow: metrics.zoneLow,
      zoneWidthPct: metrics.zoneWidthPct,
      baseDistancePct: baseDistance,

      declinePct: decline.declinePct,
      baseAgeHours: ageHours,
      baseCandles: windowSize,

      accumulationScore,
      absorptionScore,

      prePumpScore: 0,
      marketScore,

      breakoutConfirmed,
      metrics,
      base
    };

    candidate.initialScore =
      accumulationScore * 0.55 +
      absorptionScore * 0.35 +
      marketScore * 0.10 -
      extensionPenalty;

    if (
      candidate.accumulationScore >= CONFIG.MIN_ACCUMULATION_SCORE &&
      candidate.absorptionScore >= CONFIG.MIN_ABSORPTION_SCORE
    ) {
      candidates.push(candidate);
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => b.initialScore - a.initialScore);

  return candidates[0];
}

/* -------------------------------------------------------
   LOWER TIMEFRAME CONFIRMATION
------------------------------------------------------- */

function analyzeLowerTimeframe(candles, zoneHigh, zoneLow) {
  if (candles.length < 30) {
    return {
      score: 0,
      breakout: false,
      reclaim: false,
      relativeVolume: 0,
      compression: false
    };
  }

  const recent = candles.slice(-6);
  const previous = candles.slice(-24, -6);

  const recentVolume = averageTurnover(recent);
  const previousVolume = averageTurnover(previous);

  const relativeVolume = safeRatio(
    recentVolume,
    previousVolume
  );

  const recentClose = candles[candles.length - 1].close;
  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));

  const previousHigh = Math.max(...previous.map(c => c.high));

  const breakout =
    recentClose > previousHigh &&
    recentClose > zoneHigh;

  const reclaim =
    recentClose > zoneHigh &&
    recentLow <= zoneHigh * 1.015;

  const compression =
    averageRangePct(recent) <
    averageRangePct(previous) * 0.85;

  const recentMetrics = recent.map(c => candleMetrics(c));

  const positiveCloses = recentMetrics.filter(m =>
    m.closePosition > 0.6
  ).length;

  let score = 0;

  if (breakout) score += 30;
  if (reclaim) score += 20;
  if (relativeVolume >= 1.3) score += 15;
  if (relativeVolume >= 1.8) score += 10;
  if (compression) score += 10;
  if (positiveCloses >= 4) score += 15;

  // اگر قیمت از محدوده بیش از حد فاصله گرفته باشد،
  // تأییدیه را به‌عنوان ورود دیرهنگام جریمه می‌کنیم.
  const extensionPct =
    zoneHigh > 0 ? ((recentClose - zoneHigh) / zoneHigh) * 100 : 0;

  if (extensionPct > 5) score -= 20;
  if (extensionPct > 8) score -= 20;

  return {
    score: clamp(score),
    breakout,
    reclaim,
    relativeVolume,
    compression,
    extensionPct,
    recentClose,
    recentHigh,
    recentLow
  };
}

/* -------------------------------------------------------
   BTC MARKET CONTEXT
------------------------------------------------------- */

function analyzeBtcRegime(candles) {
  if (!candles || candles.length < 30) {
    return {
      score: 50,
      trend: "نامشخص"
    };
  }

  const recent = candles.slice(-6);
  const previous = candles.slice(-24, -6);

  const recentReturn = pct(
    recent[recent.length - 1].close,
    recent[0].open
  );

  const previousReturn = pct(
    previous[previous.length - 1].close,
    previous[0].open
  );

  let score = 50;
  let trend = "خنثی";

  if (recentReturn > 1.5) {
    score += 25;
    trend = "مثبت";
  } else if (recentReturn > 0) {
    score += 12;
    trend = "کمی مثبت";
  } else if (recentReturn < -3) {
    score -= 25;
    trend = "منفی شدید";
  } else if (recentReturn < -1) {
    score -= 15;
    trend = "منفی";
  }

  if (previousReturn < -5 && recentReturn > 0) {
    score += 8;
  }

  return {
    score: clamp(score),
    trend,
    recentReturn,
    previousReturn
  };
}

/* -------------------------------------------------------
   FINAL RANKING
------------------------------------------------------- */

function calculateFinalScore(candidate, h1, m15, btcRegime) {
  const prePumpScore = clamp(
    h1.score * 0.55 +
    m15.score * 0.45
  );

  const marketScore = clamp(
    candidate.marketScore * 0.55 +
    btcRegime.score * 0.45
  );

  const weights = CONFIG.WEIGHTS;

  let finalScore =
    candidate.accumulationScore * weights.accumulation +
    candidate.absorptionScore * weights.absorption +
    prePumpScore * weights.prePump +
    marketScore * weights.market;

  // جریمه رشد بیش از حد
  if (candidate.change24h > 15) finalScore -= 8;
  if (candidate.change24h > 25) finalScore -= 12;

  // جریمه فاصله زیاد از محدوده
  if (candidate.baseDistancePct > 5) finalScore -= 10;
  if (candidate.baseDistancePct > 8) finalScore -= 15;

  // شرایط نامناسب BTC جریمه است، نه حذف قطعی تمام آلت‌کوین‌ها
  if (btcRegime.score < 30) finalScore -= 8;

  candidate.prePumpScore = prePumpScore;
  candidate.marketScore = marketScore;
  candidate.finalScore = clamp(finalScore);

  candidate.h1 = h1;
  candidate.m15 = m15;
  candidate.btcRegime = btcRegime;

  candidate.breakoutConfirmed =
    h1.breakout || h1.reclaim || m15.breakout || m15.reclaim;

  candidate.stage = stageLabel(candidate);

  return candidate;
}

function rankCandidates(candidates) {
  const unique = new Map();

  for (const candidate of candidates) {
    if (!candidate || !candidate.contract) continue;

    const existing = unique.get(candidate.contract);

    if (!existing || candidate.finalScore > existing.finalScore) {
      unique.set(candidate.contract, candidate);
    }
  }

  return [...unique.values()]
    .filter(c =>
      c.accumulationScore >= CONFIG.MIN_ACCUMULATION_SCORE &&
      c.absorptionScore >= CONFIG.MIN_ABSORPTION_SCORE &&
      c.finalScore >= CONFIG.MIN_FINAL_SCORE
    )
    .sort((a, b) => b.finalScore - a.finalScore);
}

/* -------------------------------------------------------
   TELEGRAM
------------------------------------------------------- */

function createTelegramMessage(candidates, totalQualified, btcRegime, page, pages) {
  const start = page * CONFIG.MAX_PER_MESSAGE;
  const selected = candidates.slice(
    start,
    start + CONFIG.MAX_PER_MESSAGE
  );

  const lines = [];

  lines.push(`📡 <b>GATE.IO | ACCUMULATION & PRE-PUMP RADAR</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);
  lines.push(`📊 کاندیدهای واجد شرایط: <b>${totalQualified}</b>`);
  lines.push(`🎯 انتخاب‌شده برای تلگرام: <b>${candidates.length}</b>`);
  lines.push(`₿ وضعیت BTC: <b>${btcRegime.trend}</b>`);
  lines.push(`📄 گزارش ${page + 1}/${pages}`);
  lines.push(`━━━━━━━━━━━━━━━━━━`);

  selected.forEach((c, index) => {
    const number = start + index + 1;

    lines.push(
      `\n<b>${number}. ${c.contract.replace("_USDT", "")}</b>`
    );

    lines.push(`💰 قیمت: <code>${formatPrice(c.price)}</code>`);
    lines.push(`📈 تغییر 24h: ${c.change24h.toFixed(2)}%`);
    lines.push(`💵 گردش 24h: ${formatMoney(c.turnover24h)}`);

    lines.push(
      `🧱 محدوده: ${formatPrice(c.zoneLow)} تا ${formatPrice(c.zoneHigh)}`
    );

    lines.push(
      `📉 افت قبلی: ${c.declinePct.toFixed(1)}%`
    );

    lines.push(
      `🧲 جذب عرضه: ${c.absorptionScore.toFixed(0)}/100`
    );

    lines.push(
      `🏗 انباشت: ${c.accumulationScore.toFixed(0)}/100`
    );

    lines.push(
      `🚀 پیش‌حرکت: ${c.prePumpScore.toFixed(0)}/100`
    );

    lines.push(
      `⭐ امتیاز نهایی: <b>${c.finalScore.toFixed(1)}/100</b>`
    );

    lines.push(`🔎 مرحله: <b>${c.stage}</b>`);

    lines.push(
      `⏱ تأیید 1H: ${c.h1.score.toFixed(0)} | 15M: ${c.m15.score.toFixed(0)}`
    );

    lines.push(
      `📊 حجم نسبی 1H: ${c.h1.relativeVolume.toFixed(2)}x`
    );

    lines.push(
      `📏 فاصله از سقف محدوده: ${c.baseDistancePct.toFixed(2)}%`
    );

    lines.push(`──────────────────`);
  });

  lines.push(
    `\n⚠️ امتیازها احتمال قطعی پامپ نیستند؛ فقط رتبه کیفیت شرایط بازارند.`
  );

  return lines.join("\n");
}

async function sendTelegramMessage(message) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log("Telegram credentials missing. Message not sent.");
    return false;
  }

  const url =
    `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (
    let attempt = 0;
    attempt < CONFIG.TELEGRAM_RETRY_LIMIT;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });

      const result = await response.json();

      if (result.ok) return true;

      if (response.status === 429) {
        const retryAfter =
          Number(result.parameters?.retry_after) || 5;

        await sleep((retryAfter + 1) * 1000);
        continue;
      }

      throw new Error(
        result.description || `Telegram HTTP ${response.status}`
      );
    } catch (error) {
      console.error("Telegram send error:", error.message);

      if (attempt < CONFIG.TELEGRAM_RETRY_LIMIT - 1) {
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  return false;
}

async function sendTelegramReport(candidates, btcRegime) {
  if (!candidates.length) {
    console.log("No qualified candidates. Telegram report skipped.");
    return;
  }

  const pages = Math.ceil(
    candidates.length / CONFIG.MAX_PER_MESSAGE
  );

  for (let page = 0; page < pages; page++) {
    const message = createTelegramMessage(
      candidates,
      candidates.length,
      btcRegime,
      page,
      pages
    );

    await sendTelegramMessage(message);

    if (page < pages - 1) {
      await sleep(1200);
    }
  }
}

/* -------------------------------------------------------
   MAIN SCANNER
------------------------------------------------------- */

async function runMarketScanner() {
  const startedAt = Date.now();

  console.log("==========================================");
  console.log("GATE.IO ACCUMULATION & PRE-PUMP RADAR");
  console.log("==========================================");

  console.log("1) دریافت قراردادها و تیکرها...");

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers()
  ]);

  const eligible = contracts.filter(contract => {
    const ticker = tickers.get(contract.name);

    return (
      ticker &&
      ticker.last >= CONFIG.MIN_LAST_PRICE &&
      ticker.turnover24h >= CONFIG.MIN_24H_TURNOVER
    );
  });

  console.log(`کل قراردادهای فعال: ${contracts.length}`);
  console.log(`بازارهای واجد شرایط نقدشوندگی: ${eligible.length}`);

  console.log("2) اسکن ساختار 4H بازارها...");

  const firstPass = await mapLimit(
    eligible,
    CONFIG.CONCURRENCY,
    async contract => {
      const ticker = tickers.get(contract.name);

      const candles = await getCandles(
        contract.name,
        CONFIG.MAIN_INTERVAL,
        CONFIG.MAIN_LIMIT
      );

      const candidate = analyze4h(
        contract.name,
        ticker,
        candles
      );

      return candidate;
    }
  );

  const initialCandidates = firstPass
    .filter(item => item && !item.error)
    .filter(Boolean)
    .sort((a, b) => b.initialScore - a.initialScore);

  console.log(
    `کاندیدهای اولیه انباشت/جذب عرضه: ${initialCandidates.length}`
  );

  // بررسی عمیق را روی تعداد بیشتری از کاندیدها انجام می‌دهیم
  // تا تأیید تایم‌فریم پایین‌تر فرصت‌های مناسب را از دست ندهد.
  const deepCandidates = initialCandidates.slice(
    0,
    CONFIG.DEEP_SCAN_LIMIT
  );

  console.log(
    `3) بررسی عمیق ${deepCandidates.length} کاندید در 1H و 15M...`
  );

  const btcCandles = await getCandles(
    "BTC_USDT",
    "1h",
    CONFIG.H1_LIMIT
  );

  const btcRegime = analyzeBtcRegime(btcCandles);

  console.log(
    `وضعیت BTC: ${btcRegime.trend} | امتیاز: ${btcRegime.score}`
  );

  const deepResults = await mapLimit(
    deepCandidates,
    CONFIG.DEEP_CONCURRENCY,
    async candidate => {
      const [h1Candles, m15Candles] = await Promise.all([
        getCandles(candidate.contract, "1h", CONFIG.H1_LIMIT),
        getCandles(candidate.contract, "15m", CONFIG.M15_LIMIT)
      ]);

      const h1 = analyzeLowerTimeframe(
        h1Candles,
        candidate.zoneHigh,
        candidate.zoneLow
      );

      const m15 = analyzeLowerTimeframe(
        m15Candles,
        candidate.zoneHigh,
        candidate.zoneLow
      );

      return calculateFinalScore(
        candidate,
        h1,
        m15,
        btcRegime
      );
    }
  );

  const analyzed = deepResults
    .filter(item => item && !item.error)
    .filter(Boolean);

  const allRanked = rankCandidates(analyzed);

  // فقط TOP 20 به تلگرام می‌رود.
  const selected = allRanked.slice(
    0,
    CONFIG.MAX_TELEGRAM_COINS
  );

  console.log("------------------------------------------");
  console.log(`اسکن موفق 4H: ${firstPass.filter(x => x && !x.error).length}`);
  console.log(`کاندیدهای اولیه: ${initialCandidates.length}`);
  console.log(`بررسی عمیق موفق: ${analyzed.length}`);
  console.log(`کاندیدهای نهایی واجد شرایط: ${allRanked.length}`);
  console.log(`ارسال به تلگرام: ${selected.length}`);
  console.log("------------------------------------------");

  if (selected.length) {
    console.table(
      selected.map((c, index) => ({
        rank: index + 1,
        contract: c.contract,
        final: c.finalScore.toFixed(1),
        accumulation: c.accumulationScore,
        absorption: c.absorptionScore,
        prePump: c.prePumpScore.toFixed(1),
        stage: c.stage,
        change24h: c.change24h.toFixed(2)
      }))
    );
  }

  await sendTelegramReport(selected, btcRegime);

  const elapsedSeconds = (
    (Date.now() - startedAt) / 1000
  ).toFixed(1);

  console.log(`مدت اجرای اسکن: ${elapsedSeconds} ثانیه`);
  console.log("SCAN COMPLETED");

  return {
    totalContracts: contracts.length,
    eligibleMarkets: eligible.length,
    initialCandidates: initialCandidates.length,
    deepAnalyzed: analyzed.length,
    totalQualified: allRanked.length,
    selected: selected.length,
    candidates: allRanked,
    telegramCandidates: selected,
    btcRegime,
    elapsedSeconds: Number(elapsedSeconds)
  };
}

export default runMarketScanner;

runMarketScanner().catch(error => {
  console.error("FATAL SCANNER ERROR:", error);
  process.exitCode = 1;
});
