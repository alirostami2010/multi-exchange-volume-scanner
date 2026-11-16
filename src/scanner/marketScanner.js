
/**
 * Gate.io USDT Perpetual Market Scanner
 *
 * Timeframe: 1H
 * Scan window: 24 closed candles
 * Historical data: Up to 15 days (360 closed candles)
 *
 * Price and volume:
 * - Candle-to-candle percentage change
 * - Growth speed
 * - Acceleration / deceleration
 * - Comparison with historical median
 */

const BASE_URL = 'https://api.gateio.ws/api/v4';

const SETTLE = 'usdt';
const INTERVAL = '1h';

const HISTORY_CANDLES = 360;
const FETCH_CANDLES = HISTORY_CANDLES + 1;
const FILTER_CANDLES = 24;

const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function median(values) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!sorted.length) return 0;

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safePercentChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }

  return ((current / previous) - 1) * 100;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;

  return Number(value.toFixed(decimals));
}

async function gateGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new Error(
          `Gate API HTTP ${response.status}`
        );
      }

      if (!response.ok) {
        const body = await response.text();

        throw new Error(
          `Gate API HTTP ${response.status}: ${body.slice(0, 250)}`
        );
      }

      return await response.json();

    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES) {
        console.log(
          `Request retry ${attempt}/${MAX_RETRIES}: ${error.message}`
        );

        await sleep(500 * (2 ** (attempt - 1)));
      }

    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function normalizeCandle(raw) {
  const candle = {
    time: Number(raw.t),
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),

    contractVolume: Number(raw.v ?? 0),

    // Gate futures candle sum is quote-currency volume (USDT).
    quoteVolume: Number(raw.sum ?? 0)
  };

  if (
    !Number.isFinite(candle.time) ||
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.high) ||
    !Number.isFinite(candle.low) ||
    !Number.isFinite(candle.close) ||
    !Number.isFinite(candle.quoteVolume) ||
    candle.close <= 0 ||
    candle.quoteVolume < 0
  ) {
    return null;
  }

  return candle;
}

function analyzeMarket(contract, rawCandles) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oneHour = 3600;

  const candles = rawCandles
    .map(normalizeCandle)
    .filter(Boolean)

    // Only fully closed candles.
    .filter(candle =>
      candle.time + oneHour <= nowSeconds
    )

    .sort((a, b) => a.time - b.time)

    // Remove duplicate timestamps.
    .filter((candle, index, array) =>
      index === 0 ||
      candle.time !== array[index - 1].time
    );

  if (candles.length < FILTER_CANDLES + 1) {
    return {
      contract,
      status: 'INSUFFICIENT_HISTORY',
      candlesReceived: candles.length,
      requiredCandles: FILTER_CANDLES + 1
    };
  }

  // Latest 24 fully closed candles.
  const recent24 = candles.slice(-FILTER_CANDLES);

  // Available candles before the latest 24.
  const historical = candles.slice(
    0,
    -FILTER_CANDLES
  );

  // Historical hourly absolute price changes.
  const historicalReturns = historical
    .slice(1)
    .map((candle, index) => {
      const previous = historical[index];

      return Math.abs(
        safePercentChange(
          candle.close,
          previous.close
        ) ?? 0
      );
    });

  // Historical hourly quote volumes.
  const historicalVolumes = historical.map(
    candle => candle.quoteVolume
  );

  const historicalMedianAbsReturnPct =
    median(historicalReturns);

  const historicalMedianQuoteVolume =
    median(historicalVolumes);

  // Calculate candle-by-candle metrics.
  const candleMetrics = recent24.map(
    (candle, index) => {
      const absoluteIndex =
        candles.length - FILTER_CANDLES + index;

      const previous = candles[absoluteIndex - 1];
      const previousPrevious =
        candles[absoluteIndex - 2];

      const priceChangePct = safePercentChange(
        candle.close,
        previous.close
      );

      const volumeChangePct = safePercentChange(
        candle.quoteVolume,
        previous.quoteVolume
      );

      const previousPriceChangePct =
        previousPrevious
          ? safePercentChange(
              previous.close,
              previousPrevious.close
            )
          : null;

      const previousVolumeChangePct =
        previousPrevious
          ? safePercentChange(
              previous.quoteVolume,
              previousPrevious.quoteVolume
            )
          : null;

      // Acceleration = current speed - previous speed.
      const priceAcceleration =
        priceChangePct !== null &&
        previousPriceChangePct !== null
          ? priceChangePct - previousPriceChangePct
          : null;

      const volumeAcceleration =
        volumeChangePct !== null &&
        previousVolumeChangePct !== null
          ? volumeChangePct - previousVolumeChangePct
          : null;

      const volumeVsHistoricalMedian =
        historicalMedianQuoteVolume > 0
          ? candle.quoteVolume /
            historicalMedianQuoteVolume
          : null;

      const priceMoveVsHistoricalMedian =
        historicalMedianAbsReturnPct > 0 &&
        priceChangePct !== null
          ? Math.abs(priceChangePct) /
            historicalMedianAbsReturnPct
          : null;

      return {
        time: candle.time,

        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,

        quoteVolumeUSDT: round(
          candle.quoteVolume,
          2
        ),

        // Price movement during this hour.
        priceChangePct: round(
          priceChangePct
        ),

        // Price speed per hour.
        priceSpeedPctPerHour: round(
          priceChangePct
        ),

        // Change in price speed, in percentage points.
        priceAccelerationPp: round(
          priceAcceleration
        ),

        // Volume change versus previous hour.
        volumeChangePct: round(
          volumeChangePct,
          2
        ),

        // Change in volume growth rate.
        volumeAccelerationPp: round(
          volumeAcceleration,
          2
        ),

        // Current volume relative to historical median.
        volumeVsHistoricalMedian: round(
          volumeVsHistoricalMedian,
          3
        ),

        // Absolute price movement relative to normal behavior.
        priceMoveVsHistoricalMedian: round(
          priceMoveVsHistoricalMedian,
          3
        )
      };
    }
  );

  const first = recent24[0];
  const last = recent24[recent24.length - 1];

  const totalQuoteVolume24h = recent24.reduce(
    (sum, candle) =>
      sum + candle.quoteVolume,
    0
  );

  const averageHourlyQuoteVolume24h =
    totalQuoteVolume24h / FILTER_CANDLES;

  const averageVolumeVsHistoricalMedian =
    historicalMedianQuoteVolume > 0
      ? averageHourlyQuoteVolume24h /
        historicalMedianQuoteVolume
      : null;

  return {
    contract,
    status: 'OK',

    timeframe: '1h',

    candlesUsed: recent24.length,

    historicalCandlesUsed: historical.length,

    historyDaysAvailable: round(
      candles.length / 24,
      2
    ),

    full15DayHistoryAvailable:
      candles.length >= HISTORY_CANDLES,

    priceChange24hPct: round(
      safePercentChange(
        last.close,
        first.open
      )
    ),

    quoteVolume24hUSDT: round(
      totalQuoteVolume24h,
      2
    ),

    averageHourlyVolume24hUSDT: round(
      averageHourlyQuoteVolume24h,
      2
    ),

    averageVolumeVsHistoricalMedian: round(
      averageVolumeVsHistoricalMedian,
      3
    ),

    historicalMedianHourlyVolumeUSDT: round(
      historicalMedianQuoteVolume,
      2
    ),

    historicalMedianHourlyAbsPriceChangePct: round(
      historicalMedianAbsReturnPct,
      5
    ),

    latestClosedCandle:
      candleMetrics[candleMetrics.length - 1],

    candleMetrics
  };
}

