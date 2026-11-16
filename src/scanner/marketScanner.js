
import { getMarketTickers, getKlines } from '../exchanges/gateio.js';

const BASE_URL = 'https://api.gateio.ws/api/v4';

const CONFIG = {
  MIN_TURNOVER_24H: 100000,
  CONCURRENCY: 5,
  DEEP_CONCURRENCY: 4,
  MAX_ORDERBOOK_CHECKS: 30,
  MAX_RESULTS: 20,

  CANDLE_LIMIT: 90,
  VOLUME_LOOKBACK: 20,

  MIN_DATA_COVERAGE: 65,
  MIN_FINAL_SCORE: 48,

  TIMEFRAMES: {
    weekly: { interval: '7d', seconds: 604800 },
    daily: { interval: '1d', seconds: 86400 },
    fourHour: { interval: '4h', seconds: 14400 },
    oneHour: { interval: '1h', seconds: 3600 },
    fifteenMinute: { interval: '15m', seconds: 900 },
    fiveMinute: { interval: '5m', seconds: 300 }
  },

  WEIGHTS: {
    volume: 20,
    absorption: 20,
    openInterest: 15,
    relativeStrength: 10,
    compression: 10,
    takerPressure: 10,
    structure: 10,
    liquidity: 5
  }
};

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const number = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const clamp = (value, min, max) =>
  Math.min(Math.max(value, min), max);

const average = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

const percentChange = (a, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return ((a - b) / b) * 100;
};

