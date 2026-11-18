
/**
 * GATE.IO USDT PERPETUAL
 * ACCUMULATION ZONE RADAR — V3
 * ---------------------------------------------------------
 * Goal:
 * Detect possible accumulation zones BEFORE bullish breakouts.
 *
 * Timeframe: 4H
 * Scans all active direct USDT perpetual contracts.
 *
 * Detection stages:
 * 1) ACCUMULATION_ZONE
 * 2) DEMAND_BUILDING
 *
 * Important:
 * Scores are technical ranking scores, NOT probabilities.
 * This scanner does not generate buy/sell orders.
 *
 * Node.js 20+
 */

// =========================================================
// CONFIG
// =========================================================

const CONFIG = {
  BASE_URL: "https://api.gateio.ws/api/v4",

  INTERVAL: "4h",
  CANDLE_LIMIT: 240,

  CONCURRENCY: 6,
  RETRIES: 3,
  REQUEST_TIMEOUT: 15000,

  MIN_24H_TURNOVER: 200000,

  MIN_CANDLES: 110,

  BASE_WINDOWS: [18, 24, 30, 36],

  DECLINE_LOOKBACK: 100,

  MIN_DECLINE_PCT: 8,
  MAX_DECLINE_PCT: 70,

  MAX_BASE_WIDTH_PCT: 22,

  MIN_FLOOR_STABILITY: -0.035,

  MIN_ZONE_SCORE: 58,
  MIN_DEMAND_SCORE: 70,

  TELEGRAM_MAX_LENGTH: 3500,

  TELEGRAM_BOT_TOKEN:
    process.env.TELEGRAM_BOT_TOKEN,

  TELEGRAM_CHAT_ID:
    process.env.TELEGRAM_CHAT_ID,
};

// =========================================================
// GLOBAL STATS
// =========================================================

const stats = {
  totalContracts: 0,
  eligibleContracts: 0,
  checked: 0,
  failed: 0,
  insufficient: 0,

  accumulationZones: 0,
  demandBuilding: 0,

  errors: [],
};

// =========================================================
// HELPERS
// =========================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function average(values) {
  if (!values.length) return 0;

  return values.reduce((a, b) => a + b, 0) /
    values.length;
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function min(values) {
  return Math.min(...values);
}

function max(values) {
  return Math.max(...values);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function percent(value) {
  return `${value.toFixed(2)}%`;
}

function price(value) {
  if (!Number.isFinite(value)) return "-";

  return value.toLocaleString("en-US", {
    maximumFractionDigits: 8,
  });
}

function formatMoney(value) {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)}B`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(2)}K`;
  }

  return value.toFixed(0);
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

// =========================================================
// HTTP
// =========================================================

async function request(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(
          CONFIG.REQUEST_TIMEOUT
        ),
      });

      if (!response.ok) {
        const body = await response.text();

        throw new Error(
          `HTTP ${response.status}: ${body.slice(0, 180)}`
        );
      }

      return await response.json();

    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        await sleep(attempt * 1000);
      }
    }
  }

  throw lastError;
}

// =========================================================
// GATE.IO MARKET DATA
// =========================================================

async function getContracts() {
  const url =
    `${CONFIG.BASE_URL}/futures/usdt/contracts`;

  const data = await request(url);

  if (!Array.isArray(data)) {
    throw new Error("Invalid contracts response");
  }

  return data;
}

async function getTickers() {
  const url =
    `${CONFIG.BASE_URL}/futures/usdt/tickers`;

  const data = await request(url);

  if (!Array.isArray(data)) {
    throw new Error("Invalid tickers response");
  }

  return data;
}

