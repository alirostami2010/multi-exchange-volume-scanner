
/**
 * Gate.io USDT Perpetual Market Scanner
 *
 * Timeframe: 1H
 * Scan window: 24 closed candles
 * Historical data: Up to 15 days
 *
 * Ranking:
 * 1. Volume strength          20%
 * 2. Volume acceleration      20%
 * 3. Price speed              15%
 * 4. Price acceleration       20%
 * 5. 24h price growth         15%
 * 6. Factor coordination      10%
 *
 * Output: Top 20 ranked bullish opportunities.
 */

const BASE_URL = 'https://api.gateio.ws/api/v4';

const SETTLE = 'usdt';
const INTERVAL = '1h';

const HISTORY_CANDLES = 360;
const FETCH_CANDLES = HISTORY_CANDLES + 1;
const FILTER_CANDLES = 24;

const MIN_HISTORY_CANDLES = 48;

const CONCURRENCY = 2;
const MIN_REQUEST_INTERVAL_MS = 450;

const REQUEST_TIMEOUT_MS = 12000;
const MAX_RETRIES = 4;

const TOP_LIMIT = 10;

const WEIGHTS = {
  volumeStrength: 20,
  volumeAcceleration: 20,
  priceSpeed: 15,
  priceAcceleration: 20,
  priceGrowth: 15,
  coordination: 10
};

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

let nextRequestAt = 0;
let rateLimitUntil = 0;

// ------------------------------------------
// BASIC HELPERS
// ------------------------------------------

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;

  return Number(value.toFixed(decimals));
}

function mean(values) {
  const valid = values.filter(Number.isFinite);

  if (!valid.length) return null;

  return valid.reduce((sum, value) => sum + value, 0)
    / valid.length;
}

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

function safeLogRatio(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    current <= 0 ||
    previous <= 0
  ) {
    return null;
  }

  return Math.log(current / previous);
}

// ------------------------------------------
// RATE LIMITER
// ------------------------------------------

async function waitForRequestSlot() {
  const now = Date.now();

  const slot = Math.max(
    now,
    nextRequestAt,
    rateLimitUntil
  );

  nextRequestAt = slot + MIN_REQUEST_INTERVAL_MS;

  await sleep(slot - now);
}

function getRetryAfterMs(response) {
  const value = response.headers.get('Retry-After');

  if (!value) return 0;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return 0;
}

async function gateGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await waitForRequestSlot();

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

      if (response.status === 429) {
        const retryAfterMs = Math.max(
          getRetryAfterMs(response),
          5000 * attempt
        );

        rateLimitUntil = Math.max(
          rateLimitUntil,
          Date.now() + retryAfterMs
        );

        const error = new Error(
          'Gate API HTTP 429'
        );

        error.retryAfterMs = retryAfterMs;

        throw error;
      }

      if (response.status >= 500) {
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
        const backoff = Math.max(
          error.retryAfterMs || 0,
          1500 * (2 ** (attempt - 1))
        );

        console.log(
          `Request retry ${attempt}/${MAX_RETRIES}: ${error.message}. Waiting ${Math.ceil(backoff / 1000)}s`
        );

        await sleep(backoff);
      }

    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

// ------------------------------------------
// CANDLE NORMALIZATION
// ------------------------------------------

function normalizeCandle(raw) {
  const candle = {
    time: Number(raw.t),
    open: Number(raw.o),
    high: Number(raw.h),
    low: Number(raw.l),
    close: Number(raw.c),

    contractVolume: Number(raw.v ?? 0),

    // Gate futures quote volume in USDT.
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

// ------------------------------------------
// SCORING FUNCTIONS
// ------------------------------------------

/**
 * Ratio scoring:
 *
 * 0.25x = 10
 * 0.50x = 30
 * 1.00x = 50
 * 2.00x = 70
 * 4.00x = 90
 * 8.00x = 100 (capped)
 */
function scoreRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return 0;
  }

  return clamp(
    50 + 20 * Math.log2(ratio)
  );
}

/**
 * Directional scoring:
 *
 * Zero movement = 50
 * Positive movement = above 50
 * Negative movement = below 50
 */
function scoreSigned(value, scale) {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    return 50;
  }

  return clamp(
    50 + 50 * Math.tanh(value / scale)
  );
}

// ------------------------------------------
// MARKET ANALYSIS
// ------------------------------------------

