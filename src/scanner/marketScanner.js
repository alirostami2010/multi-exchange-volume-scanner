/**
 * GATE.IO USDT PERPETUAL — HOURLY VOLUME & BUYER-SELLER PRESSURE RADAR
 * --------------------------------------------------------------------
 * File: src/scanner/marketScanner.js
 * Node.js 20+
 *
 * Design:
 * - Closed 1h candles: price + total quote volume history.
 * - Closed 1h contract stats: long/short taker volume per hour when provided
 *   by Gate's public contract_stats endpoint.
 * - Current open 1h candle: live recent signed trades, with explicit sample
 *   quality/truncation metadata.
 * - Short-term buy acceleration is compared only against a sufficiently
 *   large equal-duration baseline; no infinite/meaningless ratios.
 * - Telegram delivery errors do not mark a successfully completed scan
 *   as failed.
 *
 * No order execution.
 */

import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',

  MIN_QUOTE_VOLUME_24H: Number(process.env.MIN_QUOTE_VOLUME_24H ?? 75000),

  TRADE_LIMIT: 1000,
  HISTORY_HOURS: 24,
  HISTORY_REPORT_HOURS: 6,

  TOP_COUNT: 25,
  CONCURRENCY: 5,
  REQUEST_SPACING_MS: 120,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3800,

  MIN_RECENT_BUY_NOTIONAL: Number(process.env.MIN_RECENT_BUY_NOTIONAL ?? 1500),
  MIN_BUY_SHARE: Number(process.env.MIN_BUY_SHARE ?? 56),
  MIN_BUY_RATE_MULTIPLE: Number(process.env.MIN_BUY_RATE_MULTIPLE ?? 1.35),
  MIN_PREVIOUS_BUY_BASELINE: Number(process.env.MIN_PREVIOUS_BUY_BASELINE ?? 300),
  MIN_SCORE_TO_REPORT: Number(process.env.MIN_SCORE_TO_REPORT ?? 48),

  MIN_HISTORY_CANDLES: 4,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const num = value => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};

const positive = value => Number.isFinite(value) && value > 0;
const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));
const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const fmt = (value, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

const pctChange = (current, previous) =>
  positive(previous) ? ((current - previous) / previous) * 100 : 0;

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const slot = requestQueue.then(async () => {
    const wait = CONFIG.REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });

  requestQueue = slot.catch(() => {});
  await slot;

  let lastError;

  for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        const payload = await response.json();
        return payload;
      }

      const body = await response.text().catch(() => '');
      const error = new Error(
        `Gate HTTP ${response.status} ${path}: ${body.slice(0, 180)}`
      );
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);

      if (
        ![408, 425, 429, 500, 502, 503, 504].includes(response.status)
      ) {
        throw error;
      }

      lastError = error;
    } catch (error) {
      lastError = error;

      const permanentClientError =
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 425, 429].includes(error.status);

      if (attempt === CONFIG.RETRIES || permanentClientError) break;
    }

    const delay =
      lastError?.status === 429 && lastError.retryAfter > 0
        ? Math.min(lastError.retryAfter * 1000, 30000)
        : Math.min(500 * (2 ** attempt), 8000);

    await sleep(delay);
  }

  throw lastError || new Error(`Gate request failed: ${path}`);
}

async function mapPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const index = cursor++;
          if (index >= items.length) return;

          try {
            output[index] = await worker(items[index], index);
          } catch (error) {
            output[index] = {
              __error: error?.message || String(error),
              symbol: items[index]?.symbol,
            };
          }
        }
      }
    )
  );

  return output;
}

function normalizeTradeTime(trade) {
  const milliseconds = num(trade?.create_time_ms);

  if (milliseconds != null && milliseconds > 0) {
    // Gate documents create_time_ms as Unix milliseconds.
    return milliseconds / 1000;
  }

  const seconds = num(trade?.create_time);
  return seconds != null && seconds > 0 ? seconds : null;
}

function tradeNotional(trade, multiplier) {
  const signedSize = num(trade?.size);
  const price = num(trade?.price);

  if (signedSize == null || price == null || !positive(price)) {
    return null;
  }

  const time = normalizeTradeTime(trade);
  if (time == null) return null;

  const contractMultiplier = positive(multiplier) ? multiplier : 1;

  return {
    signedSize,
    notional: Math.abs(signedSize) * contractMultiplier * price,
    time,
  };
}