async function getCandles(contract) {
  const url = new URL(
    `${CONFIG.BASE_URL}/futures/usdt/candlesticks`
  );

  url.searchParams.set("contract", contract);
  url.searchParams.set("interval", CONFIG.INTERVAL);
  url.searchParams.set(
    "limit",
    String(CONFIG.CANDLE_LIMIT)
  );

  const data = await request(url.toString());

  if (!Array.isArray(data)) {
    throw new Error("Invalid candles response");
  }

  const candles = data
    .map((c) => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),

      // Gate futures candle "sum" is quote turnover.
      turnover: number(c.sum),

      volume: number(c.v),
    }))
    .filter((c) =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  // Remove duplicate timestamps.
  const unique = new Map();

  for (const candle of candles) {
    unique.set(candle.time, candle);
  }

  const result = [...unique.values()];

  // Exclude the currently forming 4H candle.
  const intervalSeconds = 4 * 60 * 60;
  const currentBucket =
    Math.floor(Date.now() / 1000 / intervalSeconds) *
    intervalSeconds;

  return result.filter(
    (c) => c.time < currentBucket
  );
}

// =========================================================
// CANDLE FEATURES
// =========================================================

function candleFeatures(c) {
  const range = Math.max(c.high - c.low, 0);

  const body = Math.abs(c.close - c.open);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  const closeLocation =
    range > 0
      ? (c.close - c.low) / range
      : 0.5;

  return {
    range,
    body,
    lowerWick,
    upperWick,
    closeLocation,

    green: c.close > c.open,
    red: c.close < c.open,

    lowerWickRatio:
      range > 0 ? lowerWick / range : 0,

    upperWickRatio:
      range > 0 ? upperWick / range : 0,
  };
}

// =========================================================
// FIND PREVIOUS DECLINE
// =========================================================

function findPreviousDecline(candles, baseStart) {
  const start = Math.max(
    0,
    baseStart - CONFIG.DECLINE_LOOKBACK
  );

  const history = candles.slice(start, baseStart);

  if (history.length < 12) return null;

  let peakIndex = -1;
  let peakPrice = 0;

  // Find the highest high in the preceding history.
  for (let i = 0; i < history.length; i++) {
    if (history[i].high > peakPrice) {
      peakPrice = history[i].high;
      peakIndex = i;
    }
  }

  if (peakIndex < 0) return null;

  const afterPeak = history.slice(peakIndex + 1);

  if (afterPeak.length < 8) return null;

  const troughPrice = min(
    afterPeak.map((c) => c.low)
  );

  if (troughPrice <= 0) return null;

  const declinePct =
    ((peakPrice - troughPrice) / peakPrice) * 100;

  if (
    declinePct < CONFIG.MIN_DECLINE_PCT ||
    declinePct > CONFIG.MAX_DECLINE_PCT
  ) {
    return null;
  }

  return {
    peakPrice,
    troughPrice,
    declinePct,
    candlesFromPeak: afterPeak.length,
  };
}

// =========================================================
// ANALYZE BASE STRUCTURE
// =========================================================

