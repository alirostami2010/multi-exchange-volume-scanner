
/**
 * GATE.IO USDT PERPETUAL
 * HISTORICAL ACCUMULATION RADAR — V4
 * =========================================================
 *
 * MAIN OBJECTIVE:
 * Find accumulation structures BEFORE major bullish moves.
 *
 * TIMEFRAME: 4H
 * HISTORY: Up to 1000 closed candles (~166 days)
 *
 * DETECTION:
 * 1. Historical rolling-window scan
 * 2. Accumulation zone detection
 * 3. Demand building detection
 * 4. Breakout detection
 * 5. Breakdown detection
 * 6. Historical zone deduplication
 *
 * NO TOP 20 / TOP 50 LIMIT.
 *
 * IMPORTANT:
 * Scores are technical ranking scores, NOT probabilities.
 * This is a research and monitoring scanner, NOT a buy signal.
 *
 * Node.js 20+
 */

// =========================================================
// CONFIGURATION
// =========================================================

const CONFIG = {
  BASE_URL: "https://api.gateio.ws/api/v4",

  INTERVAL: "4h",
  INTERVAL_SECONDS: 4 * 60 * 60,

  // Gate API maximum is 2000 points per request.
  CANDLE_LIMIT: 1000,

  // Rolling-window scan
  BASE_WINDOWS: [18, 24, 30, 36],
  SCAN_STEP: 3,

  DECLINE_LOOKBACK: 100,

  MIN_CANDLES: 120,

  MIN_DECLINE_PCT: 8,
  MAX_DECLINE_PCT: 70,

  MAX_BASE_WIDTH_PCT: 22,

  MIN_24H_TURNOVER: 200000,

  MIN_ZONE_SCORE: 58,
  MIN_DEMAND_SCORE: 70,

  // API protection
  CONCURRENCY: 3,
  MIN_REQUEST_INTERVAL_MS: 250,
  RETRIES: 5,
  RETRY_BASE_MS: 2000,
  REQUEST_TIMEOUT: 20000,

  // Historical zone classification
  ACTIVE_ZONE_MAX_AGE: 6,
  BREAKOUT_CONFIRM_PCT: 0.5,
  BREAKDOWN_CONFIRM_PCT: 0.5,

  // Merge overlapping detections
  MIN_TIME_OVERLAP: 0.55,

  TELEGRAM_MAX_LENGTH: 3500,
};

// =========================================================
// TELEGRAM SECRETS
// =========================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

// =========================================================
// STATISTICS
// =========================================================

const stats = {
  totalContracts: 0,
  eligibleContracts: 0,

  checked: 0,
  failed: 0,
  insufficient: 0,
  lowTurnover: 0,

  rawDetections: 0,
  uniqueZones: 0,

  activeZones: 0,
  demandBuilding: 0,
  breakouts: 0,
  breakdowns: 0,
  historicalZones: 0,

  errors: [],
};

// =========================================================
// UTILITIES
// =========================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function num(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function avg(values) {
  if (!values.length) return 0;

  return values.reduce((a, b) => a + b, 0) /
    values.length;
}

function total(values) {
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

function pct(value) {
  return `${value.toFixed(2)}%`;
}

function formatPrice(value) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 10,
  });
}