function aggregateCurrentTrades(trades, multiplier, hourStart, nowSeconds) {
  const minuteBuckets = new Map();

  let buyHour = 0;
  let sellHour = 0;
  let validTrades = 0;
  let oldestTime = Infinity;

  for (const trade of trades || []) {
    const item = tradeNotional(trade, multiplier);
    if (!item) continue;
    if (item.time < hourStart || item.time > nowSeconds + 2) continue;

    validTrades++;
    oldestTime = Math.min(oldestTime, item.time);

    const minute = Math.floor(item.time / 60) * 60;
    const bucket = minuteBuckets.get(minute) || {
      buy: 0,
      sell: 0,
      count: 0,
    };

    if (item.signedSize > 0) {
      buyHour += item.notional;
      bucket.buy += item.notional;
    } else if (item.signedSize < 0) {
      sellHour += item.notional;
      bucket.sell += item.notional;
    }

    bucket.count++;
    minuteBuckets.set(minute, bucket);
  }

  const currentMinute = Math.floor(nowSeconds / 60) * 60;
  const bucketAt = minute =>
    minuteBuckets.get(minute) || { buy: 0, sell: 0, count: 0 };

  const sumWindow = (start, end, key) => {
    let total = 0;
    for (let time = start; time < end; time += 60) {
      total += bucketAt(time)[key];
    }
    return total;
  };

  const last3Start = currentMinute - 2 * 60;
  const previous3Start = currentMinute - 5 * 60;
  const prior3Start = currentMinute - 8 * 60;

  const buyLast3 = sumWindow(last3Start, currentMinute + 60, 'buy');
  const sellLast3 = sumWindow(last3Start, currentMinute + 60, 'sell');

  const buyPrevious3 = sumWindow(previous3Start, last3Start, 'buy');
  const sellPrevious3 = sumWindow(previous3Start, last3Start, 'sell');

  const buyPrior3 = sumWindow(prior3Start, previous3Start, 'buy');

  const buyRateLast = buyLast3 / 3;
  const buyRatePrevious = buyPrevious3 / 3;
  const buyRatePrior = buyPrior3 / 3;

  // Ignore tiny denominators. They must not create 100x/700x fake acceleration.
  const validBaseline =
    buyPrevious3 >= CONFIG.MIN_PREVIOUS_BUY_BASELINE;

  const rateMultiple = validBaseline
    ? buyRateLast / Math.max(buyRatePrevious, 1)
    : null;

  const acceleration =
    rateMultiple != null && buyPrior3 >= CONFIG.MIN_PREVIOUS_BUY_BASELINE
      ? rateMultiple - (buyRatePrevious / Math.max(buyRatePrior, 1))
      : null;

  const totalHour = buyHour + sellHour;
  const recentTotal = buyLast3 + sellLast3;

  const buyShareHour = totalHour > 0 ? (buyHour / totalHour) * 100 : 0;
  const buyShareRecent =
    recentTotal > 0 ? (buyLast3 / recentTotal) * 100 : 0;

  const deltaHour = buyHour - sellHour;
  const deltaRecent = buyLast3 - sellLast3;

  const recentMinuteBuckets = [];
  for (let time = last3Start; time <= currentMinute; time += 60) {
    const bucket = bucketAt(time);
    recentMinuteBuckets.push({
      buy: bucket.buy,
      sell: bucket.sell,
      total: bucket.buy + bucket.sell,
    });
  }

  const positiveBuyMinutes =
    recentMinuteBuckets.filter(item => item.buy > 0).length;

  const persistence =
    recentMinuteBuckets.length > 0
      ? (positiveBuyMinutes / recentMinuteBuckets.length) * 100
      : 0;

  const truncated = (trades || []).length >= CONFIG.TRADE_LIMIT;
  const elapsedSeconds = Math.max(1, nowSeconds - hourStart);

  const coveragePct = truncated && Number.isFinite(oldestTime)
    ? Math.min(100, ((nowSeconds - oldestTime) / elapsedSeconds) * 100)
    : truncated
      ? 0
      : 100;

  return {
    buyHour,
    sellHour,
    totalHour,
    buyShareHour,
    deltaHour,

    buyLast3,
    sellLast3,
    recentTotal,
    buyShareRecent,
    deltaRecent,

    buyPrevious3,
    sellPrevious3,
    buyPrior3,

    buyRateLast,
    buyRatePrevious,
    buyRatePrior,
    rateMultiple,
    acceleration,
    validBaseline,

    persistence,
    positiveBuyMinutes,
    validTrades,
    oldestTime,
    truncated,
    coveragePct: round(coveragePct, 0),
  };
}

