
/**
 * Gate.io USDT Perpetual Market Scanner
 * Node.js 20+
 *
 * دریافت ۳۶۰ کندل یک‌ساعته برای هر بازار
 * تحلیل ۲۴ کندل آخر به‌صورت کندل‌به‌کندل
 * مقایسه با سابقه ۱۵ روزه
 */

const BASE_URL = 'https://api.gateio.ws/api/v4';

const SETTLE = 'usdt';
const INTERVAL = '1h';

const HISTORY_CANDLES = 360;
const FILTER_CANDLES = 24;

const CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Gate API HTTP ${response.status}`);
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
    quoteVolume: Number(raw.sum ?? 0)
  };

  if (
    !Number.isFinite(candle.time) ||
    !Number.isFinite(candle.open) ||
    !Number.isFinite(candle.close) ||
    !Number.isFinite(candle.quoteVolume)
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
    .filter(candle => candle.time + oneHour <= nowSeconds)
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, array) =>
      index === 0 || candle.time !== array[index - 1].time
    );

  if (candles.length < HISTORY_CANDLES) {
    return {
      contract,
      status: 'INSUFFICIENT_HISTORY',
      candlesReceived: candles.length,
      requiredCandles: HISTORY_CANDLES
    };
  }

  const recent24 = candles.slice(-FILTER_CANDLES);

  const historical = candles.slice(
    0,
    -FILTER_CANDLES
  );

  const historicalReturns = historical
    .slice(1)
    .map((candle, index) =>
      Math.abs(
        safePercentChange(
          candle.close,
          historical[index].close
        ) ?? 0
      )
    );

  const historicalMedianAbsReturnPct =
    median(historicalReturns);

  const historicalMedianQuoteVolume =
    median(historical.map(candle => candle.quoteVolume));

  const candleMetrics = recent24.map((candle, index) => {
    const previous = index === 0
      ? candles[candles.length - FILTER_CANDLES - 1]
      : recent24[index - 1];

    const priceChangePct = safePercentChange(
      candle.close,
      previous.close
    );

    const volumeChangePct = safePercentChange(
      candle.quoteVolume,
      previous.quoteVolume
    );

    return {
      time: candle.time,

      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,

      quoteVolumeUSDT: candle.quoteVolume,

      priceChangePct:
        priceChangePct === null
          ? null
          : Number(priceChangePct.toFixed(4)),

      volumeChangePct:
        volumeChangePct === null
          ? null
          : Number(volumeChangePct.toFixed(2)),

      volumeVsHistoricalMedian:
        historicalMedianQuoteVolume > 0
          ? Number(
              (
                candle.quoteVolume /
                historicalMedianQuoteVolume
              ).toFixed(3)
            )
          : null,

      priceMoveVsHistoricalMedian:
        historicalMedianAbsReturnPct > 0 &&
        priceChangePct !== null
          ? Number(
              (
                Math.abs(priceChangePct) /
                historicalMedianAbsReturnPct
              ).toFixed(3)
            )
          : null
    };
  });

  const first = recent24[0];
  const last = recent24[recent24.length - 1];

  const totalQuoteVolume24h = recent24.reduce(
    (sum, candle) => sum + candle.quoteVolume,
    0
  );

  const averageHourlyQuoteVolume24h =
    totalQuoteVolume24h / FILTER_CANDLES;

  return {
    contract,
    status: 'OK',

    candlesUsed: FILTER_CANDLES,
    historyDaysAvailable: 15,

    priceChange24hPct: Number(
      (
        safePercentChange(last.close, first.open) ?? 0
      ).toFixed(4)
    ),

    quoteVolume24hUSDT: Number(
      totalQuoteVolume24h.toFixed(2)
    ),

    averageHourlyVolume24hUSDT: Number(
      averageHourlyQuoteVolume24h.toFixed(2)
    ),

    averageVolumeVsHistoricalMedian:
      historicalMedianQuoteVolume > 0
        ? Number(
            (
              averageHourlyQuoteVolume24h /
              historicalMedianQuoteVolume
            ).toFixed(3)
          )
        : null,

    historicalMedianHourlyVolumeUSDT: Number(
      historicalMedianQuoteVolume.toFixed(2)
    ),

    historicalMedianHourlyAbsPriceChangePct: Number(
      historicalMedianAbsReturnPct.toFixed(5)
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
        length: Math.min(concurrency, items.length)
      },
      () => runWorker()
    )
  );

  return results;
}

export async function scanGateMarkets() {
  console.log(
    'Loading Gate.io USDT perpetual contracts...'
  );

  const contracts = await gateGet(
    `/futures/${SETTLE}/contracts`
  );

  const activeContracts = contracts.filter(item =>
    item.status === 'trading' &&
    item.in_delisting !== true &&
    item.type === 'direct'
  );

  console.log(
    `Found ${activeContracts.length} active USDT perpetual contracts.`
  );

  console.log(
    `Fetching ${HISTORY_CANDLES} hourly candles per contract...`
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
          limit: HISTORY_CANDLES
        }
      );

      completed++;

      if (
        completed % 50 === 0 ||
        completed === activeContracts.length
      ) {
        console.log(
          `Processed ${completed}/${activeContracts.length}`
        );
      }

      return analyzeMarket(
        item.name,
        rawCandles
      );
    }
  );

  const successful = results.filter(
    item => item.status === 'OK'
  );

  const failed = results.filter(
    item => item.status !== 'OK'
  );

  return {
    exchange: 'Gate.io',
    marketType: 'USDT Perpetual Futures',
    timeframe: '1h',

    scannedAt: new Date().toISOString(),

    scanIntervalMinutes: 15,

    filterWindowCandles: FILTER_CANDLES,
    historyCandles: HISTORY_CANDLES,

    totalMarkets: activeContracts.length,
    successfulMarkets: successful.length,
    failedMarkets: failed.length,

    markets: successful,
    errors: failed
  };
}

// Direct execution
const isDirectRun =
  process.argv[1] &&
  import.meta.url ===
  new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  try {
    const output = await scanGateMarkets();

    console.log('\n===== GATE SCAN SUMMARY =====');

    console.log({
      totalMarkets: output.totalMarkets,
      successfulMarkets: output.successfulMarkets,
      failedMarkets: output.failedMarkets,
      scannedAt: output.scannedAt
    });

    console.log(
      '\nRaw metrics are available for the next ranking stage.'
    );

  } catch (error) {
    console.error(
      'Gate scanner failed:',
      error.message
    );

    process.exitCode = 1;
  }
}
