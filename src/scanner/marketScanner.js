
/**
 * GATE.IO USDT PERPETUAL — ACCUMULATION CYCLE RADAR V2
 * ------------------------------------------------------------
 * هدف:
 * شناسایی بازارهایی که پس از یک افت معتبر وارد فاز تثبیت شده‌اند
 * و نشانه‌هایی از کاهش فشار فروش، حفظ کف و جذب احتمالی عرضه دارند.
 *
 * Timeframe: 4H
 * History: 180 candles
 * Markets: All active direct USDT perpetual contracts
 * Output: ALL qualified candidates (no TOP N limit)
 *
 * Required GitHub Secrets:
 * TELEGRAM_BOT_TOKEN
 * TELEGRAM_CHAT_ID
 *
 * Node.js 20+
 */

"use strict";

const CONFIG = {
  API_BASE: "https://api.gateio.ws/api/v4",
  TELEGRAM_API: "https://api.telegram.org",

  INTERVAL: "4h",
  CANDLE_LIMIT: 180,
  CANDLE_SECONDS: 4 * 60 * 60,

  CONCURRENCY: 6,
  RETRIES: 3,
  REQUEST_TIMEOUT: 15000,
  REQUEST_DELAY_MS: 100,

  // Minimum 24-hour quote turnover in USDT.
  MIN_24H_TURNOVER: 200000,

  // Minimum valid historical candles.
  MIN_CANDLES: 100,

  // Accumulation analysis windows.
  BASE_WINDOW: 18,
  DECLINE_LOOKBACK: 90,
  MIN_DECLINE_CANDLES: 12,

  // Hard filters.
  MIN_DECLINE_PCT: 10,
  MAX_DECLINE_PCT: 65,
  MAX_BASE_WIDTH_PCT: 24,
  MIN_BASE_VOLUME_RATIO: 0.15,

  MIN_SCORE: 62,

  TELEGRAM_MAX_LENGTH: 3800,

  // Set true only if you want detailed failed-market logs.
  DEBUG_ERRORS: false
};

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function min(values) {
  return values.length ? Math.min(...values) : 0;
}

function max(values) {
  return values.length ? Math.max(...values) : 0;
}

function pctChange(from, to) {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function formatNumber(value, digits = 2) {
  return number(value).toFixed(digits);
}

function formatMoney(value) {
  const n = number(value);

  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(2)}B`;
  }

  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(2)}K`;
  }

  return n.toFixed(0);
}

function safeError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

/* ------------------------------------------------------------
   HTTP
------------------------------------------------------------ */

async function fetchJSON(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT
    );

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "Gate-Accumulation-Radar/2.0"
        },
        signal: controller.signal
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${text.slice(0, 120)}`
        );
      }

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON response");
      }

      if (data && !Array.isArray(data) && data.label && data.message) {
        throw new Error(`${data.label}: ${data.message}`);
      }

      return data;
    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        await sleep(500 * Math.pow(2, attempt - 1));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Request failed");
}

/* ------------------------------------------------------------
   GATE.IO MARKET DATA
------------------------------------------------------------ */

async function getContracts() {
  const url = `${CONFIG.API_BASE}/futures/usdt/contracts`;
  const data = await fetchJSON(url);

  if (!Array.isArray(data)) {
    throw new Error("Invalid contracts response");
  }

  return data.filter((contract) => {
    return (
      contract &&
      contract.status === "trading" &&
      contract.in_delisting !== true &&
      contract.type === "direct" &&
      typeof contract.name === "string" &&
      contract.name.endsWith("_USDT")
    );
  });
}

async function getTickers() {
  const url = `${CONFIG.API_BASE}/futures/usdt/tickers`;
  const data = await fetchJSON(url);

  if (!Array.isArray(data)) {
    throw new Error("Invalid tickers response");
  }

  const map = new Map();

  for (const ticker of data) {
    if (ticker && ticker.contract) {
      map.set(ticker.contract, ticker);
    }
  }

  return map;
}

async function getCandles(contract) {
  const params = new URLSearchParams({
    contract,
    interval: CONFIG.INTERVAL,
    limit: String(CONFIG.CANDLE_LIMIT)
  });

  const url =
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`;

  const raw = await fetchJSON(url);

  if (!Array.isArray(raw)) {
    throw new Error("Invalid candlestick response");
  }

  const now = Math.floor(Date.now() / 1000);
  const currentCandleStart =
    Math.floor(now / CONFIG.CANDLE_SECONDS) *
    CONFIG.CANDLE_SECONDS;

  const candles = raw
    .map((item) => ({
      time: number(item.t),
      open: number(item.o),
      high: number(item.h),
      low: number(item.l),
      close: number(item.c),
      volume: number(item.v),
      turnover: number(item.sum)
    }))
    .filter((c) => {
      return (
        c.time > 0 &&
        c.time < currentCandleStart &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0 &&
        c.high >= c.low &&
        c.high >= c.open &&
        c.high >= c.close &&
        c.low <= c.open &&
        c.low <= c.close
      );
    })
    .sort((a, b) => a.time - b.time);

  // Remove duplicate timestamps.
  const unique = [];
  const seen = new Set();

  for (const candle of candles) {
    if (!seen.has(candle.time)) {
      seen.add(candle.time);
      unique.push(candle);
    }
  }

  return unique;
}