function normalizeCandle(raw) {
  const time = num(raw?.t);
  const open = num(raw?.o);
  const high = num(raw?.h);
  const low = num(raw?.l);
  const close = num(raw?.c);
  const volumeContracts = num(raw?.v);
  const quoteTurnover = num(raw?.sum);

  if (
    time == null ||
    !positive(open) ||
    !positive(high) ||
    !positive(low) ||
    !positive(close)
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volumeContracts: volumeContracts ?? 0,
    quoteTurnover: quoteTurnover ?? 0,
  };
}

function normalizeContractStat(raw) {
  const time = num(raw?.time);
  if (time == null) return null;

  return {
    time,
    longTakerContracts: num(raw?.long_taker_size),
    shortTakerContracts: num(raw?.short_taker_size),
    markPrice: num(raw?.mark_price),
    takerLongShortRatio: num(raw?.lsr_taker),
  };
}

function buildHourlyHistory(rawCandles, rawStats, multiplier, nowSeconds) {
  const currentHourStart = Math.floor(nowSeconds / 3600) * 3600;

  const candles = (rawCandles || [])
    .map(normalizeCandle)
    .filter(Boolean)
    .filter(candle => candle.time < currentHourStart)
    .sort((a, b) => a.time - b.time);

  const statsByHour = new Map();

  for (const raw of rawStats || []) {
    const stat = normalizeContractStat(raw);
    if (!stat) continue;

    const bucket = Math.floor(stat.time / 3600) * 3600;
    if (bucket >= currentHourStart) continue;

    statsByHour.set(bucket, stat);
  }

  return candles.map(candle => {
    const stat = statsByHour.get(candle.time) || null;

    const referencePrice =
      positive(candle.close)
        ? candle.close
        : stat?.markPrice;

    const longTakerQuote =
      stat?.longTakerContracts != null && positive(multiplier) && positive(referencePrice)
        ? Math.abs(stat.longTakerContracts) * multiplier * referencePrice
        : null;

    const shortTakerQuote =
      stat?.shortTakerContracts != null && positive(multiplier) && positive(referencePrice)
        ? Math.abs(stat.shortTakerContracts) * multiplier * referencePrice
        : null;

    const hasDirectionalStats =
      longTakerQuote != null && shortTakerQuote != null;

    const directionalTotal = hasDirectionalStats
      ? longTakerQuote + shortTakerQuote
      : null;

    return {
      time: candle.time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,

      totalQuoteVolume: candle.quoteTurnover,

      buyQuoteVolume: longTakerQuote,
      sellQuoteVolume: shortTakerQuote,

      buySharePct:
        hasDirectionalStats && directionalTotal > 0
          ? (longTakerQuote / directionalTotal) * 100
          : null,

      deltaQuote:
        hasDirectionalStats
          ? longTakerQuote - shortTakerQuote
          : null,

      hasDirectionalStats,
      priceChangePct: pctChange(candle.close, candle.open),
    };
  });
}