async function mapWithConcurrency(
  items,
  concurrency,
  worker
) {
  const results = new Array(items.length);

  let nextIndex = 0;

  async function runWorker() {
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
          contract: items[index].name,
          status: 'ERROR',
          error: error.message
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          concurrency,
          items.length
        )
      },
      () => runWorker()
    )
  );

  return results;
}

export async function scanGateMarkets() {
  console.log('\n======================================');
  console.log(' GATE.IO MARKET SCANNER');
  console.log('======================================');

  console.log('Loading USDT perpetual contracts...');

  const contracts = await gateGet(
    `/futures/${SETTLE}/contracts`
  );

  const activeContracts = contracts.filter(
    item =>
      item.status === 'trading' &&
      item.in_delisting !== true &&
      item.type === 'direct'
  );

  console.log(
    `Found ${activeContracts.length} active contracts.`
  );

  console.log(
    `Fetching ${FETCH_CANDLES} hourly candles per contract...`
  );

  let completed = 0;

  const results = await mapWithConcurrency(
    activeContracts,
    CONCURRENCY,
    async item => {
      const rawCandles = await gateGet(
        `/futures/${SETTLE}/candlesticks`,
        {
          contract: item.name,
          interval: INTERVAL,
          limit: FETCH_CANDLES
        }
      );

      const analysis = analyzeMarket(
        item.name,
        rawCandles
      );

      completed++;

      if (
        completed % 25 === 0 ||
        completed === activeContracts.length
      ) {
        console.log(
          `Processed ${completed}/${activeContracts.length}`
        );
      }

      return analysis;
    }
  );

  const successful = results.filter(
    item => item.status === 'OK'
  );

  const insufficient = results.filter(
    item => item.status === 'INSUFFICIENT_HISTORY'
  );

  const failed = results.filter(
    item => item.status === 'ERROR'
  );

  const output = {
    exchange: 'Gate.io',

    marketType: 'USDT Perpetual Futures',

    timeframe: '1h',

    scannedAt: new Date().toISOString(),

    scanIntervalMinutes: 15,

    filterWindowCandles: FILTER_CANDLES,

    historyCandles: HISTORY_CANDLES,

    totalMarkets: activeContracts.length,

    successfulMarkets: successful.length,

    insufficientHistoryMarkets: insufficient.length,

    failedMarkets: failed.length,

    markets: successful,

    insufficientHistory: insufficient,

    errors: failed
  };

  console.log('\n===== SCAN SUMMARY =====');

  console.log({
    exchange: output.exchange,
    totalMarkets: output.totalMarkets,
    successfulMarkets: output.successfulMarkets,
    insufficientHistoryMarkets:
      output.insufficientHistoryMarkets,
    failedMarkets: output.failedMarkets,
    scannedAt: output.scannedAt
  });

  if (successful.length > 0) {
    console.log('\n===== SAMPLE MARKET =====');

    console.log(
      JSON.stringify(successful[0], null, 2)
    );
  }

  console.log('\n===== SCAN FINISHED =====');

  return output;
}

// IMPORTANT:
// This file is imported by src/index.js.
// Therefore, execute the scan when this module is loaded.

try {
  await scanGateMarkets();

} catch (error) {
  console.error(
    '\nGATE SCANNER FAILED:',
    error.message
  );

  process.exitCode = 1;
}
