
/**
 * GATE.IO USDT PERPETUAL — LONG BUY PRESSURE RADAR
 * ------------------------------------------------
 * LONG ONLY
 *
 * Analysis timeframes:
 * 15m = Early detection
 * 1h  = Momentum confirmation
 * 4h  = Trend confirmation
 *
 * Scan interval is external (every 5 minutes).
 * Scan interval NEVER contributes to score.
 *
 * No 5m analysis.
 * No entry / stop loss / targets.
 * No short signals.
 *
 * Buy pressure is estimated from candle price behavior.
 * Public trade size sign is NOT treated as verified taker side.
 *
 * File: src/scanner/marketScanner.js
 */

import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',

  TIMEFRAMES: {
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 }
  },

  TOP_COUNT: 30,

  MIN_QUOTE_VOLUME_24H: 100000,

  CONCURRENCY: 8,

  REQUEST_TIMEOUT: 15000,

  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,

  TELEGRAM_DELAY: 400,

  MIN_PRICE_CHANGE_15M: 0.12,

  MIN_PRESSURE_SCORE: 54,

  MIN_VOLUME_RATIO_15M: 1.15,

  MIN_SCORE: 48,

  VOLUME_BASELINE_CANDLES: 20,

  MIN_CANDLE_ELAPSED_SECONDS: 90
};

// ============================================================
// UTILITIES
// ============================================================

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const median = values => {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const pctChange = (current, previous) => {
  if (!previous || previous <= 0) return 0;

  return ((current - previous) / previous) * 100;
};

const formatPrice = value => {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);

  return value.toPrecision(5);
};

const getContractMultiplier = contract => {
  const multiplier = number(contract?.quanto_multiplier, 1);

  return multiplier > 0 ? multiplier : 1;
};

// ============================================================
// CANDLE TURNOVER
// ============================================================

// Gate futures candles:
// sum = quote-currency turnover.
// v   = contract volume.
//
// Prefer sum. Only use the approximate fallback when sum
// is unavailable.

const candleValue = (candle, multiplier = 1) => {
  const turnover = number(candle?.turnover);

  if (turnover > 0) {
    return turnover;
  }

  const volume = Math.max(0, number(candle?.volume));
  const close = Math.max(0, number(candle?.close));

  return volume * close * multiplier;
};

// ============================================================
// HTTP
// ============================================================