function analyzeBase(candles, windowSize, ticker) {
  if (candles.length < windowSize + 30) {
    return null;
  }

  const baseStart = candles.length - windowSize;
  const base = candles.slice(baseStart);

  const previous = findPreviousDecline(
    candles,
    baseStart
  );

  if (!previous) return null;

  const highs = base.map((c) => c.high);
  const lows = base.map((c) => c.low);
  const closes = base.map((c) => c.close);

  const baseHigh = max(highs);
  const baseLow = min(lows);

  if (baseLow <= 0 || baseHigh <= baseLow) {
    return null;
  }

  const baseMid = (baseHigh + baseLow) / 2;

  const baseWidthPct =
    ((baseHigh - baseLow) / baseMid) * 100;

  if (
    baseWidthPct > CONFIG.MAX_BASE_WIDTH_PCT
  ) {
    return null;
  }

  // -------------------------------------------------------
  // FLOOR STABILITY
  // Compare first half and second half.
  // Do NOT compare recent low to the absolute base low.
  // -------------------------------------------------------

  const half = Math.floor(windowSize / 2);

  const firstHalf = base.slice(0, half);
  const secondHalf = base.slice(half);

  const firstHalfLow = min(
    firstHalf.map((c) => c.low)
  );

  const secondHalfLow = min(
    secondHalf.map((c) => c.low)
  );

  const floorChangePct =
    ((secondHalfLow - firstHalfLow) /
      firstHalfLow) * 100;

  const floorStable =
    floorChangePct >=
    CONFIG.MIN_FLOOR_STABILITY * 100;

  // Higher-low check using averages of local lows.
  const firstRecentLows = base
    .slice(-12, -6)
    .map((c) => c.low);

  const lastRecentLows = base
    .slice(-6)
    .map((c) => c.low);

  const firstRecentLow =
    average(firstRecentLows);

  const lastRecentLow =
    average(lastRecentLows);

  const higherLows =
    lastRecentLow > firstRecentLow * 1.005;

  // -------------------------------------------------------
  // VOLUME BEHAVIOR
  // -------------------------------------------------------

  const baseTurnovers = base.map(
    (c) => c.turnover
  );

  const earlyTurnover = average(
    base.slice(0, half).map((c) => c.turnover)
  );

  const lateTurnover = average(
    base.slice(half).map((c) => c.turnover)
  );

  const volumeTrend =
    earlyTurnover > 0
      ? lateTurnover / earlyTurnover
      : 1;

  const features = base.map(candleFeatures);

  const greenTurnover = sum(
    base
      .filter((c) => c.close > c.open)
      .map((c) => c.turnover)
  );

  const redTurnover = sum(
    base
      .filter((c) => c.close < c.open)
      .map((c) => c.turnover)
  );

  const greenRedRatio =
    redTurnover > 0
      ? greenTurnover / redTurnover
      : greenTurnover > 0
        ? 2
        : 1;

  const greenCount = features.filter(
    (f) => f.green
  ).length;

  const greenRatio =
    greenCount / windowSize;

  // -------------------------------------------------------
  // VOLATILITY CONTRACTION
  // -------------------------------------------------------

  const candleRanges = features.map(
    (f) => f.range
  );

  const baseRangeRatio =
    average(candleRanges) / baseMid;

  const previousRangeCandles = candles.slice(
    Math.max(0, baseStart - 24),
    baseStart
  );

  const previousRangeRatio =
    previousRangeCandles.length
      ? average(
          previousRangeCandles.map(
            (c) => c.high - c.low
          )
        ) / baseMid
      : baseRangeRatio;

  const volatilityRatio =
    previousRangeRatio > 0
      ? baseRangeRatio / previousRangeRatio
      : 1;

  // -------------------------------------------------------
  // PRICE POSITION
  // -------------------------------------------------------

  const lastClose = base[base.length - 1].close;

  const closePosition =
    (lastClose - baseLow) /
    (baseHigh - baseLow);

  const recentCloseAverage = average(
    base.slice(-6).map((c) => c.close)
  );

  const recentCloseStrength =
    recentCloseAverage > baseMid;

  const recentRelativeVolume =
    average(
      base.slice(-6).map((c) => c.turnover)
    );

  const previousRelativeVolume =
    average(
      base.slice(-12, -6).map((c) => c.turnover)
    );

  const recentVolumeExpansion =
    previousRelativeVolume > 0
      ? recentRelativeVolume / previousRelativeVolume
      : 1;

  // -------------------------------------------------------
  // POSSIBLE SELLING ABSORPTION PROXY
  // This is NOT real order-flow absorption.
  // -------------------------------------------------------

  const lowerWickRatio = average(
    features.map((f) => f.lowerWickRatio)
  );

  const strongCloseRatio =
    average(
      features.map((f) => f.closeLocation)
    );

  const rejectionCandles = features.filter(
    (f) =>
      f.lowerWickRatio >= 0.35 &&
      f.closeLocation >= 0.55
  ).length;

  const rejectionRatio =
    rejectionCandles / windowSize;

  // -------------------------------------------------------
  // SCORE
  // -------------------------------------------------------

  let score = 0;

  // Previous decline: max 15
  score += clamp(
    ((previous.declinePct - 8) / 42) * 15,
    0,
    15
  );

  // Base compression: max 20
  score += clamp(
    ((22 - baseWidthPct) / 22) * 20,
    0,
    20
  );

  // Floor stability: max 20
  if (floorStable) {
    score += 12;
  }

  if (higherLows) {
    score += 8;
  }

  // Volume behavior: max 15
  if (volumeTrend < 0.85) {
    score += 8;
  } else if (volumeTrend < 1.1) {
    score += 5;
  }

  if (greenRedRatio >= 1.1) {
    score += 7;
  } else if (greenRedRatio >= 0.85) {
    score += 4;
  }

  // Volatility contraction: max 10
  if (volatilityRatio < 0.65) {
    score += 10;
  } else if (volatilityRatio < 0.85) {
    score += 7;
  } else if (volatilityRatio < 1.0) {
    score += 4;
  }

  // Rejection / wick evidence: max 10
  if (rejectionRatio >= 0.25) {
    score += 6;
  } else if (rejectionRatio >= 0.15) {
    score += 4;
  }

  if (lowerWickRatio >= 0.25) {
    score += 4;
  }

  // Price position: max 10
  if (closePosition >= 0.75) {
    score += 6;
  } else if (closePosition >= 0.55) {
    score += 4;
  }

  if (recentCloseStrength) {
    score += 4;
  }

  score = Math.round(clamp(score, 0, 100));

  // -------------------------------------------------------
  // HARD STRUCTURE FILTERS
  // -------------------------------------------------------

  if (!floorStable) return null;

  if (
    greenRedRatio < 0.35 &&
    rejectionRatio < 0.10 &&
    !higherLows
  ) {
    return null;
  }

  if (score < CONFIG.MIN_ZONE_SCORE) {
    return null;
  }

  // -------------------------------------------------------
  // DEMAND BUILDING SCORE
  // -------------------------------------------------------

  let demandScore = 0;

  if (higherLows) {
    demandScore += 20;
  }

  if (greenRedRatio >= 1.2) {
    demandScore += 20;
  } else if (greenRedRatio >= 1.0) {
    demandScore += 12;
  }

  if (recentVolumeExpansion >= 1.5) {
    demandScore += 20;
  } else if (recentVolumeExpansion >= 1.2) {
    demandScore += 12;
  }

  if (closePosition >= 0.75) {
    demandScore += 20;
  } else if (closePosition >= 0.60) {
    demandScore += 12;
  }

  if (recentCloseStrength) {
    demandScore += 10;
  }

  if (greenRatio >= 0.60) {
    demandScore += 10;
  }

  demandScore = Math.round(
    clamp(demandScore, 0, 100)
  );

  const demandBuilding =
    demandScore >= CONFIG.MIN_DEMAND_SCORE;

  const tickerTurnover = number(
    ticker.volume_24h_quote ??
    ticker.volume_24h_usd ??
    ticker.volume_24h
  );

  return {
    windowSize,

    score,
    demandScore,

    stage: demandBuilding
      ? "DEMAND_BUILDING"
      : "ACCUMULATION_ZONE",

    baseHigh,
    baseLow,
    baseMid,
    baseWidthPct,

    previousDeclinePct:
      previous.declinePct,

    floorChangePct,

    greenRedRatio,
    volumeTrend,

    volatilityRatio,

    closePosition,
    lastClose,

    recentVolumeExpansion,

    lowerWickRatio,
    rejectionRatio,

    greenRatio,

    turnover24h: tickerTurnover,

    demandBuilding,
  };
}