function analyzeMarket(contract, rawCandles) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oneHour = 3600;

  const candles = rawCandles
    .map(normalizeCandle)
    .filter(Boolean)
    .filter(candle =>
      candle.time + oneHour <= nowSeconds
    )
    .sort((a, b) => a.time - b.time)
    .filter((candle, index, array) =>
      index === 0 ||
      candle.time !== array[index - 1].time
    );

  const requiredCandles =
    FILTER_CANDLES + MIN_HISTORY_CANDLES;

  if (candles.length < requiredCandles) {
    return {
      contract,
      status: 'INSUFFICIENT_HISTORY',
      candlesReceived: candles.length,
      requiredCandles
    };
  }

  const recent24 = candles.slice(-FILTER_CANDLES);

  const historical = candles.slice(
    0,
    -FILTER_CANDLES
  );

  // ----------------------------------------
  // HISTORICAL BASELINES
  // ----------------------------------------

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

  const historicalVolumes = historical.map(
    candle => candle.quoteVolume
  );

  const historicalMedianAbsReturnPct =
    median(historicalReturns);

  const historicalMedianQuoteVolume =
    median(historicalVolumes);

  if (
    historicalMedianQuoteVolume <= 0 ||
    historicalMedianAbsReturnPct <= 0
  ) {
    return {
      contract,
      status: 'INSUFFICIENT_HISTORY',
      reason: 'Invalid historical baseline'
    };
  }

  // ----------------------------------------
  // CANDLE-BY-CANDLE METRICS
  // ----------------------------------------

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
        candle.quoteVolume /
        historicalMedianQuoteVolume;

      const priceMoveVsHistoricalMedian =
        Math.abs(priceChangePct ?? 0) /
        historicalMedianAbsReturnPct;

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

        priceChangePct: round(priceChangePct),

        priceSpeedPctPerHour: round(
          priceChangePct
        ),

        priceAccelerationPp: round(
          priceAcceleration
        ),

        volumeChangePct: round(
          volumeChangePct,
          2
        ),

        volumeAccelerationPp: round(
          volumeAcceleration,
          2
        ),

        volumeVsHistoricalMedian: round(
          volumeVsHistoricalMedian,
          3
        ),

        priceMoveVsHistoricalMedian: round(
          priceMoveVsHistoricalMedian,
          3
        )
      };
    }
  );

  // ----------------------------------------
  // RECENT PRICE AND VOLUME METRICS
  // ----------------------------------------

  const last3 = recent24.slice(-3);
  const last4 = recent24.slice(-4);

  const last3Volumes = last3.map(
    candle => candle.quoteVolume
  );

  const last3Returns = last3.map(
    (candle, index) => {
      const absoluteIndex =
        candles.length - 3 + index;

      return safePercentChange(
        candle.close,
        candles[absoluteIndex - 1].close
      );
    }
  );

  const averageVolumeLast3 = mean(
    last3Volumes
  );

  const volumeStrengthRatio =
    averageVolumeLast3 /
    historicalMedianQuoteVolume;

  // Compare last 2 hours with the preceding 2 hours.
  const averageLast2Volumes = mean(
    last4.slice(-2).map(c => c.quoteVolume)
  );

  const averagePrevious2Volumes = mean(
    last4.slice(0, 2).map(c => c.quoteVolume)
  );

  const volumeMomentumRatio =
    averagePrevious2Volumes > 0
      ? averageLast2Volumes / averagePrevious2Volumes
      : null;

  // Logarithmic volume acceleration.
  const volumeLogGrowthLatest = safeLogRatio(
    last4[3].quoteVolume,
    last4[2].quoteVolume
  );

  const volumeLogGrowthPrevious = safeLogRatio(
    last4[2].quoteVolume,
    last4[1].quoteVolume
  );

  const volumeAccelerationLog =
    volumeLogGrowthLatest !== null &&
    volumeLogGrowthPrevious !== null
      ? volumeLogGrowthLatest - volumeLogGrowthPrevious
      : null;

  const priceSpeedAverage = mean(
    last3Returns
  );

  const last2Returns = last4.slice(-2).map(
    (candle, index) => {
      const absoluteIndex =
        candles.length - 2 + index;

      return safePercentChange(
        candle.close,
        candles[absoluteIndex - 1].close
      );
    }
  );

  const previous2Returns = last4.slice(0, 2).map(
    (candle, index) => {
      const absoluteIndex =
        candles.length - 4 + index;

      return safePercentChange(
        candle.close,
        candles[absoluteIndex - 1].close
      );
    }
  );

  const averageLast2Returns = mean(last2Returns);
  const averagePrevious2Returns = mean(previous2Returns);

  const priceAcceleration =
    averageLast2Returns !== null &&
    averagePrevious2Returns !== null
      ? averageLast2Returns - averagePrevious2Returns
      : null;

  const first = recent24[0];
  const last = recent24[recent24.length - 1];

  const priceChange24hPct = safePercentChange(
    last.close,
    first.open
  );

  const totalQuoteVolume24h = recent24.reduce(
    (sum, candle) => sum + candle.quoteVolume,
    0
  );

  const averageHourlyQuoteVolume24h =
    totalQuoteVolume24h / FILTER_CANDLES;

  const averageVolumeVsHistoricalMedian =
    averageHourlyQuoteVolume24h /
    historicalMedianQuoteVolume;

  // ----------------------------------------
  // SIX COMPONENT SCORES
  // ----------------------------------------

  const volumeStrengthScore = scoreRatio(
    volumeStrengthRatio
  );

  const volumeAccelerationScore = (
    scoreSigned(
      volumeAccelerationLog ?? 0,
      0.35
    ) * 0.7
  ) + (
    scoreRatio(
      volumeMomentumRatio ?? 1
    ) * 0.3
  );

  const normalizedPriceSpeed =
    priceSpeedAverage /
    historicalMedianAbsReturnPct;

  const priceSpeedScore = scoreSigned(
    normalizedPriceSpeed,
    1
  );

  const normalizedPriceAcceleration =
    (priceAcceleration ?? 0) /
    historicalMedianAbsReturnPct;

  const priceAccelerationScore = scoreSigned(
    normalizedPriceAcceleration,
    1
  );

  const expected24hMove =
    historicalMedianAbsReturnPct *
    Math.sqrt(24);

  const normalized24hGrowth =
    priceChange24hPct / expected24hMove;

  const priceGrowthScore = scoreSigned(
    normalized24hGrowth,
    1
  );

  // ----------------------------------------
  // COORDINATION SCORE
  // ----------------------------------------

  const positiveFactors = [
    volumeStrengthRatio > 1.15,

    (volumeMomentumRatio ?? 1) > 1.05 ||
      (volumeAccelerationLog ?? 0) > 0,

    priceSpeedAverage > 0,

    (priceAcceleration ?? 0) > 0,

    priceChange24hPct > 0
  ];

  const positiveFactorCount =
    positiveFactors.filter(Boolean).length;

  const coordinationScore =
    (positiveFactorCount / positiveFactors.length) * 100;

  // ----------------------------------------
  // FINAL WEIGHTED SCORE
  // ----------------------------------------

  const finalScore =
    volumeStrengthScore * WEIGHTS.volumeStrength / 100 +

    volumeAccelerationScore *
      WEIGHTS.volumeAcceleration / 100 +

    priceSpeedScore *
      WEIGHTS.priceSpeed / 100 +

    priceAccelerationScore *
      WEIGHTS.priceAcceleration / 100 +

    priceGrowthScore *
      WEIGHTS.priceGrowth / 100 +

    coordinationScore *
      WEIGHTS.coordination / 100;

  const latestClosedCandle =
    candleMetrics[candleMetrics.length - 1];

  const last3hPriceChangePct =
    safePercentChange(
      last.close,
      recent24[recent24.length - 4].close
    );

  let signal = 'LOW';

  if (finalScore >= 75) {
    signal = 'STRONG';
  } else if (finalScore >= 65) {
    signal = 'HIGH';
  } else if (finalScore >= 55) {
    signal = 'WATCH';
  }

  return {
    contract,
    status: 'OK',

    timeframe: '1h',

    score: round(finalScore, 2),

    signal,

    rank: null,

    scores: {
      volumeStrength: round(volumeStrengthScore, 2),

      volumeAcceleration: round(
        volumeAccelerationScore,
        2
      ),

      priceSpeed: round(priceSpeedScore, 2),

      priceAcceleration: round(
        priceAccelerationScore,
        2
      ),

      priceGrowth: round(priceGrowthScore, 2),

      coordination: round(coordinationScore, 2)
    },

    weights: WEIGHTS,

    coordination: {
      positiveFactors: positiveFactorCount,
      totalFactors: positiveFactors.length,
      positiveFactorFlags: {
        volumeStrength: positiveFactors[0],
        volumeMomentum: positiveFactors[1],
        priceSpeed: positiveFactors[2],
        priceAcceleration: positiveFactors[3],
        priceGrowth24h: positiveFactors[4]
      }
    },

    metrics: {
      priceChange24hPct: round(
        priceChange24hPct
      ),

      last3hPriceChangePct: round(
        last3hPriceChangePct
      ),

      averagePriceSpeed3hPct: round(
        priceSpeedAverage
      ),

      priceAccelerationPp: round(
        priceAcceleration
      ),

      volumeStrengthRatio: round(
        volumeStrengthRatio,
        3
      ),

      volumeMomentumRatio: round(
        volumeMomentumRatio,
        3
      ),

      volumeAccelerationLog: round(
        volumeAccelerationLog,
        4
      ),

      averageVolumeVsHistoricalMedian: round(
        averageVolumeVsHistoricalMedian,
        3
      ),

      quoteVolume24hUSDT: round(
        totalQuoteVolume24h,
        2
      ),

      averageHourlyVolume24hUSDT: round(
        averageHourlyQuoteVolume24h,
        2
      ),

      historicalMedianHourlyVolumeUSDT: round(
        historicalMedianQuoteVolume,
        2
      ),

      historicalMedianHourlyAbsPriceChangePct: round(
        historicalMedianAbsReturnPct,
        5
      )
    },

    candlesUsed: recent24.length,

    historicalCandlesUsed: historical.length,

    historyDaysAvailable: round(
      candles.length / 24,
      2
    ),

    full15DayHistoryAvailable:
      candles.length >= HISTORY_CANDLES,

    latestClosedCandle,

    candleMetrics
  };
}