async function fetchJSON(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
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

// ============================================================
// GATE.IO API
// ============================================================

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
    limit: String(limit)
  });

  const raw = await fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`
  );

  if (!Array.isArray(raw)) {
    throw new Error(`Invalid candles: ${contract} ${interval}`);
  }

  const candles = raw
    .map(c => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),
      volume: number(c.v),
      turnover: number(c.sum)
    }))
    .filter(c =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  const seconds = CONFIG.TIMEFRAMES[interval].seconds;

  const currentBucket =
    Math.floor(Date.now() / 1000 / seconds) * seconds;

  const closed = candles.filter(
    c => c.time < currentBucket
  );

  if (!includeCurrent) return closed;

  const current =
    candles.find(c => c.time === currentBucket) || null;

  return { closed, current };
}

// ============================================================
// CONCURRENCY
// ============================================================

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = {
          error: error.message,
          item: items[index]
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runner()
    )
  );

  return results;
}

// ============================================================
// PRICE MOMENTUM
// ============================================================

function analyzeMomentum(
  candles1h,
  candles4h,
  current15m,
  livePrice
) {
  const last1h = candles1h.at(-1);
  const previous1h = candles1h.at(-2);

  const last4h = candles4h.at(-1);
  const previous4h = candles4h.at(-2);

  const price = number(livePrice);

  if (
    !current15m ||
    !last1h ||
    !previous1h ||
    !last4h ||
    !previous4h ||
    !price
  ) {
    return null;
  }

  // Current 15m candle: live price versus candle open.
  const return15m = pctChange(
    price,
    current15m.open
  );

  // One-hour momentum: latest closed 1h candle versus
  // the immediately preceding closed 1h candle.
  const return1h = pctChange(
    last1h.close,
    previous1h.close
  );

  // Four-hour momentum: latest closed 4h candle versus
  // the immediately preceding closed 4h candle.
  const return4h = pctChange(
    last4h.close,
    previous4h.close
  );

  const currentHigh = Math.max(
    current15m.high,
    price
  );

  const currentLow = Math.min(
    current15m.low,
    price
  );

  const currentRange = currentHigh - currentLow;

  const closeLocation =
    currentRange > 0
      ? clamp(
          (price - currentLow) / currentRange,
          0,
          1
        )
      : 0.5;

  const bullish15m = return15m > 0;
  const bullish1h = return1h > 0;
  const bullish4h = return4h > 0;

  return {
    return15m,
    return1h,
    return4h,

    closeLocation,

    bullish15m,
    bullish1h,
    bullish4h
  };
}

// ============================================================
// ESTIMATED BUY PRESSURE
// ============================================================

// IMPORTANT:
// This is a price-action pressure estimate.
// It is NOT verified aggressive taker-buy volume.

function analyzeBuyPressure(momentum) {
  const locationScore =
    momentum.closeLocation * 100;

  const bodyStrength = clamp(
    momentum.return15m / 0.50,
    -1,
    1
  );

  const bodyScore =
    50 + bodyStrength * 50;

  const pressureScore = clamp(
    locationScore * 0.65 +
    bodyScore * 0.35,
    0,
    100
  );

  return {
    score: pressureScore,
    closeLocation: momentum.closeLocation,
    quality: 'ESTIMATED'
  };
}

// ============================================================
// VOLUME EXPANSION
// ============================================================

function getClosedVolumeExpansion(
  candles,
  multiplier
) {
  if (candles.length < CONFIG.VOLUME_BASELINE_CANDLES + 1) {
    return 0;
  }

  const recent = candles.at(-1);

  const baselineCandles = candles.slice(
    -(CONFIG.VOLUME_BASELINE_CANDLES + 1),
    -1
  );

  const baseline = median(
    baselineCandles.map(c =>
      candleValue(c, multiplier)
    )
  );

  if (!recent || baseline <= 0) return 0;

  // Keep the real ratio. Do not cap it at 12x.
  return candleValue(recent, multiplier) / baseline;
}

function getCurrent15mVolumeExpansion(
  closedCandles,
  currentCandle,
  multiplier
) {
  if (!currentCandle) return 0;

  if (
    closedCandles.length <
    CONFIG.VOLUME_BASELINE_CANDLES
  ) {
    return 0;
  }

  const baselineCandles = closedCandles.slice(
    -CONFIG.VOLUME_BASELINE_CANDLES
  );

  const baseline = median(
    baselineCandles.map(c =>
      candleValue(c, multiplier)
    )
  );

  if (baseline <= 0) return 0;

  const nowSeconds = Date.now() / 1000;

  const elapsedSeconds = clamp(
    nowSeconds - currentCandle.time,
    CONFIG.MIN_CANDLE_ELAPSED_SECONDS,
    CONFIG.TIMEFRAMES['15m'].seconds
  );

  // Estimate the expected turnover proportionally
  // to elapsed time in the current 15m candle.
  const expectedVolume =
    baseline *
    (
      elapsedSeconds /
      CONFIG.TIMEFRAMES['15m'].seconds
    );

  if (expectedVolume <= 0) return 0;

  // Keep actual expansion ratio without artificial cap.
  return (
    candleValue(currentCandle, multiplier) /
    expectedVolume
  );
}

// ============================================================
// SCORING
// ============================================================

function calculatePressureScore(pressure) {
  return clamp(
    pressure.score,
    0,
    100
  );
}

function calculatePriceScore(momentum) {
  const score15 = clamp(
    50 + momentum.return15m * 25,
    0,
    100
  );

  const score1h = clamp(
    50 + momentum.return1h * 8,
    0,
    100
  );

  const score4h = clamp(
    50 + momentum.return4h * 4,
    0,
    100
  );

  return (
    score15 * 0.50 +
    score1h * 0.30 +
    score4h * 0.20
  );
}

function calculateVolumeScore(
  ratio15,
  ratio1h,
  ratio4h
) {
  // Logarithmic scoring preserves the difference between
  // high-volume coins without allowing volume alone
  // to dominate the complete ranking.
  const score = ratio => {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return 0;
    }

    return clamp(
      Math.log2(Math.max(0.01, ratio)) * 35 + 50,
      0,
      100
    );
  };

  return (
    score(ratio15) * 0.50 +
    score(ratio1h) * 0.30 +
    score(ratio4h) * 0.20
  );
}

function calculateAlignmentScore(momentum) {
  let score = 0;

  if (momentum.bullish15m) score += 40;
  if (momentum.bullish1h) score += 35;
  if (momentum.bullish4h) score += 25;

  return score;
}

// ============================================================
// COIN ANALYSIS
// ============================================================

function analyzeCoin(data) {
  const {
    symbol,
    candles15m,
    candles1h,
    candles4h,
    current15m,
    livePrice,
    contract
  } = data;

  if (
    candles15m.length < 25 ||
    candles1h.length < 25 ||
    candles4h.length < 25 ||
    !current15m
  ) {
    return null;
  }

  const multiplier = getContractMultiplier(contract);

  const momentum = analyzeMomentum(
    candles1h,
    candles4h,
    current15m,
    livePrice
  );

  if (!momentum) return null;

  const pressure = analyzeBuyPressure(momentum);

  const volume15m = getCurrent15mVolumeExpansion(
    candles15m,
    current15m,
    multiplier
  );

  const volume1h = getClosedVolumeExpansion(
    candles1h,
    multiplier
  );

  const volume4h = getClosedVolumeExpansion(
    candles4h,
    multiplier
  );

  // ----------------------------------------------------------
  // HARD FILTERS
  // ----------------------------------------------------------

  if (
    pressure.score <
    CONFIG.MIN_PRESSURE_SCORE
  ) {
    return null;
  }

  if (
    momentum.return15m <
    CONFIG.MIN_PRICE_CHANGE_15M
  ) {
    return null;
  }

  if (
    volume15m <
    CONFIG.MIN_VOLUME_RATIO_15M
  ) {
    return null;
  }

  // ----------------------------------------------------------
  // SINGLE SCORE
  // ----------------------------------------------------------

  const flowScore = calculatePressureScore(
    pressure
  );

  const priceScore = calculatePriceScore(
    momentum
  );

  const volumeScore = calculateVolumeScore(
    volume15m,
    volume1h,
    volume4h
  );

  const alignmentScore = calculateAlignmentScore(
    momentum
  );

  const score = Math.round(
    flowScore * 0.35 +
    priceScore * 0.25 +
    volumeScore * 0.25 +
    alignmentScore * 0.15
  );

  if (score < CONFIG.MIN_SCORE) return null;

  const strength =
    score >= 85
      ? 'فشار صعودی بسیار قوی'
      : score >= 70
        ? 'فشار صعودی قوی'
        : score >= 55
          ? 'فشار صعودی'
          : 'شروع اولیه';

  const confirmations = [
    momentum.bullish15m ? '15m' : null,
    momentum.bullish1h ? '1h' : null,
    momentum.bullish4h ? '4h' : null
  ].filter(Boolean);

  return {
    symbol,

    price: livePrice,
    livePrice,

    score,
    strength,

    pressureScore: pressure.score,
    pressureQuality: pressure.quality,
    closeLocation: pressure.closeLocation,

    momentum: {
      '15m': momentum.return15m,
      '1h': momentum.return1h,
      '4h': momentum.return4h
    },

    volume: {
      '15m': volume15m,
      '1h': volume1h,
      '4h': volume4h
    },

    components: {
      flow: Math.round(flowScore),
      price: Math.round(priceScore),
      volume: Math.round(volumeScore),
      alignment: Math.round(alignmentScore)
    },

    confirmations,
    contract
  };
}

// ============================================================
// TELEGRAM
// ============================================================

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
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    const error = new Error(
      result.description || `Telegram HTTP ${response.status}`
    );

    error.retryAfter = result.parameters?.retry_after;
    throw error;
  }
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text.split('\n\n').filter(Boolean);
  const messages = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current
      ? `${current}\n\n${block}`
      : block;

    if (candidate.length <= maxLength) {
      current = candidate;
    } else {
      if (current) messages.push(current);
      current = block;
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
      `📄 گزارش ${i + 1}/${messages.length}\n\n` +
      messages[i];

    try {
      await sendTelegram(payload);
    } catch (error) {
      if (!error.retryAfter) throw error;

      await sleep(error.retryAfter * 1000 + 500);
      await sendTelegram(payload);
    }

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_DELAY);
    }
  }
}

// ============================================================
// REPORT
// ============================================================

function buildReport(candidates, stats, duration, rankChanges) {
  const lines = [
    '🚀 GATE.IO | LONG BUY PRESSURE RADAR',
    '━━━━━━━━━━━━━━━━━━',
    '🎯 افزایش قیمت + افزایش گردش مالی + فشار صعودی قیمت',
    '⏱ تحلیل: 15M | 1H | 4H',
    '🔄 اجرای اسکن هر ۵ دقیقه؛ بدون دخالت در امتیاز',
    `📊 بازار: ${stats.active} | نقدشونده: ${stats.liquid}`,
    `✅ موفق: ${stats.success} | خطا: ${stats.errors}`,
    `⏱ زمان اسکن: ${(duration / 1000).toFixed(1)} ثانیه`,
    '━━━━━━━━━━━━━━━━━━'
  ];

  if (!candidates.length) {
    lines.push(
      'در حال حاضر ارز واجد شرایط پیدا نشد.'
    );

    return lines.join('\n');
  }

  candidates.forEach((coin, index) => {
    const change = rankChanges?.[coin.symbol];

    const rankIcon =
      !change || change.status === 'NEW'
        ? '🆕'
        : change.status === 'UP'
          ? `🟢↑${change.change}`
          : change.status === 'DOWN'
            ? `🔴↓${Math.abs(change.change)}`
            : '➖';

    lines.push(
      `${index + 1}. ${coin.symbol} ${rankIcon} | قدرت ${coin.score}/100`
    );

    lines.push(
      `🟢 ${coin.strength} | 15m +${coin.momentum['15m'].toFixed(2)}% | حجم ${coin.volume['15m'].toFixed(2)}x | فشار ${coin.pressureScore.toFixed(1)}/100`
    );

    lines.push('');
  });

  lines.push(
    '━━━━━━━━━━━━━━━━━━',
    'ℹ️ فشار خرید، تخمین مبتنی بر رفتار قیمت است؛ نه داده قطعی معاملات تهاجمی.'
  );

  return lines.join('\n');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const startedAt = Date.now();

  console.log('\n🚀 GATE.IO LONG BUY PRESSURE RADAR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('⏱ Analysis: 15m / 1h / 4h');
  console.log('🔄 Scan schedule does not affect score');

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers()
  ]);

  if (
    !Array.isArray(contracts) ||
    !Array.isArray(tickers)
  ) {
    throw new Error('داده قراردادها یا تیکرها معتبر نیست.');
  }

  const tickerMap = new Map(
    tickers.map(ticker => [
      ticker.contract,
      ticker
    ])
  );

  const activeContracts = contracts.filter(
    contract =>
      contract?.name &&
      contract.in_delisting !== true &&
      tickerMap.has(contract.name)
  );

  const liquidMarkets = activeContracts
    .map(contract => {
      const ticker = tickerMap.get(contract.name);

      return {
        symbol: contract.name,
        contract,
        ticker,
        quoteVolume: number(ticker.volume_24h_quote),
        lastPrice: number(ticker.last)
      };
    })
    .filter(market =>
      market.lastPrice > 0 &&
      market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log(`📊 Active: ${activeContracts.length}`);
  console.log(`💧 Liquid: ${liquidMarkets.length}`);

  let success = 0;
  let errors = 0;

  const results = await mapLimit(
    liquidMarkets,
    CONFIG.CONCURRENCY,
    async market => {
      const [
        candles15Data,
        candles1h,
        candles4h
      ] = await Promise.all([
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
        )
      ]);

      if (
        candles15Data.closed.length < 25 ||
        candles1h.length < 25 ||
        candles4h.length < 25 ||
        !candles15Data.current
      ) {
        throw new Error(
          'کندل کافی یا کندل جاری 15m دریافت نشد.'
        );
      }

      const coin = analyzeCoin({
        symbol: market.symbol,

        candles15m: candles15Data.closed,
        candles1h,
        candles4h,

        current15m: candles15Data.current,

        livePrice: market.lastPrice,

        contract: market.contract
      });

      success++;

      return coin;
    }
  );

  const candidates = [];

  for (const result of results) {
    if (result?.error) {
      errors++;

      console.error(
        `⚠️ ${result.item?.name || 'UNKNOWN'}: ${result.error}`
      );

      continue;
    }

    if (result) candidates.push(result);
  }

  // ----------------------------------------------------------
  // STORAGE + SINGLE RANKING
  // ----------------------------------------------------------

  const storageResult = await saveMarketSnapshot(candidates);

  const rankedCandidates =
    storageResult.rankedCandidates || candidates;

  const rankChanges = storageResult.rankChanges || {};

  const duration = Date.now() - startedAt;

  const stats = {
    active: activeContracts.length,
    liquid: liquidMarkets.length,
    success,
    errors
  };

  // ----------------------------------------------------------
  // CONSOLE
  // ----------------------------------------------------------

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏆 TOP LONG CANDIDATES');

  rankedCandidates
    .slice(0, CONFIG.TOP_COUNT)
    .forEach(coin => {
      console.log(
        `${coin.rank}. ${coin.symbol} | ${coin.score}/100 | Pressure ${coin.pressureScore.toFixed(1)} | Volume ${coin.volume['15m'].toFixed(2)}x`
      );
    });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Candidates: ${rankedCandidates.length}`);
  console.log(`Successful: ${success}`);
  console.log(`Errors: ${errors}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);

  console.log(
    `💾 History: ${storageResult.historyCount} | Summaries: ${storageResult.summaryCount}`
  );

  // ----------------------------------------------------------
  // TELEGRAM
  // ----------------------------------------------------------

  await sendReports(
    buildReport(
      rankedCandidates.slice(0, CONFIG.TOP_COUNT),
      stats,
      duration,
      rankChanges
    )
  );

  console.log('\n✅ Telegram report sent.');
}

// ============================================================
// START
// ============================================================

main().catch(error => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