function formatMoney(value) {
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }

  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }

  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)}K`;
  }

  return value.toFixed(0);
}

function median(values) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function safeError(error) {
  return String(error?.message || error).slice(0, 220);
}

// =========================================================
// GLOBAL REQUEST PACER
// =========================================================

let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();

  const wait = Math.max(0, nextRequestAt - now);

  if (wait > 0) {
    await sleep(wait);
  }

  nextRequestAt =
    Date.now() + CONFIG.MIN_REQUEST_INTERVAL_MS;
}

// =========================================================
// HTTP WITH 429 RETRIES
// =========================================================

async function request(url) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= CONFIG.RETRIES;
    attempt++
  ) {
    try {
      await waitForRequestSlot();

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(
          CONFIG.REQUEST_TIMEOUT
        ),
      });

      if (response.status === 429) {
        const retryAfter =
          Number(response.headers.get("Retry-After")) || 0;

        const waitMs = Math.max(
          retryAfter * 1000,
          CONFIG.RETRY_BASE_MS * Math.pow(2, attempt - 1)
        );

        lastError = new Error(
          `HTTP 429: rate limit exceeded`
        );

        console.warn(
          `429 received. Waiting ${waitMs}ms`
        );

        await sleep(waitMs);

        // Slow down subsequent requests globally.
        nextRequestAt = Math.max(
          nextRequestAt,
          Date.now() + 500
        );

        continue;
      }

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
        const waitMs =
          CONFIG.RETRY_BASE_MS * Math.pow(2, attempt - 1);

        await sleep(waitMs);
      }
    }
  }

  throw lastError || new Error("Request failed");
}

// =========================================================
// GATE.IO API
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

async function getCandles(contractName) {
  const url = new URL(
    `${CONFIG.BASE_URL}/futures/usdt/candlesticks`
  );

  url.searchParams.set("contract", contractName);
  url.searchParams.set("interval", CONFIG.INTERVAL);
  url.searchParams.set(
    "limit",
    String(CONFIG.CANDLE_LIMIT)
  );

  const data = await request(url.toString());

  if (!Array.isArray(data)) {
    throw new Error("Invalid candle response");
  }

  const unique = new Map();

  for (const c of data) {
    const candle = {
      time: num(c.t),
      open: num(c.o),
      high: num(c.h),
      low: num(c.l),
      close: num(c.c),
      volume: num(c.v),
      turnover: num(c.sum),
    };

    if (
      candle.time > 0 &&
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0 &&
      candle.high >= candle.low
    ) {
      unique.set(candle.time, candle);
    }
  }

  const candles = [...unique.values()]
    .sort((a, b) => a.time - b.time);

  // Exclude the currently forming candle.
  const currentBucket =
    Math.floor(
      Date.now() / 1000 / CONFIG.INTERVAL_SECONDS
    ) * CONFIG.INTERVAL_SECONDS;

  return candles.filter(
    (c) => c.time < currentBucket
  );
}

// =========================================================
// CANDLE FEATURES
// =========================================================

function getCandleFeatures(c) {
  const range = Math.max(0, c.high - c.low);

  const lowerWick =
    Math.min(c.open, c.close) - c.low;

  const upperWick =
    c.high - Math.max(c.open, c.close);

  return {
    range,

    green: c.close > c.open,
    red: c.close < c.open,

    lowerWickRatio:
      range > 0 ? lowerWick / range : 0,

    closeLocation:
      range > 0 ? (c.close - c.low) / range : 0.5,
  };
}

// =========================================================
// PREVIOUS DECLINE DETECTION
// =========================================================

function findPreviousDecline(candles, baseStart) {
  const historyStart = Math.max(
    0,
    baseStart - CONFIG.DECLINE_LOOKBACK
  );

  const history = candles.slice(
    historyStart,
    baseStart
  );

  if (history.length < 12) {
    return null;
  }

  let peakIndex = -1;
  let peakPrice = 0;

  for (let i = 0; i < history.length; i++) {
    if (history[i].high > peakPrice) {
      peakPrice = history[i].high;
      peakIndex = i;
    }
  }

  if (peakIndex < 0) return null;

  const afterPeak = history.slice(peakIndex + 1);

  if (afterPeak.length < 8) {
    return null;
  }

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
// ANALYZE ONE HISTORICAL WINDOW
// =========================================================

function analyzeWindow(
  candles,
  ticker,
  baseStart,
  windowSize
) {
  const baseEnd = baseStart + windowSize;

  if (baseEnd > candles.length) {
    return null;
  }

  const base = candles.slice(
    baseStart,
    baseEnd
  );

  if (base.length !== windowSize) {
    return null;
  }

  const decline = findPreviousDecline(
    candles,
    baseStart
  );

  if (!decline) return null;

  const highs = base.map((c) => c.high);
  const lows = base.map((c) => c.low);

  const zoneHigh = max(highs);
  const zoneLow = min(lows);

  if (zoneLow <= 0 || zoneHigh <= zoneLow) {
    return null;
  }

  const zoneMid = (zoneHigh + zoneLow) / 2;

  const widthPct =
    ((zoneHigh - zoneLow) / zoneMid) * 100;

  if (widthPct > CONFIG.MAX_BASE_WIDTH_PCT) {
    return null;
  }

  // -------------------------------------------------------
  // FLOOR STRUCTURE
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

  // Stable floor means the second half has not
  // materially broken below the first-half floor.
  const floorStable =
    floorChangePct >= -2.5;

  // Higher-low using averages of recent lows.
  const priorLows = base
    .slice(-12, -6)
    .map((c) => c.low);

  const recentLows = base
    .slice(-6)
    .map((c) => c.low);

  const higherLows =
    avg(recentLows) >
    avg(priorLows) * 1.005;

  // -------------------------------------------------------
  // VOLUME
  // -------------------------------------------------------

  const firstVolume = avg(
    firstHalf.map((c) => c.turnover)
  );

  const secondVolume = avg(
    secondHalf.map((c) => c.turnover)
  );

  const volumeTrend =
    firstVolume > 0
      ? secondVolume / firstVolume
      : 1;

  const greenTurnover = total(
    base
      .filter((c) => c.close > c.open)
      .map((c) => c.turnover)
  );

  const redTurnover = total(
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

  const greenCount = base.filter(
    (c) => c.close > c.open
  ).length;

  const greenRatio =
    greenCount / windowSize;

  // -------------------------------------------------------
  // VOLATILITY CONTRACTION
  // -------------------------------------------------------

  const baseRange = avg(
    base.map((c) => c.high - c.low)
  );

  const previousCandles = candles.slice(
    Math.max(0, baseStart - 24),
    baseStart
  );

  if (previousCandles.length < 12) {
    return null;
  }

  const previousRange = avg(
    previousCandles.map(
      (c) => c.high - c.low
    )
  );

  const volatilityRatio =
    previousRange > 0
      ? baseRange / previousRange
      : 1;

  // -------------------------------------------------------
  // PRICE POSITION
  // -------------------------------------------------------

  const lastBaseClose =
    base[base.length - 1].close;

  const closePosition =
    (lastBaseClose - zoneLow) /
    (zoneHigh - zoneLow);

  const recentCloseAverage = avg(
    base.slice(-6).map((c) => c.close)
  );

  const recentCloseStrength =
    recentCloseAverage > zoneMid;

  // -------------------------------------------------------
  // RECENT VOLUME EXPANSION
  // -------------------------------------------------------

  const recentVolume = avg(
    base.slice(-6).map((c) => c.turnover)
  );

  const previousRecentVolume = avg(
    base.slice(-12, -6).map(
      (c) => c.turnover
    )
  );

  const recentVolumeExpansion =
    previousRecentVolume > 0
      ? recentVolume / previousRecentVolume
      : 1;

  // -------------------------------------------------------
  // LOWER WICK / REJECTION
  // -------------------------------------------------------

  const features = base.map(
    getCandleFeatures
  );

  const lowerWickRatio = avg(
    features.map((f) => f.lowerWickRatio)
  );

  const rejectionCount = features.filter(
    (f) =>
      f.lowerWickRatio >= 0.35 &&
      f.closeLocation >= 0.55
  ).length;

  const rejectionRatio =
    rejectionCount / windowSize;

  // -------------------------------------------------------
  // ZONE SCORE — MAX 100
  // -------------------------------------------------------

  let score = 0;

  // Previous decline: 15
  score += clamp(
    ((decline.declinePct - 8) / 42) * 15,
    0,
    15
  );

  // Base compression: 20
  score += clamp(
    ((22 - widthPct) / 22) * 20,
    0,
    20
  );

  // Floor structure: 20
  if (floorStable) score += 12;
  if (higherLows) score += 8;

  // Volume behavior: 15
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

  // Volatility: 10
  if (volatilityRatio < 0.65) {
    score += 10;
  } else if (volatilityRatio < 0.85) {
    score += 7;
  } else if (volatilityRatio < 1) {
    score += 4;
  }

  // Rejection: 10
  if (rejectionRatio >= 0.25) {
    score += 6;
  } else if (rejectionRatio >= 0.15) {
    score += 4;
  }

  if (lowerWickRatio >= 0.25) {
    score += 4;
  }

  // Price strength: 10
  if (closePosition >= 0.75) {
    score += 6;
  } else if (closePosition >= 0.55) {
    score += 4;
  }

  if (recentCloseStrength) {
    score += 4;
  }

  score = Math.round(
    clamp(score, 0, 100)
  );

  // -------------------------------------------------------
  // HARD FILTERS
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
  // DEMAND SCORE
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

  // Demand must be supported by more than
  // a high score alone.
  const demandConditions =
    higherLows &&
    greenRedRatio >= 1.0 &&
    closePosition >= 0.55 &&
    (
      recentVolumeExpansion >= 1.2 ||
      greenRatio >= 0.65
    );

  const demandBuilding =
    demandScore >= CONFIG.MIN_DEMAND_SCORE &&
    demandConditions;

  return {
    startIndex: baseStart,
    endIndex: baseEnd - 1,

    startTime: base[0].time,
    endTime: base[base.length - 1].time,

    windowSize,

    score,
    demandScore,
    demandBuilding,

    zoneHigh,
    zoneLow,
    zoneMid,
    widthPct,

    declinePct: decline.declinePct,

    floorChangePct,
    floorStable,
    higherLows,

    greenRedRatio,
    volumeTrend,

    volatilityRatio,

    closePosition,
    recentVolumeExpansion,

    rejectionRatio,
    lowerWickRatio,

    greenRatio,

    turnover24h: num(
      ticker.volume_24h_quote ??
      ticker.volume_24h_usd ??
      ticker.volume_24h
    ),
  };
}

// =========================================================
// HISTORICAL ROLLING-WINDOW SCAN
// =========================================================

function scanAllHistoricalWindows(
  candles,
  ticker
) {
  const detections = [];

  const minWindow = Math.min(
    ...CONFIG.BASE_WINDOWS
  );

  const firstStart =
    CONFIG.DECLINE_LOOKBACK + 12;

  const lastStart =
    candles.length - minWindow;

  for (
    let start = firstStart;
    start <= lastStart;
    start += CONFIG.SCAN_STEP
  ) {
    for (const windowSize of CONFIG.BASE_WINDOWS) {
      if (start + windowSize > candles.length) {
        continue;
      }

      const result = analyzeWindow(
        candles,
        ticker,
        start,
        windowSize
      );

      if (result) {
        detections.push(result);
      }
    }
  }

  return detections;
}

// =========================================================
// OVERLAPPING ZONE DEDUPLICATION
// =========================================================

function timeOverlapRatio(a, b) {
  const intersection =
    Math.max(
      0,
      Math.min(a.endIndex, b.endIndex) -
      Math.max(a.startIndex, b.startIndex) + 1
    );

  const shorter = Math.min(
    a.endIndex - a.startIndex + 1,
    b.endIndex - b.startIndex + 1
  );

  return shorter > 0
    ? intersection / shorter
    : 0;
}

function priceOverlap(a, b) {
  const intersection =
    Math.max(
      0,
      Math.min(a.zoneHigh, b.zoneHigh) -
      Math.max(a.zoneLow, b.zoneLow)
    );

  const shorter = Math.min(
    a.zoneHigh - a.zoneLow,
    b.zoneHigh - b.zoneLow
  );

  return shorter > 0
    ? intersection / shorter
    : 0;
}

function deduplicateZones(detections) {
  const sorted = [...detections].sort(
    (a, b) => a.startIndex - b.startIndex
  );

  const unique = [];

  for (const candidate of sorted) {
    let duplicateIndex = -1;

    for (let i = 0; i < unique.length; i++) {
      const existing = unique[i];

      const timeOverlap =
        timeOverlapRatio(candidate, existing);

      const priceOverlapRatio =
        priceOverlap(candidate, existing);

      if (
        timeOverlap >= CONFIG.MIN_TIME_OVERLAP &&
        priceOverlapRatio >= 0.45
      ) {
        duplicateIndex = i;
        break;
      }
    }

    if (duplicateIndex === -1) {
      unique.push(candidate);
      continue;
    }

    const existing = unique[duplicateIndex];

    // Keep the best score, with demand as a tie-breaker.
    if (
      candidate.score > existing.score ||
      (
        candidate.score === existing.score &&
        candidate.demandScore > existing.demandScore
      )
    ) {
      unique[duplicateIndex] = candidate;
    }
  }

  return unique;
}

// =========================================================
// CLASSIFY HISTORICAL ZONE
// =========================================================

function classifyZone(zone, candles) {
  const lastIndex = candles.length - 1;

  const age =
    lastIndex - zone.endIndex;

  const afterZone = candles.slice(
    zone.endIndex + 1
  );

  let firstBreakoutIndex = -1;
  let firstBreakdownIndex = -1;

  const breakoutPrice =
    zone.zoneHigh *
    (1 + CONFIG.BREAKOUT_CONFIRM_PCT / 100);

  const breakdownPrice =
    zone.zoneLow *
    (1 - CONFIG.BREAKDOWN_CONFIRM_PCT / 100);

  for (let i = 0; i < afterZone.length; i++) {
    const close = afterZone[i].close;

    if (
      firstBreakoutIndex === -1 &&
      close > breakoutPrice
    ) {
      firstBreakoutIndex = i;
    }

    if (
      firstBreakdownIndex === -1 &&
      close < breakdownPrice
    ) {
      firstBreakdownIndex = i;
    }
  }

  let status = "HISTORICAL";

  if (
    firstBreakoutIndex !== -1 &&
    (
      firstBreakdownIndex === -1 ||
      firstBreakoutIndex < firstBreakdownIndex
    )
  ) {
    status = "BREAKOUT";
  } else if (
    firstBreakdownIndex !== -1
  ) {
    status = "BREAKDOWN";
  } else if (
    age <= CONFIG.ACTIVE_ZONE_MAX_AGE
  ) {
    status = zone.demandBuilding
      ? "DEMAND_BUILDING"
      : "ACTIVE_ZONE";
  }

  const currentClose =
    candles[lastIndex].close;

  const breakoutReturnPct =
    (
      (currentClose - zone.zoneHigh) /
      zone.zoneHigh
    ) * 100;

  const ageHours =
    age * 4;

  return {
    ...zone,

    status,

    ageCandles: age,
    ageHours,

    currentClose,
    breakoutReturnPct,

    breakoutCandlesAfterZone:
      firstBreakoutIndex >= 0
        ? firstBreakoutIndex + 1
        : null,
  };
}

// =========================================================
// ANALYZE MARKET
// =========================================================

async function analyzeMarket(contract, ticker) {
  const turnover24h = num(
    ticker.volume_24h_quote ??
    ticker.volume_24h_usd ??
    ticker.volume_24h
  );

  if (turnover24h < CONFIG.MIN_24H_TURNOVER) {
    stats.lowTurnover++;
    return [];
  }

  const candles = await getCandles(contract.name);

  if (candles.length < CONFIG.MIN_CANDLES) {
    stats.insufficient++;
    return [];
  }

  const raw = scanAllHistoricalWindows(
    candles,
    ticker
  );

  stats.rawDetections += raw.length;

  if (!raw.length) return [];

  const unique = deduplicateZones(raw);

  return unique.map((zone) => ({
    contract: contract.name,
    lastPrice: candles[candles.length - 1].close,
    turnover24h,
    ...classifyZone(zone, candles),
  }));
}

// =========================================================
// PROCESS ALL MARKETS
// =========================================================

async function processMarkets(contracts, tickerMap) {
  const results = [];

  let index = 0;

  async function worker() {
    while (true) {
      const current = index++;

      if (current >= contracts.length) {
        return;
      }

      const contract = contracts[current];

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

        const zones = await analyzeMarket(
          contract,
          ticker
        );

        results.push(...zones);

        stats.checked++;

      } catch (error) {
        stats.failed++;

        stats.errors.push({
          contract: contract.name,
          error: safeError(error),
        });
      }

      if (stats.checked % 50 === 0) {
        console.log(
          `Progress: ${stats.checked}/${contracts.length} | ` +
          `Zones: ${results.length} | Failed: ${stats.failed}`
        );
      }
    }
  }

  const workers = Array.from(
    { length: CONFIG.CONCURRENCY },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

// =========================================================
// STATUS LABELS
// =========================================================

function statusLabel(status) {
  const labels = {
    ACTIVE_ZONE: "🟡 ACTIVE ACCUMULATION ZONE",
    DEMAND_BUILDING: "🟢 DEMAND BUILDING",
    BREAKOUT: "🚀 BREAKOUT CONFIRMED",
    BREAKDOWN: "🔴 ZONE BREAKDOWN",
    HISTORICAL: "📚 HISTORICAL ZONE",
  };

  return labels[status] || status;
}

// =========================================================
// RESULT FORMAT
// =========================================================

function formatZone(item, index) {
  return [
    `${index}. ${item.contract}`,
    statusLabel(item.status),
    `━━━━━━━━━━━━━━━━━━`,

    `⭐ Zone Score: ${item.score}/100`,
    `🔥 Demand Score: ${item.demandScore}/100`,

    ``,

    `💰 Current Price: ${formatPrice(item.lastPrice)}`,

    `🔻 Zone Low: ${formatPrice(item.zoneLow)}`,
    `🔺 Zone High: ${formatPrice(item.zoneHigh)}`,
    `📍 Zone Mid: ${formatPrice(item.zoneMid)}`,

    ``,

    `📦 Base Width: ${pct(item.widthPct)}`,
    `⏱ Base Duration: ${item.windowSize * 4} hours`,
    `📉 Previous Decline: ${pct(item.declinePct)}`,

    `🧱 Floor Change: ${pct(item.floorChangePct)}`,
    `📊 Green/Red Volume: ${item.greenRedRatio.toFixed(2)}`,
    `📉 Volume Trend: ${item.volumeTrend.toFixed(2)}`,
    `📐 Volatility Ratio: ${item.volatilityRatio.toFixed(2)}`,
    `📈 Recent Volume Expansion: ${item.recentVolumeExpansion.toFixed(2)}`,
    `🕯 Rejection Ratio: ${pct(item.rejectionRatio * 100)}`,

    ``,

    `🕒 Zone Start: ${new Date(item.startTime * 1000).toISOString()}`,
    `🕒 Zone End: ${new Date(item.endTime * 1000).toISOString()}`,

    `⌛ Age: ${item.ageHours} hours`,
    `💵 24H Turnover: ${formatMoney(item.turnover24h)} USDT`,

    item.status === "BREAKOUT"
      ? `🚀 Price vs Zone High: ${pct(item.breakoutReturnPct)}`
      : "",

    ``
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// =========================================================
// REPORT HEADER
// =========================================================

function buildHeader() {
  return [
    `🛰 GATE.IO | HISTORICAL ACCUMULATION RADAR V4`,
    `━━━━━━━━━━━━━━━━━━`,
    `⏱ Timeframe: 4H`,
    `📚 History: Up to ${CONFIG.CANDLE_LIMIT} candles`,
    `🕒 UTC: ${new Date().toISOString()}`,

    ``,

    `📊 MARKET SCAN`,
    `Total Contracts: ${stats.totalContracts}`,
    `Eligible: ${stats.eligibleContracts}`,
    `Checked: ${stats.checked}`,
    `Failed: ${stats.failed}`,
    `Insufficient History: ${stats.insufficient}`,
    `Low Turnover: ${stats.lowTurnover}`,

    ``,

    `🔎 HISTORICAL DETECTION`,
    `Raw Window Detections: ${stats.rawDetections}`,
    `Unique Zones: ${stats.uniqueZones}`,

    ``,

    `📌 ZONE STATUS`,
    `🟡 Active Zones: ${stats.activeZones}`,
    `🟢 Demand Building: ${stats.demandBuilding}`,
    `🚀 Breakouts: ${stats.breakouts}`,
    `🔴 Breakdowns: ${stats.breakdowns}`,
    `📚 Historical: ${stats.historicalZones}`,

    ``,

    `⚠️ Scores are ranking scores, not probabilities.`,
    `⚠️ Historical breakout does not mean a current entry.`,
    `⚠️ This scanner does not issue trading orders.`,

    `━━━━━━━━━━━━━━━━━━`,
    ``
  ].join("\n");
}

// =========================================================
// TELEGRAM MESSAGE CHUNKING
// =========================================================

function makeTelegramMessages(results) {
  const header = buildHeader();

  const errors = stats.errors.length
    ? [
        ``,
        `⚠️ ERROR SAMPLES`,
        ...stats.errors.slice(0, 10).map(
          (e) => `${e.contract}: ${e.error}`
        ),
      ].join("\n")
    : "";

  const ordered = [...results].sort((a, b) => {
    const rank = {
      DEMAND_BUILDING: 1,
      ACTIVE_ZONE: 2,
      BREAKOUT: 3,
      HISTORICAL: 4,
      BREAKDOWN: 5,
    };

    if (rank[a.status] !== rank[b.status]) {
      return rank[a.status] - rank[b.status];
    }

    return b.score - a.score;
  });

  const blocks = ordered.map(
    (item, index) => formatZone(item, index + 1)
  );

  const messages = [];

  let current = header;

  for (const block of blocks) {
    if (
      current.length + block.length + 5 >
      CONFIG.TELEGRAM_MAX_LENGTH
    ) {
      messages.push(current);
      current = "";
    }

    current += block + "\n";
  }

  if (current) {
    messages.push(current);
  }

  if (errors) {
    if (
      messages.length &&
      messages[messages.length - 1].length +
      errors.length <
      CONFIG.TELEGRAM_MAX_LENGTH
    ) {
      messages[messages.length - 1] += errors;
    } else {
      messages.push(errors);
    }
  }

  if (!messages.length) {
    messages.push(header + "No valid zones detected.");
  }

  return messages;
}

// =========================================================
// TELEGRAM DELIVERY
// =========================================================

async function sendTelegram(message) {
  if (
    !TELEGRAM_BOT_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    console.log("Telegram credentials missing.");
    console.log(message);
    return;
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    }),

    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram error: ${JSON.stringify(data).slice(0, 250)}`
    );
  }
}