// =========================================================
// ANALYZE ONE MARKET
// =========================================================

async function analyzeMarket(contract, ticker) {
  const candles = await getCandles(contract.name);

  if (candles.length < CONFIG.MIN_CANDLES) {
    stats.insufficient++;
    return null;
  }

  const turnover24h = number(
    ticker.volume_24h_quote ??
    ticker.volume_24h_usd ??
    ticker.volume_24h
  );

  if (
    turnover24h < CONFIG.MIN_24H_TURNOVER
  ) {
    return null;
  }

  const results = [];

  for (const windowSize of CONFIG.BASE_WINDOWS) {
    const result = analyzeBase(
      candles,
      windowSize,
      ticker
    );

    if (result) {
      results.push(result);
    }
  }

  if (!results.length) return null;

  // Select the strongest valid window.
  // A longer window wins only when its score is better.
  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return b.windowSize - a.windowSize;
  });

  const best = results[0];

  return {
    contract: contract.name,
    lastPrice: number(ticker.last),
    change24h: number(ticker.change_percentage),
    ...best,
  };
}

// =========================================================
// CONCURRENCY WORKER
// =========================================================

async function processMarkets(contracts, tickerMap) {
  const results = [];
  let index = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;

      if (currentIndex >= contracts.length) {
        return;
      }

      const contract = contracts[currentIndex];

      try {
        const ticker = tickerMap.get(contract.name);

        if (!ticker) {
          stats.failed++;

          stats.errors.push({
            contract: contract.name,
            error: "Ticker not found",
          });

          continue;
        }

        const result = await analyzeMarket(
          contract,
          ticker
        );

        stats.checked++;

        if (result) {
          results.push(result);

          if (result.stage === "DEMAND_BUILDING") {
            stats.demandBuilding++;
          } else {
            stats.accumulationZones++;
          }
        }

      } catch (error) {
        stats.failed++;

        stats.errors.push({
          contract: contract.name,
          error: String(error.message || error).slice(0, 180),
        });
      }

      if (stats.checked % 100 === 0) {
        console.log(
          `Progress: ${stats.checked}/${contracts.length}`
        );
      }
    }
  }

  const workers = Array.from(
    {
      length: CONFIG.CONCURRENCY,
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// =========================================================
// TELEGRAM
// =========================================================

async function sendTelegram(message) {
  if (
    !CONFIG.TELEGRAM_BOT_TOKEN ||
    !CONFIG.TELEGRAM_CHAT_ID
  ) {
    console.log(
      "Telegram credentials missing. Report printed locally."
    );

    console.log(message);
    return;
  }

  const url =
    `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram error: ${JSON.stringify(data).slice(0, 300)}`
    );
  }
}