/* ------------------------------------------------------------
   CANDLE METRICS
------------------------------------------------------------ */

function candleMetrics(candle) {
  const range = Math.max(candle.high - candle.low, 0);
  const body = Math.abs(candle.close - candle.open);

  const upperWick =
    candle.high - Math.max(candle.open, candle.close);

  const lowerWick =
    Math.min(candle.open, candle.close) - candle.low;

  const closeLocation =
    range > 0
      ? (candle.close - candle.low) / range
      : 0.5;

  return {
    range,
    body,
    upperWick,
    lowerWick,
    closeLocation,
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open
  };
}

function trueRange(candle, previous) {
  if (!previous) {
    return candle.high - candle.low;
  }

  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previous.close),
    Math.abs(candle.low - previous.close)
  );
}

function averageTrueRange(candles) {
  if (candles.length < 2) return 0;

  const values = [];

  for (let i = 1; i < candles.length; i++) {
    values.push(trueRange(candles[i], candles[i - 1]));
  }

  return average(values);
}

/* ------------------------------------------------------------
   FIND PREVIOUS DECLINE
------------------------------------------------------------ */

function findDecline(candles, baseStartIndex) {
  const start = Math.max(
    0,
    baseStartIndex - CONFIG.DECLINE_LOOKBACK
  );

  let peakIndex = -1;
  let peakPrice = 0;

  for (let i = start; i < baseStartIndex; i++) {
    if (candles[i].high > peakPrice) {
      peakPrice = candles[i].high;
      peakIndex = i;
    }
  }

  if (peakIndex < 0) return null;

  const declineCandles = candles.slice(
    peakIndex,
    baseStartIndex
  );

  if (
    declineCandles.length <
    CONFIG.MIN_DECLINE_CANDLES
  ) {
    return null;
  }

  const troughPrice = min(
    declineCandles.map((c) => c.low)
  );

  const declinePct =
    ((peakPrice - troughPrice) / peakPrice) * 100;

  return {
    peakIndex,
    peakPrice,
    troughPrice,
    declinePct,
    candles: declineCandles
  };
}

/* ------------------------------------------------------------
   BASE STRUCTURE
------------------------------------------------------------ */

function analyzeBase(base) {
  const firstHalf = base.slice(
    0,
    Math.floor(base.length / 2)
  );

  const secondHalf = base.slice(
    Math.floor(base.length / 2)
  );

  const baseHigh = max(base.map((c) => c.high));
  const baseLow = min(base.map((c) => c.low));

  const referencePrice = average(
    base.map((c) => c.close)
  );

  const widthPct =
    referencePrice > 0
      ? ((baseHigh - baseLow) / referencePrice) * 100
      : 100;

  const firstLow = min(firstHalf.map((c) => c.low));
  const secondLow = min(secondHalf.map((c) => c.low));

  const lowChangePct =
    firstLow > 0
      ? ((secondLow - firstLow) / firstLow) * 100
      : -100;

  const recentLows = base
    .slice(-6)
    .map((c) => c.low);

  const previousLows = base
    .slice(-12, -6)
    .map((c) => c.low);

  const recentLow = min(recentLows);
  const previousLow = min(previousLows);

  const recentFloorHeld =
    recentLow >= baseLow * 0.985;

  const higherLow =
    previousLow > 0 &&
    recentLow >= previousLow * 0.985;

  const closesAboveFloor = base.filter(
    (c) => c.close > baseLow * 1.02
  ).length;

  return {
    baseHigh,
    baseLow,
    widthPct,
    lowChangePct,
    recentLow,
    previousLow,
    recentFloorHeld,
    higherLow,
    closesAboveFloor,
    floorHoldRatio: closesAboveFloor / base.length
  };
}