function analyzeHourlyHistory(history) {
  const recent = history.slice(-CONFIG.HISTORY_REPORT_HOURS);

  if (recent.length < CONFIG.MIN_HISTORY_CANDLES) {
    return {
      available: false,
      candles: recent,
      priceTrend: 'INSUFFICIENT_HISTORY',
      volumeTrend: 'INSUFFICIENT_HISTORY',
      sellerPressure: 'UNKNOWN',
      directionalCoverage: 0,
      priceDown: false,
      volumeFalling: false,
      sellerPressureFalling: false,
      buyShareImproving: false,
    };
  }

  const first = recent[0];
  const last = recent.at(-1);

  const firstClose = first.close;
  const lastClose = last.close;

  const recent3 = recent.slice(-3);
  const previous3 = history.slice(-6, -3);

  const recentVolumeAvg =
    recent3.reduce((sum, candle) => sum + candle.totalQuoteVolume, 0) /
    Math.max(1, recent3.length);

  const previousVolumeAvg =
    previous3.length > 0
      ? previous3.reduce((sum, candle) => sum + candle.totalQuoteVolume, 0) /
        previous3.length
      : null;

  const priceDown = lastClose < firstClose;
  const volumeFalling =
    previousVolumeAvg != null &&
    previousVolumeAvg > 0 &&
    recentVolumeAvg < previousVolumeAvg * 0.9;

  const directionalCandles = recent.filter(candle => candle.hasDirectionalStats);
  const directionalCoverage =
    recent.length > 0
      ? (directionalCandles.length / recent.length) * 100
      : 0;

  let sellerPressureFalling = false;
  let buyShareImproving = false;

  const recentDirectional = recent3.filter(candle => candle.hasDirectionalStats);
  const previousDirectional = previous3.filter(candle => candle.hasDirectionalStats);

  if (recentDirectional.length >= 2 && previousDirectional.length >= 2) {
    const recentSellAvg =
      recentDirectional.reduce((sum, candle) => sum + candle.sellQuoteVolume, 0) /
      recentDirectional.length;

    const previousSellAvg =
      previousDirectional.reduce((sum, candle) => sum + candle.sellQuoteVolume, 0) /
      previousDirectional.length;

    sellerPressureFalling =
      previousSellAvg > 0 && recentSellAvg < previousSellAvg * 0.9;

    const recentBuyShare =
      recentDirectional.reduce((sum, candle) => sum + candle.buySharePct, 0) /
      recentDirectional.length;

    const previousBuyShare =
      previousDirectional.reduce((sum, candle) => sum + candle.buySharePct, 0) /
      previousDirectional.length;

    buyShareImproving = recentBuyShare > previousBuyShare + 3;
  }

  return {
    available: true,
    candles: recent,

    priceChangePct: pctChange(lastClose, firstClose),
    recentVolumeAvg,
    previousVolumeAvg,

    priceTrend: priceDown ? 'DOWN' : lastClose > firstClose ? 'UP' : 'FLAT',
    volumeTrend:
      previousVolumeAvg == null
        ? 'NO_BASELINE'
        : volumeFalling
          ? 'FALLING'
          : recentVolumeAvg > previousVolumeAvg * 1.1
            ? 'RISING'
            : 'STABLE',

    sellerPressure:
      directionalCoverage < 60
        ? 'INSUFFICIENT_DIRECTIONAL_DATA'
        : sellerPressureFalling
          ? 'FALLING'
          : 'NOT_FALLING',

    directionalCoverage: round(directionalCoverage, 0),

    priceDown,
    volumeFalling,
    sellerPressureFalling,
    buyShareImproving,
  };
}

function scoreVolume(metrics, hourly) {
  let score = 0;

  score += clamp((metrics.buyShareRecent - 50) * 1.1, 0, 22);
  score += clamp((metrics.buyShareHour - 50) * 0.35, 0, 10);

  if (metrics.rateMultiple != null) {
    score += clamp((metrics.rateMultiple - 1) * 13, 0, 22);
  }

  if (metrics.acceleration != null) {
    score += clamp((metrics.acceleration + 0.1) * 12, 0, 10);
  }

  score += clamp(metrics.persistence * 0.14, 0, 10);

  if (metrics.deltaRecent > 0) score += 6;
  if (metrics.buyLast3 >= CONFIG.MIN_RECENT_BUY_NOTIONAL * 2) score += 5;

  // Historical context helps identify buying against a weakening selloff.
  if (hourly?.priceDown && hourly?.volumeFalling) score += 7;
  if (hourly?.sellerPressureFalling) score += 5;
  if (hourly?.buyShareImproving) score += 3;

  return clamp(score, 0, 100);
}

function classify(metrics, hourly, score) {
  const buyShareStrong = metrics.buyShareRecent >= CONFIG.MIN_BUY_SHARE;
  const buyFlowStrong =
    metrics.buyLast3 >= CONFIG.MIN_RECENT_BUY_NOTIONAL;

  const accelerationStrong =
    metrics.rateMultiple != null &&
    metrics.rateMultiple >= CONFIG.MIN_BUY_RATE_MULTIPLE;

  const deltaPositive = metrics.deltaRecent > 0;

  const coreBuyEvidence =
    buyShareStrong &&
    buyFlowStrong &&
    deltaPositive &&
    score >= CONFIG.MIN_SCORE_TO_REPORT;

  if (
    coreBuyEvidence &&
    accelerationStrong &&
    hourly?.priceDown &&
    (hourly?.volumeFalling || hourly?.sellerPressureFalling)
  ) {
    return {
      status: 'EARLY_REVERSAL_ATTEMPT',
      label: 'افزایش خرید در دل فشار نزولی یک‌ساعته',
    };
  }

  if (
    coreBuyEvidence &&
    accelerationStrong
  ) {
    return {
      status: 'BUY_ACCELERATING',
      label: 'شتاب ورود خرید تهاجمی',
    };
  }

  if (
    metrics.buyShareRecent >= 53 &&
    metrics.buyLast3 >= CONFIG.MIN_RECENT_BUY_NOTIONAL * 0.5 &&
    metrics.deltaRecent > 0
  ) {
    return {
      status: 'BUY_BUILDING',
      label: 'افزایش اولیه فعالیت خریداران؛ نیازمند تداوم',
    };
  }

  return null;
}