function splitMessages(text, maxLength) {
  const lines = text.split("\n");
  const chunks = [];

  let current = "";

  for (const line of lines) {
    if (
      current.length + line.length + 1 >
      maxLength
    ) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

// =========================================================
// REPORT FORMAT
// =========================================================

function formatResult(item, index) {
  const isDemand =
    item.stage === "DEMAND_BUILDING";

  const title = isDemand
    ? "🟢 DEMAND BUILDING"
    : "🟡 ACCUMULATION ZONE";

  return [
    `${index}. ${item.contract}`,
    `${title}`,
    `━━━━━━━━━━━━━━━━━━`,
    `⭐ Zone Score: ${item.score}/100`,
    `🔥 Demand Score: ${item.demandScore}/100`,
    ``,
    `💰 Price: ${price(item.lastPrice)}`,
    `📉 Previous Decline: ${percent(item.previousDeclinePct)}`,
    `📦 Base Width: ${percent(item.baseWidthPct)}`,
    `📏 Base Window: ${item.windowSize} candles`,
    ``,
    `🔻 Zone Low: ${price(item.baseLow)}`,
    `🔺 Zone High: ${price(item.baseHigh)}`,
    `📍 Zone Mid: ${price(item.baseMid)}`,
    ``,
    `🧱 Floor Change: ${percent(item.floorChangePct)}`,
    `📊 Green/Red Volume: ${item.greenRedRatio.toFixed(2)}`,
    `📉 Volume Trend: ${item.volumeTrend.toFixed(2)}`,
    `📐 Volatility Ratio: ${item.volatilityRatio.toFixed(2)}`,
    `📈 Recent Volume Expansion: ${item.recentVolumeExpansion.toFixed(2)}`,
    `🕯 Rejection Ratio: ${percent(item.rejectionRatio * 100)}`,
    `💵 24H Turnover: ${formatMoney(item.turnover24h)} USDT`,
    ``
  ].join("\n");
}

function buildReport(results) {
  const demand = results
    .filter((r) => r.stage === "DEMAND_BUILDING")
    .sort((a, b) => b.demandScore - a.demandScore);

  const accumulation = results
    .filter((r) => r.stage === "ACCUMULATION_ZONE")
    .sort((a, b) => b.score - a.score);

  const all = [...demand, ...accumulation];

  const now = new Date().toISOString();

  const header = [
    `🛰 GATE.IO | ACCUMULATION RADAR V3`,
    `━━━━━━━━━━━━━━━━━━`,
    `⏱ Timeframe: ${CONFIG.INTERVAL}`,
    `🕒 UTC: ${now}`,
    ``,
    `📊 MARKET SCAN`,
    `Total Contracts: ${stats.totalContracts}`,
    `Eligible Contracts: ${stats.eligibleContracts}`,
    `Checked: ${stats.checked}`,
    `Failed: ${stats.failed}`,
    `Insufficient History: ${stats.insufficient}`,
    ``,
    `🎯 DETECTION RESULTS`,
    `🟡 Accumulation Zones: ${accumulation.length}`,
    `🟢 Demand Building: ${demand.length}`,
    `📦 Total Candidates: ${all.length}`,
    ``,
    `⚠️ Scores are ranking scores, not probabilities.`,
    `⚠️ These are monitoring alerts, not buy signals.`,
    `━━━━━━━━━━━━━━━━━━`,
    ``
  ].join("\n");

  let body = "";

  all.forEach((item, index) => {
    body += formatResult(item, index + 1);
  });

  if (!all.length) {
    body = "No valid accumulation zones detected in this scan.\n";
  }

  let errorSection = "";

  if (stats.errors.length) {
    errorSection = [
      ``,
      `⚠️ ERROR SAMPLES`,
      ...stats.errors.slice(0, 12).map(
        (e) => `${e.contract}: ${e.error}`
      ),
    ].join("\n");
  }

  return header + body + errorSection;
}

// =========================================================
// MAIN
// =========================================================

async function main() {
  console.log("Starting Accumulation Radar V3...");

  const [allContracts, tickers] =
    await Promise.all([
      getContracts(),
      getTickers(),
    ]);

  stats.totalContracts = allContracts.length;

  const contracts = allContracts.filter((c) =>
    c &&
    c.type === "direct" &&
    c.status === "trading" &&
    c.in_delisting !== true &&
    typeof c.name === "string" &&
    c.name.endsWith("_USDT")
  );

  stats.eligibleContracts = contracts.length;

  const tickerMap = new Map(
    tickers.map((t) => [t.contract, t])
  );

  console.log(
    `Eligible markets: ${contracts.length}`
  );

  const results = await processMarkets(
    contracts,
    tickerMap
  );

  const report = buildReport(results);

  const messages = splitMessages(
    report,
    CONFIG.TELEGRAM_MAX_LENGTH
  );

  for (let i = 0; i < messages.length; i++) {
    const message =
      messages.length > 1
        ? `📄 Report ${i + 1}/${messages.length}\n\n${messages[i]}`
        : messages[i];

    await sendTelegram(message);

    await sleep(350);
  }

  console.log("=================================");
  console.log("SCAN COMPLETED");
  console.log(`Contracts: ${stats.totalContracts}`);
  console.log(`Eligible: ${stats.eligibleContracts}`);
  console.log(`Checked: ${stats.checked}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Candidates: ${results.length}`);
  console.log(`Accumulation: ${stats.accumulationZones}`);
  console.log(`Demand Building: ${stats.demandBuilding}`);
  console.log("=================================");
}

main().catch(async (error) => {
  console.error("FATAL ERROR:", error);

  try {
    await sendTelegram(
      `🚨 ACCUMULATION RADAR V3 FAILED\n\n${String(error.message || error)}`
    );
  } catch (telegramError) {
    console.error(
      "Telegram failure:",
      telegramError.message
    );
  }

  process.exitCode = 1;
});