/* ------------------------------------------------------------
   SUPPLY / DEMAND PROXIES
------------------------------------------------------------ */

function analyzeSupplyDemand(base, declineCandles) {
  const baseMetrics = base.map(candleMetrics);

  const greenCandles = [];
  const redCandles = [];

  let absorptionCount = 0;
  let strongCloseCount = 0;
  let rejectionCount = 0;

  for (let i = 0; i < base.length; i++) {
    const candle = base[i];
    const metric = baseMetrics[i];

    if (metric.bullish) {
      greenCandles.push(candle);
    }

    if (metric.bearish) {
      redCandles.push(candle);
    }

    // Lower wick with close in upper half:
    // possible selling-pressure absorption.
    if (
      metric.lowerWick >= Math.max(metric.body * 0.8, metric.range * 0.2) &&
      metric.closeLocation >= 0.55
    ) {
      absorptionCount++;
    }

    if (metric.closeLocation >= 0.70) {
      strongCloseCount++;
    }

    if (
      metric.lowerWick > metric.upperWick * 1.25 &&
      metric.closeLocation > 0.50
    ) {
      rejectionCount++;
    }
  }

  const greenVolume = sum(
    greenCandles.map((c) => c.turnover)
  );

  const redVolume = sum(
    redCandles.map((c) => c.turnover)
  );

  const greenRedRatio =
    redVolume > 0
      ? greenVolume / redVolume
      : greenVolume > 0
        ? 2
        : 0;

  const baseTurnover = average(
    base.map((c) => c.turnover)
  );

  const declineTurnover = average(
    declineCandles.map((c) => c.turnover)
  );

  const volumeRatio =
    declineTurnover > 0
      ? baseTurnover / declineTurnover
      : 0;

  const declineRedVolume = sum(
    declineCandles
      .filter((c) => c.close < c.open)
      .map((c) => c.turnover)
  );

  const declineGreenVolume = sum(
    declineCandles
      .filter((c) => c.close > c.open)
      .map((c) => c.turnover)
  );

  const declineSellRatio =
    declineRedVolume > 0
      ? declineGreenVolume / declineRedVolume
      : 1;

  return {
    greenVolume,
    redVolume,
    greenRedRatio,
    baseTurnover,
    declineTurnover,
    volumeRatio,
    declineSellRatio,
    absorptionCount,
    strongCloseCount,
    rejectionCount,
    absorptionRatio: absorptionCount / base.length,
    strongCloseRatio: strongCloseCount / base.length,
    rejectionRatio: rejectionCount / base.length
  };
}

/* ------------------------------------------------------------
   SCORE MODEL
------------------------------------------------------------ */