function analyzeMarket(market, trades, rawCandles, rawStats, nowSeconds) {
  const multiplier = num(market.contract.quanto_multiplier);

  if (!positive(multiplier)) {
    return { symbol: market.symbol, __error: 'quanto_multiplier نامعتبر است' };
  }

  const hourStart = Math.floor(nowSeconds / 3600) * 3600;

  const metrics = aggregateCurrentTrades(
    trades,
    multiplier,
    hourStart,
    nowSeconds
  );

  const history = buildHourlyHistory(
    rawCandles,
    rawStats,
    multiplier,
    nowSeconds
  );

  const hourly = analyzeHourlyHistory(history);

  if (!metrics.validTrades || metrics.recentTotal <= 0) return null;

  const score = scoreVolume(metrics, hourly);
  const classification = classify(metrics, hourly, score);

  if (!classification) return null;

  const ticker = market.ticker;

  const hourlyCandles = hourly.candles.map(candle => ({
    time: new Date(candle.time * 1000).toISOString(),
    open: candle.open,
    close: candle.close,
    priceChangePct: round(candle.priceChangePct, 2),
    totalVolumeUSDT: round(candle.totalQuoteVolume, 2),
    buyVolumeUSDT: round(candle.buyQuoteVolume, 2),
    sellVolumeUSDT: round(candle.sellQuoteVolume, 2),
    buySharePct: round(candle.buySharePct, 1),
    deltaUSDT: round(candle.deltaQuote, 2),
    directionalDataAvailable: candle.hasDirectionalStats,
  }));

  return {
    symbol: market.symbol,
    contract: market.symbol,

    score: round(score, 1),
    rankScore: round(score, 1),

    status: classification.status,
    statusLabel: classification.label,

    price: num(ticker.last),
    change24h: num(ticker.change_percentage),
    quoteVolume24h: num(ticker.volume_24h_quote),

    currentHour: {
      buyNotionalSample: round(metrics.buyHour, 2),
      sellNotionalSample: round(metrics.sellHour, 2),
      buySharePct: round(metrics.buyShareHour, 1),
      netDeltaSample: round(metrics.deltaHour, 2),
      sampleCoveragePct: metrics.coveragePct,
      sampleTruncated: metrics.truncated,
      sampleTrades: metrics.validTrades,
    },

    recent3m: {
      buyNotional: round(metrics.buyLast3, 2),
      sellNotional: round(metrics.sellLast3, 2),
      buySharePct: round(metrics.buyShareRecent, 1),
      netDelta: round(metrics.deltaRecent, 2),

      buyNotionalPerMinute: round(metrics.buyRateLast, 2),
      previousBuyNotionalPerMinute: round(metrics.buyRatePrevious, 2),

      buyRateMultiple: round(metrics.rateMultiple, 2),
      buyAcceleration: round(metrics.acceleration, 2),
      baselineValid: metrics.validBaseline,

      persistencePct: round(metrics.persistence, 0),
      activeBuyMinutes: metrics.positiveBuyMinutes,
    },

    hourlyHistory: {
      available: hourly.available,
      priceTrend: hourly.priceTrend,
      priceChangePct: round(hourly.priceChangePct, 2),
      volumeTrend: hourly.volumeTrend,
      sellerPressure: hourly.sellerPressure,
      sellerPressureFalling: hourly.sellerPressureFalling,
      buyShareImproving: hourly.buyShareImproving,
      directionalCoveragePct: hourly.directionalCoverage,
      candles: hourlyCandles,
    },

    // Keep the complete volume context in marketStorage snapshots as well.
    volume: {
      currentHour: {
        buyNotionalSample: round(metrics.buyHour, 2),
        sellNotionalSample: round(metrics.sellHour, 2),
        buySharePct: round(metrics.buyShareHour, 1),
        netDeltaSample: round(metrics.deltaHour, 2),
        sampleCoveragePct: metrics.coveragePct,
        sampleTruncated: metrics.truncated,
      },
      recent3m: {
        buyNotional: round(metrics.buyLast3, 2),
        sellNotional: round(metrics.sellLast3, 2),
        buySharePct: round(metrics.buyShareRecent, 1),
        netDelta: round(metrics.deltaRecent, 2),
        buyRateMultiple: round(metrics.rateMultiple, 2),
        persistencePct: round(metrics.persistence, 0),
      },
      hourlyHistory: {
        priceTrend: hourly.priceTrend,
        volumeTrend: hourly.volumeTrend,
        sellerPressure: hourly.sellerPressure,
        directionalCoveragePct: hourly.directionalCoverage,
        candles: hourlyCandles,
      },
    },

    tradesObserved: metrics.validTrades,

    dataQuality: {
      currentHour:
        metrics.truncated
          ? 'TRUNCATED_RECENT_TRADE_SAMPLE'
          : 'REST_TRADE_SAMPLE_COMPLETE_FOR_RETURNED_RANGE',
      hourlyDirectionalCoveragePct: hourly.directionalCoverage,
    },

    reasons: [
      metrics.buyShareRecent >= CONFIG.MIN_BUY_SHARE
        ? `سهم خرید تهاجمی سه دقیقه اخیر ${fmt(metrics.buyShareRecent, 1)}٪`
        : null,

      metrics.rateMultiple != null &&
      metrics.rateMultiple >= CONFIG.MIN_BUY_RATE_MULTIPLE
        ? `سرعت خرید ${fmt(metrics.rateMultiple, 2)} برابر بازه سه دقیقه قبل`
        : null,

      metrics.rateMultiple == null
        ? 'مبنای مقایسه سرعت خرید کافی نیست؛ نسبت شتاب محاسبه نشده'
        : null,

      metrics.deltaRecent > 0
        ? 'دلتا خرید سه دقیقه اخیر مثبت است'
        : null,

      hourly.priceDown && hourly.volumeFalling
        ? 'قیمت و حجم کل در تاریخچه یک‌ساعته رو به کاهش بوده‌اند'
        : null,

      hourly.sellerPressureFalling
        ? 'فشار فروش تهاجمی در کندل‌های یک‌ساعته اخیر کاهش یافته'
        : null,

      hourly.buyShareImproving
        ? 'سهم خرید تهاجمی در کندل‌های یک‌ساعته اخیر بهتر شده'
        : null,

      metrics.truncated
        ? 'توجه: سقف ۱۰۰۰ معامله؛ نمونه کندل جاری ممکن است ناقص باشد'
        : null,

      hourly.directionalCoverage < 60
        ? 'تفکیک تاریخی خرید/فروش برای بخشی از کندل‌ها در دسترس نیست'
        : null,
    ].filter(Boolean),

    _sort: {
      score,
      rateMultiple: metrics.rateMultiple,
      buyLast3: metrics.buyLast3,
    },
  };
}