// ------------------------------------------
// CONCURRENCY WORKER
// ------------------------------------------

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

// ------------------------------------------
// TELEGRAM REPORT - MINIMAL GRAPHIC DESIGN
// ------------------------------------------

async function sendTelegramReport(output) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(
      'Telegram credentials not configured. Skipping Telegram report.'
    );
    return;
  }

  const botUrl = `https://api.telegram.org/bot${token}`;

  const date = new Date(output.scannedAt).toLocaleString(
    'en-GB',
    {
      timeZone: 'UTC',
      hour12: false
    }
  );

  // Safe number formatter
  const fmt = (value, decimals = 0) => {
    if (
      value === null ||
      value === undefined ||
      !Number.isFinite(Number(value))
    ) {
      return '—';
    }

    return Number(value).toFixed(decimals);
  };

  // Compact graphical score bar
  const scoreBar = score => {
    const value = Math.max(
      0,
      Math.min(100, Number(score) || 0)
    );

    const totalBlocks = 8;
    const filled = Math.round(
      value / 100 * totalBlocks
    );

    const color =
      value >= 75 ? '🟩' :
      value >= 55 ? '🟨' : '🟥';

    return color.repeat(filled) +
      '⬜'.repeat(totalBlocks - filled);
  };

  const lines = [
    '📡 GATE.IO  |  MARKET RADAR',
    `🕒 ${date} UTC  ·  تایم‌فریم 1H`,
    '',
    `بازارها: ${output.totalMarkets}  |  موفق: ${output.successfulMarkets}  |  ناقص: ${output.insufficientHistoryMarkets}  |  ناموفق: ${output.failedMarkets}`,
    '',
    '🏆 TOP 20 MARKETS',
    ''
  ];

  for (const market of output.top20) {
    const scores = market.scores || {};
    const metrics = market.metrics || {};

    const growth = metrics.priceChange24hPct;

    const growthText =
      growth === null || growth === undefined
        ? '—'
        : `${growth > 0 ? '+' : ''}${fmt(growth, 2)}%`;

    const volumeRatio = fmt(
      metrics.volumeStrengthRatio,
      2
    );

    const rank = String(market.rank).padStart(2, '0');

    // Each market is displayed as a compact individual card.
    lines.push(
      `┌ ${rank} · ${market.contract}  |  ${fmt(market.score, 2)}/100`,
      `│ ${scoreBar(market.score)}  ·  📈 رشد ۲۴س: ${growthText}  ·  🔊 نسبت حجم: ${volumeRatio}x`,
      `│ 📊 حجم: قدرت ${fmt(scores.volumeStrength)}  ·  شتاب ${fmt(scores.volumeAcceleration)}`,
      `│ ⚡ قیمت: سرعت ${fmt(scores.priceSpeed)}  ·  شتاب ${fmt(scores.priceAcceleration)}  ·  رشد ${fmt(scores.priceGrowth)}`,
      `│ 🎯 هماهنگی: ${fmt(scores.coordination)}`,
      '└────────────────'
    );
  }

  const message = lines.join('\n');

  // Telegram message limit
  if (message.length > 4096) {
    throw new Error(
      `Telegram message is too long: ${message.length} characters`
    );
  }

  // Send summary message
  const messageResponse = await fetch(
    `${botUrl}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      })
    }
  );

  const messageResult = await messageResponse.json();

  if (!messageResponse.ok || !messageResult.ok) {
    throw new Error(
      `Telegram message failed: ${messageResult.description || messageResponse.status}`
    );
  }

  console.log(
    'Telegram graphic summary sent successfully.'
  );

  // Send complete JSON report
  const reportJson = JSON.stringify(output, null, 2);

  const form = new FormData();

  form.append('chat_id', chatId);

  form.append(
    'document',
    new Blob(
      [reportJson],
      { type: 'application/json' }
    ),
    `gate-scan-${output.scannedAt.replace(/[:.]/g, '-')}.json`
  );

  const documentResponse = await fetch(
    `${botUrl}/sendDocument`,
    {
      method: 'POST',
      body: form
    }
  );

  const documentResult = await documentResponse.json();

  if (!documentResponse.ok || !documentResult.ok) {
    throw new Error(
      `Telegram document failed: ${documentResult.description || documentResponse.status}`
    );
  }

  console.log(
    'Telegram full report sent successfully.'
  );
}

// ------------------------------------------
// MAIN SCANNER
// ------------------------------------------

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

  console.log(
    `Concurrency: ${CONCURRENCY} | Request spacing: ${MIN_REQUEST_INTERVAL_MS}ms`
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

  // ----------------------------------------
  // RESULT GROUPS
  // ----------------------------------------

  const successful = results.filter(
    item => item.status === 'OK'
  );

  const insufficient = results.filter(
    item => item.status === 'INSUFFICIENT_HISTORY'
  );

  const failed = results.filter(
    item => item.status === 'ERROR'
  );

  // ----------------------------------------
  // RANKING
  // ----------------------------------------

  const rankedMarkets = successful
    .sort((a, b) => b.score - a.score)
    .map((market, index) => ({
      ...market,
      rank: index + 1
    }));

  const top20 = rankedMarkets.slice(
    0,
    TOP_LIMIT
  );

  // ----------------------------------------
  // FINAL OUTPUT
  // ----------------------------------------

  const output = {
    exchange: 'Gate.io',

    marketType: 'USDT Perpetual Futures',

    timeframe: INTERVAL,

    scannedAt: new Date().toISOString(),

    scanIntervalMinutes: 15,

    filterWindowCandles: FILTER_CANDLES,

    historyCandles: HISTORY_CANDLES,

    rankingWeights: WEIGHTS,

    totalMarkets: activeContracts.length,

    successfulMarkets: successful.length,

    insufficientHistoryMarkets: insufficient.length,

    failedMarkets: failed.length,

    rankedMarkets,

    top20,

    insufficientHistory: insufficient,

    errors: failed
  };

  // ----------------------------------------
  // SUMMARY
  // ----------------------------------------

  console.log('\n======================================');
  console.log(' SCAN SUMMARY');
  console.log('======================================');

  console.log({
    exchange: output.exchange,
    totalMarkets: output.totalMarkets,
    successfulMarkets: output.successfulMarkets,
    insufficientHistoryMarkets:
      output.insufficientHistoryMarkets,
    failedMarkets: output.failedMarkets,
    scannedAt: output.scannedAt
  });

  // ----------------------------------------
  // TOP 20 DISPLAY
  // ----------------------------------------

  console.log('\n======================================');
  console.log(' TOP 20 MARKET WATCHLIST');
  console.log('======================================');

  console.table(
    top20.map(market => ({
      rank: market.rank,
      contract: market.contract,
      score: market.score,
      signal: market.signal,

      volume: market.scores.volumeStrength,

      volumeAccel: market.scores.volumeAcceleration,

      priceSpeed: market.scores.priceSpeed,

      priceAccel: market.scores.priceAcceleration,

      growth24h: market.scores.priceGrowth,

      coordination: market.scores.coordination,

      price24h: market.metrics.priceChange24hPct,

      volumeRatio: market.metrics.volumeStrengthRatio
    }))
  );

  console.log('\n===== TOP 20 DETAILS =====');

  console.log(
    JSON.stringify(top20, null, 2)
  );

  console.log('\n===== SCAN FINISHED =====');

  // ----------------------------------------
  // SEND REPORT TO TELEGRAM
  // ----------------------------------------

  try {
    await sendTelegramReport(output);
  } catch (error) {
    console.error(
      'TELEGRAM REPORT ERROR:',
      error.message
    );
  }

  return output;
}

// ------------------------------------------
// AUTO EXECUTION
// ------------------------------------------

try {
  await scanGateMarkets();

} catch (error) {
  console.error(
    '\nGATE SCANNER FAILED:',
    error.message
  );

  process.exitCode = 1;
}