function calculateScore(data) {
  let score = 0;
  const reasons = [];

  // 1. Previous meaningful decline: 15 points.
  if (data.declinePct >= 10 && data.declinePct < 15) {
    score += 8;
  } else if (
    data.declinePct >= 15 &&
    data.declinePct < 30
  ) {
    score += 15;
  } else if (
    data.declinePct >= 30 &&
    data.declinePct <= 50
  ) {
    score += 13;
  } else if (data.declinePct > 50) {
    score += 7;
  }

  reasons.push(`افت قبلی ${formatNumber(data.declinePct)}٪`);

  // 2. Base compression: 15 points.
  if (data.widthPct <= 8) {
    score += 15;
  } else if (data.widthPct <= 13) {
    score += 12;
  } else if (data.widthPct <= 18) {
    score += 8;
  } else if (data.widthPct <= 24) {
    score += 4;
  }

  reasons.push(`عرض محدوده ${formatNumber(data.widthPct)}٪`);

  // 3. Volume behavior: 15 points.
  if (
    data.volumeRatio >= 0.45 &&
    data.volumeRatio <= 1.10
  ) {
    score += 15;
  } else if (
    data.volumeRatio > 1.10 &&
    data.volumeRatio <= 1.50
  ) {
    score += 10;
  } else if (
    data.volumeRatio >= 0.25 &&
    data.volumeRatio < 0.45
  ) {
    score += 8;
  } else if (data.volumeRatio > 1.50) {
    score += 5;
  }

  reasons.push(
    `حجم پایه/افت ${formatNumber(data.volumeRatio)}`
  );

  // 4. Absorption and rejection proxies: 20 points.
  if (data.absorptionRatio >= 0.30) {
    score += 10;
  } else if (data.absorptionRatio >= 0.20) {
    score += 7;
  } else if (data.absorptionRatio >= 0.12) {
    score += 4;
  }

  if (data.rejectionRatio >= 0.30) {
    score += 6;
  } else if (data.rejectionRatio >= 0.18) {
    score += 4;
  } else if (data.rejectionRatio >= 0.10) {
    score += 2;
  }

  if (data.strongCloseRatio >= 0.35) {
    score += 4;
  } else if (data.strongCloseRatio >= 0.22) {
    score += 2;
  }

  // 5. Floor structure: 20 points.
  if (data.higherLow) {
    score += 10;
    reasons.push("کف‌های نسبتاً بالاتر");
  }

  if (data.recentFloorHeld) {
    score += 6;
    reasons.push("حفظ کف محدوده");
  }

  if (data.floorHoldRatio >= 0.85) {
    score += 4;
  } else if (data.floorHoldRatio >= 0.70) {
    score += 2;
  }

  // 6. Relative buying behavior: 10 points.
  if (data.greenRedRatio >= 1.20) {
    score += 10;
    reasons.push("حجم صعودی قوی‌تر");
  } else if (data.greenRedRatio >= 0.90) {
    score += 7;
  } else if (data.greenRedRatio >= 0.65) {
    score += 4;
  }

  // 7. Volatility contraction: 5 points.
  if (data.atrRatio <= 0.55) {
    score += 5;
    reasons.push("کاهش محسوس نوسان");
  } else if (data.atrRatio <= 0.75) {
    score += 3;
  } else if (data.atrRatio <= 0.90) {
    score += 1;
  }

  return {
    score: Math.min(100, score),
    reasons
  };
}

/* ------------------------------------------------------------
   MAIN ACCUMULATION ANALYSIS
------------------------------------------------------------ */

function analyzeAccumulation(candles, ticker) {
  if (
    !Array.isArray(candles) ||
    candles.length < CONFIG.MIN_CANDLES
  ) {
    return {
      qualified: false,
      reason: "تاریخچه ناکافی"
    };
  }

  const turnover24h = number(
    ticker.volume_24h_quote ??
    ticker.volume_24h_usd ??
    0
  );

  if (turnover24h < CONFIG.MIN_24H_TURNOVER) {
    return {
      qualified: false,
      reason: "نقدشوندگی پایین"
    };
  }

  const baseStartIndex =
    candles.length - CONFIG.BASE_WINDOW;

  const base = candles.slice(baseStartIndex);

  const decline = findDecline(
    candles,
    baseStartIndex
  );

  if (!decline) {
    return {
      qualified: false,
      reason: "افت معتبر پیدا نشد"
    };
  }

  if (
    decline.declinePct < CONFIG.MIN_DECLINE_PCT ||
    decline.declinePct > CONFIG.MAX_DECLINE_PCT
  ) {
    return {
      qualified: false,
      reason: "میزان افت خارج از محدوده"
    };
  }

  const baseData = analyzeBase(base);

  if (
    baseData.widthPct >
    CONFIG.MAX_BASE_WIDTH_PCT
  ) {
    return {
      qualified: false,
      reason: "محدوده تثبیت بیش از حد وسیع"
    };
  }

  const supplyDemand = analyzeSupplyDemand(
    base,
    decline.candles
  );

  if (
    supplyDemand.volumeRatio <
    CONFIG.MIN_BASE_VOLUME_RATIO
  ) {
    return {
      qualified: false,
      reason: "حجم معاملات بیش از حد ضعیف"
    };
  }

  const declineATR = averageTrueRange(
    decline.candles
  );

  const baseATR = averageTrueRange(base);

  const atrRatio =
    declineATR > 0
      ? baseATR / declineATR
      : 1;

  const latestClose = candles[candles.length - 1].close;

  const data = {
    ...baseData,
    ...supplyDemand,

    declinePct: decline.declinePct,
    declinePeak: decline.peakPrice,
    declineTrough: decline.troughPrice,

    atrRatio,

    latestClose,
    turnover24h
  };

  // Mandatory structural conditions:
  // A quiet market without floor stability is not enough.
  if (
    !data.recentFloorHeld ||
    data.floorHoldRatio < 0.55
  ) {
    return {
      qualified: false,
      reason: "ساختار کف ضعیف"
    };
  }

  // Avoid a base where selling volume dominates
  // and there are almost no signs of rejection.
  if (
    data.greenRedRatio < 0.35 &&
    data.absorptionRatio < 0.12 &&
    data.rejectionRatio < 0.12
  ) {
    return {
      qualified: false,
      reason: "فشار فروش همچنان غالب است"
    };
  }

  const scoring = calculateScore(data);

  if (scoring.score < CONFIG.MIN_SCORE) {
    return {
      qualified: false,
      reason: "امتیاز کمتر از حداقل"
    };
  }

  return {
    qualified: true,
    score: scoring.score,

    contract: null,

    price: latestClose,
    turnover24h,

    declinePct: data.declinePct,
    baseWidthPct: data.widthPct,
    volumeRatio: data.volumeRatio,
    greenRedRatio: data.greenRedRatio,
    absorptionRatio: data.absorptionRatio,
    rejectionRatio: data.rejectionRatio,
    atrRatio: data.atrRatio,

    higherLow: data.higherLow,
    floorHeld: data.recentFloorHeld,

    baseHigh: data.baseHigh,
    baseLow: data.baseLow,

    reasons: scoring.reasons
  };
}