function rankCandidates(items) {
  return items
    .sort((a, b) =>
      (b.score - a.score) ||
      ((b._sort?.rateMultiple ?? -1) - (a._sort?.rateMultiple ?? -1)) ||
      ((b._sort?.buyLast3 || 0) - (a._sort?.buyLast3 || 0))
    )
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function reportHourlyHistory(history) {
  if (!history?.candles?.length) {
    return 'تاریخچه کندل‌های بسته‌شده یک‌ساعته در دسترس نیست.';
  }

  return history.candles.map(candle => {
    const time = candle.time.slice(11, 16);
    const direction = candle.priceChangePct > 0
      ? 'مثبت'
      : candle.priceChangePct < 0
        ? 'منفی'
        : 'خنثی';

    const flow = candle.directionalDataAvailable
      ? `خرید ${fmt(candle.buyVolumeUSDT, 0)} / فروش ${fmt(candle.sellVolumeUSDT, 0)} USDT | سهم خرید ${fmt(candle.buySharePct, 1)}٪`
      : 'تفکیک خرید/فروش تاریخی موجود نیست';

    return `${time} | قیمت ${direction} ${fmt(candle.priceChangePct, 2)}٪ | حجم کل ${fmt(candle.totalVolumeUSDT, 0)} USDT | ${flow}`;
  }).join('\n');
}

function reportLine(item, index) {
  const current = item.currentHour;
  const recent = item.recent3m;
  const history = item.hourlyHistory;

  const speed =
    recent.buyRateMultiple == null
      ? 'مبنای ناکافی'
      : `${fmt(recent.buyRateMultiple, 2)}x`;

  const sampleQuality = current.sampleTruncated
    ? 'نمونه محدود به ۱۰۰۰ معامله اخیر'
    : 'نمونه معاملات بازه درخواست‌شده';

  return [
    `${index + 1}. ${item.symbol} | امتیاز حجم ${item.score}/100 | ${item.statusLabel}`,
    `قیمت: ${item.price ?? '—'} | گردش ۲۴ساعت: ${fmt(item.quoteVolume24h, 0)} USDT`,
    `کندل جاری ۱س (نمونه معاملات): خرید ${fmt(current.buyNotionalSample, 0)} / فروش ${fmt(current.sellNotionalSample, 0)} USDT | سهم خرید ${fmt(current.buySharePct, 1)}٪ | دلتا ${fmt(current.netDeltaSample, 0)}`,
    `۳ دقیقه اخیر: خرید ${fmt(recent.buyNotional, 0)} / فروش ${fmt(recent.sellNotional, 0)} USDT | سهم خرید ${fmt(recent.buySharePct, 1)}٪ | دلتا ${fmt(recent.netDelta, 0)}`,
    `سرعت خرید: ${fmt(recent.buyNotionalPerMinute, 0)} USDT/دقیقه | نسبت به ۳ دقیقه قبل: ${speed} | تداوم: ${fmt(recent.persistencePct, 0)}٪`,
    `تاریخچه ${history.candles.length} کندل بسته‌شده ۱س | روند قیمت: ${history.priceTrend} | روند حجم: ${history.volumeTrend} | فشار فروش: ${history.sellerPressure}`,
    `پوشش تفکیک تاریخی خرید/فروش: ${fmt(history.directionalCoveragePct, 0)}٪`,
    'جزئیات کندل‌های قبلی:',
    reportHourlyHistory(history),
    `کیفیت نمونه جاری: ${sampleQuality} | معاملات معتبر: ${item.tradesObserved}`,
    `شواهد: ${item.reasons.join('؛ ') || item.statusLabel}`,
  ].join('\n');
}

function buildReport(output) {
  const lines = [
    '📊 GATE.IO | رادار فشار خرید و فروش — تاریخچه ۱ساعته + رصد زنده',
    '━━━━━━━━━━━━━━━━━━',
    `زمان اسکن: ${output.scannedAt}`,
    `قرارداد فعال: ${output.stats.active} | بازار نقدشونده: ${output.stats.liquid} | بررسی موفق: ${output.stats.success} | خطا: ${output.stats.failed}`,
    `نامزدهای افزایش خرید: ${output.stats.candidates}`,
    'تاریخچه: کندل‌های بسته‌شده ۱ساعته + آمار long/short taker در صورت دسترسی.',
    'کندل جاری: معاملات واقعی نمونه‌برداری‌شده؛ در سقف ۱۰۰۰ معامله ممکن است نمونه ناقص باشد.',
    'مثبت بودن حجم معامله = جهت خرید تهاجمی؛ منفی بودن = جهت فروش تهاجمی.',
    '━━━━━━━━━━━━━━━━━━',
  ];

  if (!output.candidates.length) {
    lines.push('در این اسکن افزایش خرید با معیارهای فعلی پیدا نشد.');
  } else {
    output.candidates.forEach((item, index) => {
      lines.push(reportLine(item, index), '━━━━━━━━━━━━━━━━━━');
    });
  }

  lines.push(
    '⚠️ افزایش خرید به‌تنهایی تضمین صعود نیست؛ ممکن است خریدها جذب فروش شوند یا ناشی از بستن شورت باشند.'
  );

  return lines.join('\n');
}

function splitTelegramMessage(message) {
  const chunks = [];
  let current = '';

  for (const line of message.split('\n')) {
    if (
      (current + '\n' + line).length > CONFIG.TELEGRAM_MAX_LENGTH &&
      current
    ) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(message) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_TOKEN;

  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn(
      '[TELEGRAM] Credentials missing; report printed locally only.'
    );
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }

  const chunks = splitTelegramMessage(message);

  for (let index = 0; index < chunks.length; index++) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunks[index],
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.description ||
        `Telegram HTTP ${response.status} while sending part ${index + 1}/${chunks.length}`
      );
    }

    await sleep(250);
  }

  return { sent: true, parts: chunks.length };
}