async function apiRequest(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Gate API ${response.status}: ${endpoint}`);
  }

  return response.json();
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runner()
    )
  );

  return results;
}

/* -------------------------------------------------------
   CANDLE DATA
------------------------------------------------------- */

function getClosedCandles(candles, intervalSeconds) {
  if (!Array.isArray(candles)) return [];

  const now = Math.floor(Date.now() / 1000);

  return candles
    .filter(candle => {
      const timestamp = number(candle[0]);

      return timestamp !== null &&
        timestamp + intervalSeconds <= now;
    })
    .map(candle => ({
      time: number(candle[0]),
      open: number(candle[1]),
      high: number(candle[2]),
      low: number(candle[3]),
      close: number(candle[4]),
      volume: number(candle[5]),
      turnover: number(candle[6])
    }))
    .filter(candle =>
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0 &&
      candle.high >= candle.low &&
      candle.turnover !== null &&
      candle.turnover >= 0
    )
    .sort((a, b) => a.time - b.time);
}

function analyzeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return null;
  }

  const current = candles[candles.length - 1];
  const previous = candles.slice(-21, -1);

  if (previous.length < 20) return null;

  const averageTurnover = average(
    previous.map(candle => candle.turnover)
  );

  if (averageTurnover <= 0) return null;

  const volumeRatio = current.turnover / averageTurnover;

  const recent = candles.slice(-5);
  const older = candles.slice(-10, -5);

  const recentVolume = average(
    recent.map(candle => candle.turnover)
  );

  const olderVolume = average(
    older.map(candle => candle.turnover)
  );

  const volumeTrend = olderVolume > 0
    ? recentVolume / olderVolume
    : 1;

  const priceChange = percentChange(
    current.close,
    candles[candles.length - 2].close
  );

  const body = Math.abs(current.close - current.open);
  const range = current.high - current.low;

  const bodyRatio = range > 0 ? body / range : 0;

  const closePosition = range > 0
    ? (current.close - current.low) / range
    : 0.5;

  const risingSteps = recent.filter(
    (candle, index) =>
      index > 0 &&
      candle.turnover > recent[index - 1].turnover
  ).length;

  const volumeSpike = volumeRatio >= 2;
  const gradualGrowth =
    volumeTrend >= 1.25 && risingSteps >= 2;

  const priceStable =
    priceChange !== null &&
    Math.abs(priceChange) <= 1.5;

  const absorptionCandidate =
    volumeRatio >= 1.5 &&
    priceStable &&
    closePosition >= 0.45;

  const buyPressure =
    closePosition * 100;

  return {
    candles,
    current,
    volumeRatio,
    volumeTrend,
    risingSteps,
    volumeSpike,
    gradualGrowth,
    absorptionCandidate,
    priceChange,
    bodyRatio,
    closePosition,
    buyPressure
  };
}

async function getTimeframeAnalysis(symbol, timeframe) {
  const config = CONFIG.TIMEFRAMES[timeframe];

  const raw = await getKlines(
    symbol,
    config.interval,
    CONFIG.CANDLE_LIMIT
  );

  const candles = getClosedCandles(
    raw,
    config.seconds
  );

  const analysis = analyzeCandles(candles);

  return analysis
    ? { ...analysis, timeframe }
    : null;
}

/* -------------------------------------------------------
   PRICE STRUCTURE
------------------------------------------------------- */

function getStructure(candles) {
  if (!candles || candles.length < 20) {
    return null;
  }

  const recent = candles.slice(-10);
  const older = candles.slice(-20, -10);

  const recentLow = Math.min(
    ...recent.map(candle => candle.low)
  );

  const olderLow = Math.min(
    ...older.map(candle => candle.low)
  );

  const recentHigh = Math.max(
    ...recent.map(candle => candle.high)
  );

  const olderHigh = Math.max(
    ...older.map(candle => candle.high)
  );

  const current = candles[candles.length - 1];

  const higherLow = recentLow > olderLow;
  const higherHigh = recentHigh > olderHigh;

  const resistance = olderHigh;
  const support = recentLow;

  const distanceToResistance =
    resistance > 0
      ? ((resistance - current.close) / current.close) * 100
      : null;

  const reclaimedLow =
    current.close > olderLow &&
    recentLow < olderLow;

  return {
    higherLow,
    higherHigh,
    reclaimedLow,
    support,
    resistance,
    distanceToResistance,
    breakout:
      current.close > resistance &&
      current.close > current.open
  };
}

/* -------------------------------------------------------
   VOLATILITY COMPRESSION
------------------------------------------------------- */

function getCompression(candles) {
  if (!candles || candles.length < 30) return null;

  const recent = candles.slice(-10);
  const previous = candles.slice(-30, -10);

  const recentRanges = recent.map(candle =>
    candle.high - candle.low
  );

  const previousRanges = previous.map(candle =>
    candle.high - candle.low
  );

  const recentAverage = average(recentRanges);
  const previousAverage = average(previousRanges);

  if (previousAverage <= 0) return null;

  const ratio = recentAverage / previousAverage;

  return {
    ratio,
    compressed: ratio <= 0.75
  };
}

/* -------------------------------------------------------
   RELATIVE STRENGTH AGAINST BTC
------------------------------------------------------- */

function getRelativeStrength(
  assetCandles,
  btcCandles,
  lookback = 4
) {
  if (
    !assetCandles ||
    !btcCandles ||
    assetCandles.length <= lookback ||
    btcCandles.length <= lookback
  ) {
    return null;
  }

  const assetNow =
    assetCandles[assetCandles.length - 1].close;

  const assetBefore =
    assetCandles[assetCandles.length - 1 - lookback].close;

  const btcNow =
    btcCandles[btcCandles.length - 1].close;

  const btcBefore =
    btcCandles[btcCandles.length - 1 - lookback].close;

  const assetChange = percentChange(assetNow, assetBefore);
  const btcChange = percentChange(btcNow, btcBefore);

  if (assetChange === null || btcChange === null) {
    return null;
  }

  return {
    assetChange,
    btcChange,
    relativeStrength: assetChange - btcChange
  };
}

/* -------------------------------------------------------
   GATE.IO CONTRACT STATISTICS
------------------------------------------------------- */

async function getContractStats(symbol) {
  const params = new URLSearchParams({
    contract: symbol,
    interval: '5m',
    limit: '2'
  });

  try {
    const result = await apiRequest(
      `/futures/usdt/contract_stats?${params}`
    );

    if (!Array.isArray(result) || !result.length) {
      return null;
    }

    const sorted = result
      .filter(item => number(item.time) !== null)
      .sort((a, b) => number(a.time) - number(b.time));

    if (!sorted.length) return null;

    const latest = sorted[sorted.length - 1];
    const previous = sorted.length > 1
      ? sorted[sorted.length - 2]
      : null;

    const oi = number(latest.open_interest_usd);
    const oldOi = previous
      ? number(previous.open_interest_usd)
      : null;

    const oiChange =
      oi !== null && oldOi !== null && oldOi > 0
        ? percentChange(oi, oldOi)
        : null;

    const longTaker = number(latest.long_taker_size);
    const shortTaker = number(latest.short_taker_size);

    const takerRatio =
      longTaker !== null &&
      shortTaker !== null &&
      longTaker + shortTaker > 0
        ? longTaker / (longTaker + shortTaker)
        : null;

    return {
      openInterest: oi,
      openInterestChange: oiChange,
      takerRatio,
      longShortTakerRatio: number(latest.lsr_taker),
      longLiquidation: number(latest.long_liq_usd_new),
      shortLiquidation: number(latest.short_liq_usd_new),
      timestamp: number(latest.time)
    };
  } catch (error) {
    return null;
  }
}

/* -------------------------------------------------------
   ORDER BOOK
------------------------------------------------------- */

async function getOrderBook(symbol) {
  try {
    const params = new URLSearchParams({
      contract: symbol,
      limit: '20'
    });

    const book = await apiRequest(
      `/futures/usdt/order_book?${params}`
    );

    if (
      !Array.isArray(book.bids) ||
      !Array.isArray(book.asks) ||
      !book.bids.length ||
      !book.asks.length
    ) {
      return null;
    }

    const bidValue = book.bids.reduce(
      (sum, item) =>
        sum + number(item.p) * number(item.s),
      0
    );

    const askValue = book.asks.reduce(
      (sum, item) =>
        sum + number(item.p) * number(item.s),
      0
    );

    const total = bidValue + askValue;

    return {
      bidValue,
      askValue,
      imbalance: total > 0
        ? bidValue / total
        : null,
      spread: (
        (number(book.asks[0].p) -
          number(book.bids[0].p)) /
        number(book.bids[0].p)
      ) * 100,
      timestamp: number(book.current)
    };
  } catch (error) {
    return null;
  }
}

/* -------------------------------------------------------
   SCORING
------------------------------------------------------- */

function calculateScore(metrics) {
  const weights = CONFIG.WEIGHTS;

  const components = {
    volume: null,
    absorption: null,
    openInterest: null,
    relativeStrength: null,
    compression: null,
    takerPressure: null,
    structure: null,
    liquidity: null
  };

  const fourHour = metrics.fourHour;
  const oneHour = metrics.oneHour;
  const fifteen = metrics.fifteenMinute;
  const five = metrics.fiveMinute;
  const structure = metrics.structure;
  const oi = metrics.stats;
  const relative = metrics.relativeStrength;
  const compression = metrics.compression;

  const volumeRatios = [
    fourHour?.volumeRatio,
    oneHour?.volumeRatio,
    fifteen?.volumeRatio
  ].filter(value => value !== undefined && value !== null);

  if (volumeRatios.length) {
    const maxRatio = Math.max(...volumeRatios);

    components.volume = clamp(
      ((maxRatio - 1) / 3) * 100,
      0,
      100
    );
  }

  if (oneHour && fifteen) {
    let absorptionScore = 0;

    if (oneHour.absorptionCandidate) {
      absorptionScore += 55;
    }

    if (fifteen.absorptionCandidate) {
      absorptionScore += 30;
    }

    if (
      oneHour.current.close >= oneHour.current.open &&
      oneHour.closePosition >= 0.55
    ) {
      absorptionScore += 15;
    }

    components.absorption = clamp(
      absorptionScore,
      0,
      100
    );
  }

  if (oi?.openInterestChange !== null &&
      oi?.openInterestChange !== undefined) {
    const change = oi.openInterestChange;

    components.openInterest = change > 0
      ? clamp(50 + change * 10, 0, 100)
      : clamp(50 + change * 5, 0, 50);
  }

  if (relative) {
    components.relativeStrength = clamp(
      50 + relative.relativeStrength * 5,
      0,
      100
    );
  }

  if (compression) {
    components.compression = compression.compressed
      ? 90
      : clamp(100 - compression.ratio * 60, 0, 100);
  }

  if (oi?.takerRatio !== null &&
      oi?.takerRatio !== undefined) {
    components.takerPressure = clamp(
      oi.takerRatio * 100,
      0,
      100
    );
  }

  if (structure) {
    let structureScore = 0;

    if (structure.higherLow) structureScore += 35;
    if (structure.higherHigh) structureScore += 25;
    if (structure.reclaimedLow) structureScore += 20;
    if (structure.breakout) structureScore += 20;

    components.structure = structureScore;
  }

  if (metrics.turnover24h !== null) {
    components.liquidity = clamp(
      (Math.log10(Math.max(metrics.turnover24h, 1)) - 4) * 25,
      0,
      100
    );
  }

  let availableWeight = 0;
  let weightedScore = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const value = components[key];

    if (value === null || !Number.isFinite(value)) {
      continue;
    }

    availableWeight += weight;
    weightedScore += (value / 100) * weight;
  }

  const coverage = availableWeight;

  const score = availableWeight > 0
    ? (weightedScore / availableWeight) * 100
    : 0;

  return {
    score: Math.round(score),
    coverage,
    components
  };
}

/* -------------------------------------------------------
   CLASSIFICATION
------------------------------------------------------- */

function classifyOpportunity(metrics, score) {
  const fourHour = metrics.fourHour;
  const oneHour = metrics.oneHour;
  const fifteen = metrics.fifteenMinute;
  const five = metrics.fiveMinute;
  const structure = metrics.structure;

  if (
    !fourHour ||
    !oneHour ||
    !fifteen ||
    !five ||
    !structure
  ) {
    return null;
  }

  const higherTimeframeBullish =
    fourHour.current.close > fourHour.current.open ||
    structure.higherLow;

  const volumeActivity =
    fifteen.volumeRatio >= 1.5 ||
    oneHour.volumeRatio >= 1.5;

  const early =
    higherTimeframeBullish &&
    volumeActivity &&
    (oneHour.absorptionCandidate ||
      fifteen.absorptionCandidate ||
      metrics.compression?.compressed) &&
    !structure.breakout;

  const momentum =
    higherTimeframeBullish &&
    fifteen.volumeRatio >= 1.8 &&
    fifteen.current.close > fifteen.current.open &&
    five.current.close > five.current.open &&
    five.closePosition >= 0.55;

  const breakout =
    structure.breakout &&
    oneHour.volumeRatio >= 1.5 &&
    fifteen.volumeRatio >= 1.5 &&
    fifteen.closePosition >= 0.65;

  if (breakout && score >= 55) {
    return 'BREAKOUT CONFIRMED';
  }

  if (momentum && score >= 52) {
    return 'MOMENTUM START';
  }

  if (early && score >= 48) {
    return 'EARLY ACCUMULATION CANDIDATE';
  }

  return null;
}

/* -------------------------------------------------------
   TRADE PLAN
------------------------------------------------------- */

function buildTradePlan(metrics) {
  const candles = metrics.oneHour?.candles;

  if (!candles || candles.length < 20) return null;

  const current = candles[candles.length - 1];

  const recent = candles.slice(-20);

  const support = Math.min(
    ...recent.map(candle => candle.low)
  );

  const resistance = Math.max(
    ...recent.slice(0, -1).map(candle => candle.high)
  );

  const invalidation = support * 0.995;

  const entry = current.close;

  const risk = entry - invalidation;

  if (risk <= 0) return null;

  const target1 = entry + risk * 1.5;
  const target2 = entry + risk * 2;
  const target3 = entry + risk * 3;

  const resistanceDistance =
    resistance > entry
      ? ((resistance - entry) / entry) * 100
      : null;

  return {
    referenceEntry: entry,
    invalidation,
    support,
    resistance,
    resistanceDistance,
    target1,
    target2,
    target3,
    riskReward: {
      target1: 1.5,
      target2: 2,
      target3: 3
    }
  };
}

/* -------------------------------------------------------
   DEEP SYMBOL ANALYSIS
------------------------------------------------------- */

async function analyzeSymbol(symbol, ticker, btcData) {
  try {
    const timeframeNames = Object.keys(CONFIG.TIMEFRAMES);

    const timeframeResults = await Promise.all(
      timeframeNames.map(async name => {
        const result = await getTimeframeAnalysis(
          symbol,
          name
        );

        await sleep(80);

        return [name, result];
      })
    );

    const timeframes = Object.fromEntries(
      timeframeResults
    );

    const {
      weekly,
      daily,
      fourHour,
      oneHour,
      fifteenMinute,
      fiveMinute
    } = timeframes;

    if (
      !weekly ||
      !daily ||
      !fourHour ||
      !oneHour ||
      !fifteenMinute ||
      !fiveMinute
    ) {
      return null;
    }

    const structure = getStructure(
      fourHour.candles
    );

    const compression = getCompression(
      oneHour.candles
    );

    const relativeStrength = getRelativeStrength(
      oneHour.candles,
      btcData.oneHour.candles,
      4
    );

    const stats = await getContractStats(symbol);

    const metrics = {
      weekly,
      daily,
      fourHour,
      oneHour,
      fifteenMinute,
      fiveMinute,
      structure,
      compression,
      relativeStrength,
      stats,
      turnover24h: ticker.turnover24h
    };

    const scoring = calculateScore(metrics);

    if (scoring.coverage < CONFIG.MIN_DATA_COVERAGE) {
      return null;
    }

    if (scoring.score < CONFIG.MIN_FINAL_SCORE) {
      return null;
    }

    const status = classifyOpportunity(
      metrics,
      scoring.score
    );

    if (!status) return null;

    const tradePlan = buildTradePlan(metrics);

    if (!tradePlan) return null;

    const fundingRate = number(ticker.fundingRate);

    const fundingRisk =
      fundingRate !== null &&
      fundingRate > 0.001
        ? 'HIGH POSITIVE FUNDING'
        : fundingRate !== null &&
          fundingRate < -0.001
          ? 'NEGATIVE FUNDING'
          : 'NORMAL';

    return {
      symbol,
      status,
      score: scoring.score,
      dataCoverage: scoring.coverage,

      price: ticker.price,
      change24h: ticker.change24h,
      turnover24h: ticker.turnover24h,

      fundingRate,
      fundingRisk,

      volume: {
        fourHour: fourHour.volumeRatio,
        oneHour: oneHour.volumeRatio,
        fifteenMinute: fifteenMinute.volumeRatio,
        fiveMinute: fiveMinute.volumeRatio
      },

      openInterest: stats?.openInterest ?? null,
      openInterestChange: stats?.openInterestChange ?? null,

      takerRatio: stats?.takerRatio ?? null,
      longShortTakerRatio:
        stats?.longShortTakerRatio ?? null,

      longLiquidation: stats?.longLiquidation ?? null,
      shortLiquidation: stats?.shortLiquidation ?? null,

      relativeStrength,
      compression,
      structure,

      tradePlan,

      timeframeChanges: {
        weekly: percentChange(
          weekly.current.close,
          weekly.candles.at(-2).close
        ),

        daily: percentChange(
          daily.current.close,
          daily.candles.at(-2).close
        ),

        fourHour: percentChange(
          fourHour.current.close,
          fourHour.candles.at(-2).close
        ),

        oneHour: percentChange(
          oneHour.current.close,
          oneHour.candles.at(-2).close
        ),

        fifteenMinute: percentChange(
          fifteenMinute.current.close,
          fifteenMinute.candles.at(-2).close
        ),

        fiveMinute: percentChange(
          fiveMinute.current.close,
          fiveMinute.candles.at(-2).close
        )
      },

      scoring: scoring.components,

      analyzedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`${symbol}: ${error.message}`);
    return null;
  }
}

/* -------------------------------------------------------
   MARKET SCREENING
------------------------------------------------------- */

function prepareMarkets(tickers) {
  return tickers
    .filter(ticker =>
      ticker.symbol.endsWith('_USDT') &&
      Number.isFinite(ticker.price) &&
      ticker.price > 0 &&
      Number.isFinite(ticker.turnover24h) &&
      ticker.turnover24h >= CONFIG.MIN_TURNOVER_24H
    )
    .sort((a, b) =>
      b.turnover24h - a.turnover24h
    );
}

/* -------------------------------------------------------
   OUTPUT
------------------------------------------------------- */

function formatPercent(value) {
  return value === null || value === undefined
    ? 'N/A'
    : `${Number(value).toFixed(2)}%`;
}

function printOpportunity(item, index) {
  console.log('\n======================================');
  console.log(`RANK: ${index + 1}`);
  console.log(`SYMBOL: ${item.symbol}`);
  console.log(`STATUS: ${item.status}`);
  console.log(`SCORE: ${item.score}/100`);
  console.log(`DATA COVERAGE: ${item.dataCoverage}%`);

  console.log('--------------------------------------');

  console.log(`Price: ${item.price}`);
  console.log(`24H Change: ${formatPercent(item.change24h)}`);
  console.log(`24H Turnover: ${item.turnover24h}`);

  console.log('--------------------------------------');

  console.log('TIMEFRAME CHANGES:');

  for (const [name, value] of Object.entries(
    item.timeframeChanges
  )) {
    console.log(`${name}: ${formatPercent(value)}`);
  }

  console.log('--------------------------------------');

  console.log('VOLUME RATIOS:');

  for (const [name, value] of Object.entries(
    item.volume
  )) {
    console.log(`${name}: ${value.toFixed(2)}x`);
  }

  console.log('--------------------------------------');

  console.log(`OI: ${item.openInterest ?? 'N/A'}`);
  console.log(
    `OI Change: ${formatPercent(item.openInterestChange)}`
  );

  console.log(`Taker Ratio: ${item.takerRatio ?? 'N/A'}`);
  console.log(
    `Long/Short Taker Ratio: ${
      item.longShortTakerRatio ?? 'N/A'
    }`
  );

  console.log(
    `Funding: ${
      item.fundingRate === null
        ? 'N/A'
        : (item.fundingRate * 100).toFixed(4) + '%'
    }`
  );

  console.log(`Funding Risk: ${item.fundingRisk}`);

  console.log('--------------------------------------');

  console.log('STRUCTURE:');
  console.log(item.structure);

  console.log('--------------------------------------');

  console.log('TRADE PLAN:');
  console.log({
    entry: item.tradePlan.referenceEntry,
    invalidation: item.tradePlan.invalidation,
    support: item.tradePlan.support,
    resistance: item.tradePlan.resistance,
    target1: item.tradePlan.target1,
    target2: item.tradePlan.target2,
    target3: item.tradePlan.target3,
    resistanceDistance:
      formatPercent(item.tradePlan.resistanceDistance)
  });

  console.log('--------------------------------------');

  console.log('SCORING:');
  console.log(item.scoring);

  console.log('======================================\n');
}

/* -------------------------------------------------------
   MAIN SCANNER
------------------------------------------------------- */

async function runScanner() {
  console.log('======================================');
  console.log(' GATE.IO SMART LONG VOLUME SCANNER');
  console.log('======================================');

  console.log('Starting market scan...');

  const tickers = await getMarketTickers();

  if (!Array.isArray(tickers) || !tickers.length) {
    throw new Error('No market tickers received from Gate.io');
  }

  const markets = prepareMarkets(tickers);

  console.log(`Eligible USDT markets: ${markets.length}`);

  const btcTicker = tickers.find(
    item => item.symbol === 'BTC_USDT'
  );

  if (!btcTicker) {
    throw new Error('BTC_USDT ticker unavailable');
  }

  const btcTimeframes = await Promise.all([
    getTimeframeAnalysis('BTC_USDT', 'oneHour'),
    getTimeframeAnalysis('BTC_USDT', 'fourHour')
  ]);

  if (!btcTimeframes[0] || !btcTimeframes[1]) {
    throw new Error('BTC reference candles unavailable');
  }

  const btcData = {
    oneHour: btcTimeframes[0],
    fourHour: btcTimeframes[1]
  };

  console.log('BTC reference data loaded.');

  /*
   * First stage:
   * Screen every eligible market with 15m and 1h candles.
   * This stage avoids deep analysis of every market.
   */

  const firstStage = await runPool(
    markets,
    CONFIG.CONCURRENCY,
    async ticker => {
      const [fifteenRaw, hourlyRaw] = await Promise.all([
        getTimeframeAnalysis(ticker.symbol, 'fifteenMinute'),
        getTimeframeAnalysis(ticker.symbol, 'oneHour')
      ]);

      if (!fifteenRaw || !hourlyRaw) return null;

      const activeVolume =
        fifteenRaw.volumeRatio >= 1.3 ||
        hourlyRaw.volumeRatio >= 1.3 ||
        fifteenRaw.volumeTrend >= 1.3 ||
        hourlyRaw.volumeTrend >= 1.3;

      const priceActivity =
        fifteenRaw.priceChange > -3 &&
        hourlyRaw.priceChange > -5;

      if (!activeVolume || !priceActivity) {
        return null;
      }

      return ticker;
    }
  );

  const candidates = firstStage.filter(Boolean);

  console.log(
    `First-stage candidates: ${candidates.length}`
  );

  if (!candidates.length) {
    console.log('No qualifying candidates found.');
    return [];
  }

  /*
   * Second stage:
   * Deep analysis with all six timeframes,
   * OI, taker statistics and funding.
   */

  const deepResults = await runPool(
    candidates,
    CONFIG.DEEP_CONCURRENCY,
    async ticker => {
      const result = await analyzeSymbol(
        ticker.symbol,
        ticker,
        btcData
      );

      await sleep(100);

      return result;
    }
  );

  let opportunities = deepResults
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  /*
   * Third stage:
   * Order book inspection only for the best candidates.
   */

  const orderbookCandidates = opportunities.slice(
    0,
    CONFIG.MAX_ORDERBOOK_CHECKS
  );

  const orderbooks = await runPool(
    orderbookCandidates,
    3,
    async item => ({
      symbol: item.symbol,
      data: await getOrderBook(item.symbol)
    })
  );

  const orderbookMap = new Map(
    orderbooks
      .filter(Boolean)
      .map(item => [item.symbol, item.data])
  );

  opportunities = opportunities.map(item => {
    const orderbook = orderbookMap.get(item.symbol);

    if (!orderbook) {
      return {
        ...item,
        orderbook: null
      };
    }

    /*
     * Order book is a supplementary risk/context factor.
     * It does not prove real buying pressure or accumulation.
     */

    return {
      ...item,
      orderbook,
      orderbookSupportive:
        orderbook.imbalance !== null &&
        orderbook.imbalance >= 0.55 &&
        orderbook.spread <= 0.5
    };
  });

  opportunities.sort((a, b) => b.score - a.score);

  const finalResults = opportunities.slice(
    0,
    CONFIG.MAX_RESULTS
  );

  console.log('\n======================================');
  console.log(' FINAL LONG OPPORTUNITIES');
  console.log('======================================');

  console.log(`Eligible markets: ${markets.length}`);
  console.log(`First-stage candidates: ${candidates.length}`);
  console.log(`Qualified opportunities: ${opportunities.length}`);
  console.log(`Displayed opportunities: ${finalResults.length}`);

  if (!finalResults.length) {
    console.log('No high-quality LONG opportunity found.');
    return [];
  }

  finalResults.forEach(printOpportunity);

  console.log('======================================');
  console.log(' SCAN COMPLETED');
  console.log('======================================');

  return finalResults;
}

await runScanner();