/* ------------------------------------------------------------
   CONCURRENCY WORKER
------------------------------------------------------------ */

async function processMarkets(contracts, tickers) {
  const results = [];
  const errors = [];

  let completed = 0;
  let successful = 0;
  let failed = 0;

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= contracts.length) {
        return;
      }

      const contract = contracts[index];
      const ticker = tickers.get(contract.name);

      try {
        if (!ticker) {
          throw new Error("Ticker not found");
        }

        const candles = await getCandles(contract.name);

        const analysis = analyzeAccumulation(
          candles,
          ticker
        );

        successful++;

        if (analysis.qualified) {
          analysis.contract = contract.name;
          results.push(analysis);
        }
      } catch (error) {
        failed++;

        errors.push({
          contract: contract.name,
          error: safeError(error)
        });

        if (CONFIG.DEBUG_ERRORS) {
          console.error(
            `[ERROR] ${contract.name}: ${safeError(error)}`
          );
        }
      }

      completed++;

      if (completed % 100 === 0) {
        console.log(
          `[PROGRESS] ${completed}/${contracts.length} | ` +
          `Success: ${successful} | Failed: ${failed} | ` +
          `Candidates: ${results.length}`
        );
      }

      await sleep(CONFIG.REQUEST_DELAY_MS);
    }
  }

  const workers = Array.from(
    {
      length: Math.min(
        CONFIG.CONCURRENCY,
        contracts.length
      )
    },
    () => worker()
  );

  await Promise.all(workers);

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    if (b.turnover24h !== a.turnover24h) {
      return b.turnover24h - a.turnover24h;
    }

    return a.contract.localeCompare(b.contract);
  });

  return {
    results,
    errors,
    completed,
    successful,
    failed
  };
}

/* ------------------------------------------------------------
   TELEGRAM REPORT
------------------------------------------------------------ */

function candidateText(item, index) {
  const status = item.score >= 80
    ? "قوی"
    : item.score >= 70
      ? "مناسب"
      : "قابل بررسی";

  const structure = [
    item.higherLow ? "کف بالاتر" : null,
    item.floorHeld ? "حفظ کف" : null
  ].filter(Boolean).join(" | ");

  return [
    `#${index + 1}  ${item.contract}`,
    `امتیاز: ${item.score}/100  |  وضعیت: ${status}`,
    `قیمت: ${item.price}`,
    `افت قبلی: ${formatNumber(item.declinePct)}٪`,
    `عرض تثبیت: ${formatNumber(item.baseWidthPct)}٪`,
    `نسبت حجم پایه به افت: ${formatNumber(item.volumeRatio)}`,
    `حجم صعودی/نزولی: ${formatNumber(item.greenRedRatio)}`,
    `نشانه جذب احتمالی: ${formatNumber(item.absorptionRatio * 100, 0)}٪ کندل‌ها`,
    `رد فشار فروش: ${formatNumber(item.rejectionRatio * 100, 0)}٪ کندل‌ها`,
    `نسبت نوسان: ${formatNumber(item.atrRatio)}`,
    `گردش مالی ۲۴ساعته: ${formatMoney(item.turnover24h)} USDT`,
    `ساختار: ${structure || "تأیید محدود"}`,
    `کف محدوده: ${item.baseLow}`,
    `سقف محدوده: ${item.baseHigh}`,
    `دلایل: ${item.reasons.join("، ")}`,
    "------------------------"
  ].join("\n");
}