async function getMarkets() {
  const [contracts, tickers] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/contracts`),
    requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);

  const tickerMap = new Map(
    (tickers || []).map(ticker => [ticker.contract, ticker])
  );

  const active = (contracts || []).filter(contract =>
    typeof contract.name === 'string' &&
    contract.name.endsWith('_USDT') &&
    contract.status === 'trading' &&
    contract.in_delisting === false &&
    positive(num(contract.quanto_multiplier))
  );

  const markets = active
    .map(contract => {
      const ticker = tickerMap.get(contract.name);
      const quoteVolume = num(ticker?.volume_24h_quote) ?? 0;

      return (
        ticker &&
        positive(num(ticker.last)) &&
        quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
      )
        ? {
            symbol: contract.name,
            contract,
            ticker,
            quoteVolume,
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  return { active, markets };
}

async function scanOneMarket(market, nowSeconds) {
  const hourStart = Math.floor(nowSeconds / 3600) * 3600;
  const historyStart =
    hourStart - CONFIG.HISTORY_HOURS * 3600;

  const [trades, candles, stats] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/trades`, {
      contract: market.symbol,
      from: hourStart,
      to: Math.floor(nowSeconds),
      limit: CONFIG.TRADE_LIMIT,
    }),

    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, {
      contract: market.symbol,
      interval: '1h',
      limit: CONFIG.HISTORY_HOURS + 2,
    }),

    requestGate(`/futures/${CONFIG.SETTLE}/contract_stats`, {
      contract: market.symbol,
      from: historyStart,
      interval: '1h',
      limit: CONFIG.HISTORY_HOURS + 2,
    }),
  ]);

  return analyzeMarket(
    market,
    trades,
    candles,
    stats,
    nowSeconds
  );
}