async function sendReports(messages) {
  for (let i = 0; i < messages.length; i++) {
    const prefix =
      messages.length > 1
        ? `📄 Report ${i + 1}/${messages.length}\n\n`
        : "";

    await sendTelegram(prefix + messages[i]);

    await sleep(400);
  }
}

// =========================================================
// MAIN
// =========================================================

async function main() {
  console.log("====================================");
  console.log("ACCUMULATION RADAR V4 STARTED");
  console.log("====================================");

  const [contractsData, tickersData] =
    await Promise.all([
      getContracts(),
      getTickers(),
    ]);

  stats.totalContracts = contractsData.length;

  const contracts = contractsData.filter((c) =>
    c &&
    c.type === "direct" &&
    c.status === "trading" &&
    c.in_delisting !== true &&
    typeof c.name === "string" &&
    c.name.endsWith("_USDT")
  );

  stats.eligibleContracts = contracts.length;

  const tickerMap = new Map(
    tickersData.map((ticker) => [
      ticker.contract,
      ticker,
    ])
  );

  console.log(
    `Eligible markets: ${contracts.length}`
  );

  const results = await processMarkets(
    contracts,
    tickerMap
  );

  stats.uniqueZones = results.length;

  for (const result of results) {
    if (result.status === "ACTIVE_ZONE") {
      stats.activeZones++;
    } else if (result.status === "DEMAND_BUILDING") {
      stats.demandBuilding++;
    } else if (result.status === "BREAKOUT") {
      stats.breakouts++;
    } else if (result.status === "BREAKDOWN") {
      stats.breakdowns++;
    } else if (result.status === "HISTORICAL") {
      stats.historicalZones++;
    }
  }

  const reports = makeTelegramMessages(results);

  await sendReports(reports);

  console.log("====================================");
  console.log("SCAN COMPLETED");
  console.log(`Total: ${stats.totalContracts}`);
  console.log(`Eligible: ${stats.eligibleContracts}`);
  console.log(`Checked: ${stats.checked}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Raw detections: ${stats.rawDetections}`);
  console.log(`Unique zones: ${stats.uniqueZones}`);
  console.log(`Active: ${stats.activeZones}`);
  console.log(`Demand: ${stats.demandBuilding}`);
  console.log(`Breakouts: ${stats.breakouts}`);
  console.log(`Breakdowns: ${stats.breakdowns}`);
  console.log(`Historical: ${stats.historicalZones}`);
  console.log("====================================");
}

main().catch(async (error) => {
  console.error("FATAL ERROR:", error);

  try {
    await sendTelegram(
      `🚨 ACCUMULATION RADAR V4 FAILED\n\n${safeError(error)}`
    );
  } catch (telegramError) {
    console.error(
      "Telegram failure:",
      safeError(telegramError)
    );
  }

  process.exitCode = 1;
});