function splitMessages(text, maxLength) {
  const lines = text.split("\n");
  const chunks = [];

  let current = "";

  for (const line of lines) {
    const candidate = current
      ? `${current}\n${line}`
      : line;

    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID"
    );
  }

  const url =
    `${CONFIG.TELEGRAM_API}/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram error: ${data.description || response.status}`
    );
  }
}

async function sendReport(stats) {
  const now = new Date().toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");

  const header = [
    "📡 GATE.IO | ACCUMULATION RADAR V2",
    "━━━━━━━━━━━━━━━━━━━━",
    `🕒 ${now}`,
    `⏱ تایم‌فریم: ${CONFIG.INTERVAL}`,
    "",
    "📊 MARKET SCAN",
    `قراردادهای فعال: ${stats.total}`,
    `بررسی‌شده: ${stats.successful}`,
    `خطا: ${stats.failed}`,
    `کاندیدهای انباشت: ${stats.results.length}`,
    "",
    "⚠️ امتیازها رتبه‌بندی الگوریتمی هستند، نه احتمال قطعی پامپ.",
    "نشانه‌های جذب عرضه از رفتار کندل‌ها تخمین زده شده‌اند.",
    "━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");

  const messages = [header];

  if (stats.results.length === 0) {
    messages.push(
      "در این اجرا هیچ بازاری تمام شروط شناسایی انباشت را نداشت."
    );
  } else {
    const body = stats.results
      .map((item, index) => candidateText(item, index))
      .join("\n");

    messages.push(...splitMessages(
      body,
      CONFIG.TELEGRAM_MAX_LENGTH
    ));
  }

  if (stats.errors.length > 0) {
    const errorSummary = [
      "⚠️ نمونه خطاهای دریافت داده:",
      ...stats.errors.slice(0, 12).map(
        (e) => `${e.contract}: ${e.error}`
      )
    ].join("\n");

    messages.push(errorSummary);
  }

  for (let i = 0; i < messages.length; i++) {
    const page = messages.length > 1
      ? `\n\n📄 پیام ${i + 1}/${messages.length}`
      : "";

    await sendTelegramMessage(
      `${messages[i]}${page}`
    );

    await sleep(350);
  }
}

/* ------------------------------------------------------------
   MAIN
------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();

  console.log("======================================");
  console.log("GATE.IO ACCUMULATION RADAR V2");
  console.log("======================================");

  console.log("[1] Fetching active USDT contracts...");

  const contracts = await getContracts();

  console.log(
    `[INFO] Active direct USDT contracts: ${contracts.length}`
  );

  console.log("[2] Fetching market tickers...");

  const tickers = await getTickers();

  console.log(
    `[INFO] Tickers received: ${tickers.size}`
  );

  console.log("[3] Scanning 4H candles...");

  const scan = await processMarkets(
    contracts,
    tickers
  );

  console.log("[4] Scan completed.");

  console.log(
    `Successful: ${scan.successful}`
  );

  console.log(
    `Failed: ${scan.failed}`
  );

  console.log(
    `Candidates: ${scan.results.length}`
  );

  console.log("[5] Sending Telegram report...");

  await sendReport({
    total: contracts.length,
    successful: scan.successful,
    failed: scan.failed,
    results: scan.results,
    errors: scan.errors
  });

  const elapsed = (
    (Date.now() - startedAt) / 1000
  ).toFixed(1);

  console.log(
    `[DONE] Finished in ${elapsed} seconds.`
  );
}

main().catch((error) => {
  console.error("[FATAL]", safeError(error));
  process.exitCode = 1;
});