export async function scanGateMarkets() {
  const started = Date.now();
  const nowSeconds = Date.now() / 1000;

  console.log('\n📊 GATE.IO HOURLY BUY/SELL PRESSURE RADAR');

  const { active, markets } = await getMarkets();

  console.log(
    `Active contracts: ${active.length} | Liquid markets: ${markets.length}`
  );

  let completed = 0;
  let success = 0;
  let failed = 0;

  const results = await mapPool(
    markets,
    CONFIG.CONCURRENCY,
    async market => {
      const result = await scanOneMarket(market, nowSeconds);

      completed++;
      success++;

      if (completed % 25 === 0 || completed === markets.length) {
        console.log(`[PROGRESS] ${completed}/${markets.length}`);
      }

      return result;
    }
  );

  const candidates = [];

  for (const item of results) {
    if (item?.__error) {
      failed++;
      continue;
    }

    if (item) candidates.push(item);
  }

  const rankedAll = rankCandidates(candidates);

  const ranked = rankedAll
    .slice(0, CONFIG.TOP_COUNT)
    .map((item, index) => {
      const clean = { ...item, rank: index + 1 };
      delete clean._sort;
      return clean;
    });

  const output = {
    success: true,
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategy: 'HOURLY BUY/SELL PRESSURE + LIVE BUY ACCELERATION',
    scannedAt: new Date().toISOString(),

    stats: {
      active: active.length,
      liquid: markets.length,
      success,
      failed,
      candidates: candidates.length,
      durationMs: Date.now() - started,
    },

    candidates: ranked,
    rankedCandidates: ranked,
  };

  try {
    const stored = await saveMarketSnapshot(
      rankedAll.map(item => {
        const copy = { ...item };
        delete copy._sort;
        return copy;
      })
    );

    output.historyCount = stored?.historyCount ?? 0;
    output.summaryCount = stored?.summaryCount ?? rankedAll.length;
    output.rankChanges = stored?.rankChanges ?? {};
  } catch (error) {
    console.error(
      '[STORAGE] Snapshot save failed; scan result is still available:',
      error?.stack || error?.message || error
    );
  }

  const report = buildReport(output);

  console.log(report);
  console.log(
    `\nFinished in ${(output.stats.durationMs / 1000).toFixed(1)}s | scanned ${markets.length} | success ${success} | failed ${failed}`
  );

  // Telegram is an external notification. Its failure must not invalidate
  // a successful market scan or cause GitHub Actions "Run scanner once" to fail.
  try {
    const telegramResult = await sendTelegram(report);
    console.log('[TELEGRAM RESULT]', JSON.stringify(telegramResult));
    output.telegram = telegramResult;
  } catch (error) {
    console.error(
      '[TELEGRAM DELIVERY ERROR] Scan completed, but notification failed:',
      error?.stack || error?.message || error
    );

    output.telegram = {
      sent: false,
      reason: error?.message || String(error),
    };
  }

  return output;
}

// src/index.js imports this module to start the scanner.
try {
  const result = await scanGateMarkets();

  console.log(
    '[SCANNER RESULT]',
    JSON.stringify(
      {
        success: result.success,
        active: result.stats.active,
        liquid: result.stats.liquid,
        successful: result.stats.success,
        failed: result.stats.failed,
        candidates: result.stats.candidates,
        durationMs: result.stats.durationMs,
        telegramSent: result.telegram?.sent ?? false,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error('[SCANNER FATAL ERROR]', error?.stack || error);
  process.exitCode = 1;
}
