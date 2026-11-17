/**
 * GATE.IO USDT PERPETUAL — EARLY MOVE RADAR
 * ------------------------------------------------------------
 * Single-file scanner for GitHub Actions (Node.js 20+).
 *
 * Core design:
 *  - Scans every active direct USDT perpetual contract.
 *  - Uses 15 days of 1H candles for the broad market scan.
 *  - Deep-checks a shortlist with 15m/4H candles, public trades,
 *    order book and contract statistics (OI / trader ratios).
 *  - Scores EARLY readiness, momentum start and entry quality
 *    separately, then ranks opportunities.
 *  - Tracks score/rank changes using compressed GitHub Contents
 *    API memory when GITHUB_TOKEN and GITHUB_REPOSITORY exist.
 *  - Sends one compact Telegram report.
 *
 * IMPORTANT:
 *  - This is an analysis/alert scanner. It does NOT place orders.
 *  - "Smart money" is an inference from public market data, never
 *    proof of a whale or institutional purchase.
 *  - Gate public trade size sign is interpreted as buy(+)/sell(-).
 *    If the exchange changes this convention, validate before use.
 *
 * Required GitHub Actions secrets:
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *
 * For persistent cross-run memory, workflow must expose:
 *   permissions:
 *     contents: write
 *   env:
 *     GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
 *
 * Optional environment variables:
 *   TOP_LIMIT=10
 *   DEEP_CANDIDATES=55
 *   CONCURRENCY=3
 *   MIN_REQUEST_INTERVAL_MS=280
 *   MEMORY_FILE=market-memory.json.gz
 *   TELEGRAM_DISABLE=false
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// ========================= CONFIG =========================

const CONFIG = {
  BASE_URL: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',

  HISTORY_DAYS: 15,
  MAIN_INTERVAL: '1h',
  MAIN_CANDLES: 360,

  FAST_INTERVAL: '15m',
  FAST_CANDLES: 100,

  TREND_INTERVAL: '4h',
  TREND_CANDLES: 90,

  STATS_INTERVAL: '15m',
  STATS_LIMIT: 25,
  TRADES_LIMIT: 1000,
  ORDERBOOK_LIMIT: 20,

  TOP_LIMIT: Number(process.env.TOP_LIMIT || 10),
  DEEP_CANDIDATES: Number(process.env.DEEP_CANDIDATES || 55),

  CONCURRENCY: Number(process.env.CONCURRENCY || 3),
  MIN_REQUEST_INTERVAL_MS: Number(process.env.MIN_REQUEST_INTERVAL_MS || 280),
  REQUEST_TIMEOUT_MS: 15000,
  MAX_RETRIES: 3,

  MEMORY_FILE: process.env.MEMORY_FILE || 'market-memory.json.gz',
  MEMORY_DAYS: 7,
  MEMORY_MAX_SAMPLES: 672,

  TELEGRAM_MAX_LENGTH: 3900,
  TELEGRAM_DISABLE: String(process.env.TELEGRAM_DISABLE || 'false').toLowerCase() === 'true',

  MIN_DAILY_QUOTE_VOLUME: 50000,

  DEEP_ALWAYS_INCLUDE_TOP: 25,
  DEEP_MAX_PER_RUN: Number(process.env.DEEP_CANDIDATES || 55),

  EXTENDED_24H_PCT: 18,
  EXTENDED_1H_PCT: 7,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (v, min = 0, max = 100) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
const num = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const avg = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const sum = values => values.reduce((a, b) => a + b, 0);
const pctChange = (a, b) => (a > 0 ? ((b - a) / a) * 100 : 0);
const safeDiv = (a, b) => (Math.abs(b) > 1e-12 ? a / b : 0);
const round = (v, digits = 1) => Number((Number.isFinite(v) ? v : 0).toFixed(digits));
const median = values => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const scoreBar = score => {
  const filled = Math.round(clamp(score) / 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
};
const signed = (v, digits = 1) => `${v > 0 ? '+' : ''}${round(v, digits)}`;
const fmt = v => {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return `${round(v / 1e9, 2)}B`;
  if (Math.abs(v) >= 1e6) return `${round(v / 1e6, 2)}M`;
  if (Math.abs(v) >= 1e3) return `${round(v / 1e3, 1)}K`;
  return round(v, 2).toString();
};
const isoNow = () => new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

// ========================= REQUEST CONTROL =========================

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

async function paceRequest() {
  const run = async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < CONFIG.MIN_REQUEST_INTERVAL_MS) {
      await sleep(CONFIG.MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();
  };
  requestQueue = requestQueue.then(run, run);
  return requestQueue;
}

async function apiGet(endpoint, params = {}) {
  const url = new URL(`${CONFIG.BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    await paceRequest();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'Gate-Early-Move-Radar/1.0' },
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`Gate API ${response.status}: ${text.slice(0, 240)}`);
        if (response.status === 429 || response.status >= 500) {
          lastError = error;
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw error;
      }

      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(500 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Request failed: ${endpoint}`);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { __error: error.message || String(error) };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

// ========================= GATE DATA NORMALIZATION =========================

function normalizeCandle(raw) {
  if (Array.isArray(raw)) {
    const [t, v, c, h, l, o, quote] = raw;
    return {
      time: num(t), volume: num(v), close: num(c),
      high: num(h), low: num(l), open: num(o),
      quoteVolume: num(quote) || num(v) * num(c),
    };
  }

  const volume = num(raw.v);
  const close = num(raw.c);
  return {
    time: num(raw.t),
    volume,
    close,
    high: num(raw.h),
    low: num(raw.l),
    open: num(raw.o),
    quoteVolume: num(raw.sum) || volume * close,
  };
}

async function getCandles(contract, interval, limit) {
  const data = await apiGet(`/futures/${CONFIG.SETTLE}/candlesticks`, {
    contract,
    interval,
    limit,
  });

  if (!Array.isArray(data)) return [];

  const seconds = interval === '15m' ? 900
    : interval === '1h' ? 3600
    : interval === '4h' ? 14400 : 3600;

  const now = Math.floor(Date.now() / 1000);
  return data
    .map(normalizeCandle)
    .filter(c => c.time > 0 && c.close > 0 && c.high > 0 && c.low > 0)
    .filter(c => c.time + seconds <= now)
    .sort((a, b) => a.time - b.time);
}

function normalizeStats(row) {
  return {
    time: num(row.time),
    openInterest: num(row.open_interest),
    openInterestUsd: num(row.open_interest_usd),
    takerLongShort: num(row.lsr_taker),
    accountLongShort: num(row.lsr_account),
    topAccountLongShort: num(row.top_lsr_account),
    topPositionLongShort: num(row.top_lsr_size),
    longLiquidationUsd: num(row.long_liq_usd_new ?? row.long_liq_usd),
    shortLiquidationUsd: num(row.short_liq_usd_new ?? row.short_liq_usd),
    longTakerSize: num(row.long_taker_size),
    shortTakerSize: num(row.short_taker_size),
  };
}

function normalizeTrade(row) {
  const size = num(row.size);
  const price = num(row.price);
  return {
    id: String(row.id || ''),
    time: num(row.create_time_ms || row.create_time),
    size,
    price,
    notional: Math.abs(size * price),
    side: size > 0 ? 'buy' : size < 0 ? 'sell' : 'unknown',
  };
}

async function getDeepData(contract) {
  const settled = await Promise.allSettled([
    getCandles(contract, CONFIG.FAST_INTERVAL, CONFIG.FAST_CANDLES),
    getCandles(contract, CONFIG.TREND_INTERVAL, CONFIG.TREND_CANDLES),
    apiGet(`/futures/${CONFIG.SETTLE}/contract_stats`, {
      contract,
      interval: CONFIG.STATS_INTERVAL,
      limit: CONFIG.STATS_LIMIT,
    }),
    apiGet(`/futures/${CONFIG.SETTLE}/trades`, {
      contract,
      limit: CONFIG.TRADES_LIMIT,
    }),
    apiGet(`/futures/${CONFIG.SETTLE}/order_book`, {
      contract,
      limit: CONFIG.ORDERBOOK_LIMIT,
      with_id: true,
    }),
  ]);

  const value = i => settled[i].status === 'fulfilled' ? settled[i].value : null;

  return {
    fastCandles: Array.isArray(value(0)) ? value(0) : [],
    trendCandles: Array.isArray(value(1)) ? value(1) : [],
    stats: Array.isArray(value(2)) ? value(2).map(normalizeStats).sort((a, b) => a.time - b.time) : [],
    trades: Array.isArray(value(3)) ? value(3).map(normalizeTrade) : [],
    orderBook: value(4) && typeof value(4) === 'object' ? value(4) : null,
    errors: settled.map((r, i) => r.status === 'rejected' ? ['15m', '4h', 'stats', 'trades', 'orderbook'][i] : null).filter(Boolean),
  };
}

// ========================= TECHNICAL FEATURES =========================

function candleMetrics(candles) {
  if (!candles || candles.length < 30) return null;

  const c = candles;
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  const prior24 = c.slice(-25, -1);
  const recent6 = c.slice(-6);
  const recent3 = c.slice(-3);

  const quoteVolumes = c.map(x => x.quoteVolume || x.volume * x.close);
  const recentVol = avg(quoteVolumes.slice(-3));
  const baselineVol = avg(quoteVolumes.slice(-27, -3));
  const volRatio = safeDiv(recentVol, baselineVol);

  const ranges = c.map(x => safeDiv(x.high - x.low, x.close) * 100);
  const recentRange = avg(ranges.slice(-6));
  const baselineRange = avg(ranges.slice(-30, -6));
  const compression = safeDiv(baselineRange, recentRange);

  const priorHigh = Math.max(...prior24.map(x => x.high));
  const priorLow = Math.min(...prior24.map(x => x.low));
  const currentPrice = last.close;
  const resistanceDistance = safeDiv(priorHigh - currentPrice, currentPrice) * 100;
  const supportDistance = safeDiv(currentPrice - priorLow, currentPrice) * 100;

  const recentLows = recent6.map(x => x.low);
  const higherLow = recentLows[recentLows.length - 1] > recentLows[0];

  const body = safeDiv(last.close - last.open, last.open) * 100;
  const closeLocation = safeDiv(last.close - last.low, last.high - last.low);
  const last3Return = pctChange(recent3[0].open, recent3[recent3.length - 1].close);
  const last6Return = pctChange(recent6[0].open, recent6[recent6.length - 1].close);
  const last24Return = pctChange(c[c.length - 25].close, last.close);
  const prev24Return = pctChange(c[c.length - 49]?.close || c[c.length - 25].close, c[c.length - 25].close);

  const redHighVolume = recent6.filter(x => x.close < x.open && (x.quoteVolume || x.volume * x.close) > baselineVol * 1.2);
  const redMove = redHighVolume.length
    ? avg(redHighVolume.map(x => Math.abs(pctChange(x.open, x.close))))
    : 0;
  const absorption = redHighVolume.length > 0 && redMove < Math.max(0.45, recentRange * 0.75);

  const recentHigherLows = recentLows.slice(1).filter((v, i) => v >= recentLows[i]).length;

  return {
    last,
    previous: prev,
    price: currentPrice,
    volRatio,
    recentVol,
    baselineVol,
    compression,
    recentRange,
    baselineRange,
    priorHigh,
    priorLow,
    resistanceDistance,
    supportDistance,
    higherLow,
    higherLowCount: recentHigherLows,
    body,
    closeLocation,
    last3Return,
    last6Return,
    last24Return,
    prev24Return,
    absorption,
    redHighVolumeCount: redHighVolume.length,
    redMove,
    breakout: currentPrice > priorHigh,
    nearBreakout: resistanceDistance >= 0 && resistanceDistance <= 1.2,
    candleCount: c.length,
  };
}

function scoreVolume(m) {
  if (!m) return 0;
  const ratioScore = clamp((Math.log2(Math.max(0.25, m.volRatio)) + 1.5) * 30);
  const compressionScore = clamp((m.compression - 0.8) * 45);
  return clamp(ratioScore * 0.75 + compressionScore * 0.25);
}

function analyzeTrades(trades) {
  if (!trades || trades.length < 10) {
    return { available: false, buyRatio: 50, imbalance: 0, largeBuyShare: 0, tradeCount: trades?.length || 0 };
  }

  const buy = sum(trades.filter(t => t.side === 'buy').map(t => t.notional));
  const sell = sum(trades.filter(t => t.side === 'sell').map(t => t.notional));
  const total = buy + sell;
  const buyRatio = total > 0 ? (buy / total) * 100 : 50;

  const notionals = trades.map(t => t.notional).filter(v => v > 0);
  const largeThreshold = Math.max(median(notionals) * 4, 0);
  const large = trades.filter(t => t.notional >= largeThreshold);
  const largeBuy = sum(large.filter(t => t.side === 'buy').map(t => t.notional));
  const largeTotal = sum(large.map(t => t.notional));

  return {
    available: true,
    buy,
    sell,
    buyRatio,
    imbalance: total > 0 ? ((buy - sell) / total) * 100 : 0,
    largeBuyShare: largeTotal > 0 ? (largeBuy / largeTotal) * 100 : 0,
    tradeCount: trades.length,
    totalNotional: total,
  };
}

function analyzeOrderBook(book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) ||
      !book.bids.length || !book.asks.length) {
    return { available: false, bidAskRatio: 1, spreadPct: 99 };
  }

  const bids = book.bids.slice(0, 10);
  const asks = book.asks.slice(0, 10);
  const bidNotional = sum(bids.map(x => num(x.p) * Math.abs(num(x.s))));
  const askNotional = sum(asks.map(x => num(x.p) * Math.abs(num(x.s))));
  const bestBid = num(book.bids[0].p);
  const bestAsk = num(book.asks[0].p);
  const mid = (bestBid + bestAsk) / 2;

  return {
    available: true,
    bidNotional,
    askNotional,
    bidAskRatio: safeDiv(bidNotional, askNotional),
    spreadPct: mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 99,
  };
}

function analyzeOI(stats) {
  if (!stats || stats.length < 2) {
    return { available: false, changePct: 0, latest: null, first: null };
  }
  const first = stats[0];
  const latest = stats[stats.length - 1];
  const firstOI = first.openInterestUsd || first.openInterest;
  const latestOI = latest.openInterestUsd || latest.openInterest;
  return {
    available: firstOI > 0 && latestOI > 0,
    changePct: pctChange(firstOI, latestOI),
    latest,
    first,
    count: stats.length,
  };
}

// ========================= SCORING ENGINE =========================

function scoreReadiness(m, trade, oi, book, ticker) {
  if (!m) return { score: 0, parts: {} };

  const volume = scoreVolume(m);
  const absorption = m.absorption ? 90 : clamp(35 + m.redHighVolumeCount * 8 - m.redMove * 8);
  const buyPressure = trade.available ? clamp(50 + trade.imbalance * 1.5) : 45;
  const latestStats = oi.latest;
  const topTraderRatio = latestStats?.topPositionLongShort || latestStats?.topAccountLongShort || 1;
  const topTraderSignal = topTraderRatio > 1.05 ? 8 : topTraderRatio < 0.95 ? -8 : 0;
  const shortSqueezeSupport = latestStats && latestStats.shortLiquidationUsd > latestStats.longLiquidationUsd * 1.5 ? 6 : 0;
  const oiScore = oi.available
    ? clamp(50 + oi.changePct * 5 + (m.last24Return > 0 ? 8 : -5) + topTraderSignal + shortSqueezeSupport)
    : 45;
  const structure = clamp(35 + m.higherLowCount * 12 + (m.higherLow ? 12 : 0));
  const persistence = clamp(25 + Math.max(0, m.volRatio - 1) * 35 + (m.last6Return > 0 ? 15 : 0));
  const bookScore = book.available ? clamp(45 + (book.bidAskRatio - 1) * 25) : 45;

  const parts = {
    accumulation: clamp(volume * 0.65 + (m.compression > 1 ? 35 : 15) * 0.35),
    absorption,
    buyPressure,
    openInterest: oiScore,
    structure,
    persistence,
    orderBook: bookScore,
  };

  let score =
    parts.accumulation * 0.22 +
    parts.absorption * 0.18 +
    parts.buyPressure * 0.18 +
    parts.openInterest * 0.14 +
    parts.structure * 0.12 +
    parts.persistence * 0.10 +
    parts.orderBook * 0.06;

  if (m.last24Return > 15) score -= 12;
  if (m.last24Return < -8) score -= 10;
  if (ticker && num(ticker.funding_rate) > 0.001) score -= 5;

  return { score: clamp(score), parts };
}

function scoreMomentum(m, trade, oi, fast, trend) {
  if (!m) return { score: 0, parts: {} };

  const fastM = fast ? candleMetrics(fast) : null;
  const trendM = trend ? candleMetrics(trend) : null;

  const breakout = m.breakout ? 100 : m.nearBreakout ? 72 : clamp(45 - Math.max(0, m.resistanceDistance) * 18);
  const volume = clamp((Math.log2(Math.max(0.25, m.volRatio)) + 1.5) * 32);
  const acceleration = clamp(50 + (m.last3Return - m.last6Return / 2) * 8);
  const oiScore = oi.available ? clamp(50 + oi.changePct * 5) : 45;
  const buyScore = trade.available ? clamp(50 + trade.imbalance * 1.5) : 45;
  const fastScore = fastM ? clamp(50 + fastM.last3Return * 8 + (fastM.breakout ? 18 : 0)) : 45;
  const trendScore = trendM ? clamp(50 + trendM.last24Return * 3) : 45;

  const parts = { breakout, volume, acceleration, openInterest: oiScore, buyPressure: buyScore, fastTimeframe: fastScore, higherTimeframe: trendScore };
  const score =
    breakout * 0.22 +
    volume * 0.18 +
    acceleration * 0.16 +
    oiScore * 0.14 +
    buyScore * 0.12 +
    fastScore * 0.12 +
    trendScore * 0.06;

  return { score: clamp(score), parts };
}

function scoreEntry(m, trade, oi, book, ticker, fast, trend) {
  if (!m) return { score: 0, parts: {}, extended: true };

  const fastM = fast ? candleMetrics(fast) : null;
  const trendM = trend ? candleMetrics(trend) : null;

  const resistanceRoom = m.breakout
    ? 78
    : clamp(50 + m.resistanceDistance * 20);
  const extensionPenalty = Math.max(
    0,
    m.last24Return - CONFIG.EXTENDED_24H_PCT,
    m.last3Return - CONFIG.EXTENDED_1H_PCT
  );
  const priceLocation = clamp(100 - extensionPenalty * 5 - Math.max(0, m.last24Return) * 0.7);
  const riskRewardProxy = clamp(70 + m.resistanceDistance * 12 - Math.max(0, m.supportDistance - 2) * 3);
  const liquidity = ticker
    ? clamp(30 + Math.log10(Math.max(1, num(ticker.volume_24h_quote))) * 9)
    : 35;
  const spread = book.available ? clamp(100 - book.spreadPct * 100) : 45;
  const alignment = clamp(45 +
    (fastM && fastM.last24Return > 0 ? 20 : 0) +
    (trendM && trendM.last24Return > 0 ? 20 : 0) +
    (m.last6Return > 0 ? 15 : 0));
  const demand = trade.available ? clamp(50 + trade.imbalance * 1.1) : 45;
  const oiConfirmation = oi.available ? clamp(50 + oi.changePct * 4) : 45;

  const parts = {
    resistanceRoom,
    priceLocation,
    riskReward: riskRewardProxy,
    liquidity,
    spread,
    alignment,
    demand,
    oiConfirmation,
  };

  const score =
    resistanceRoom * 0.17 +
    priceLocation * 0.18 +
    riskRewardProxy * 0.20 +
    liquidity * 0.13 +
    spread * 0.10 +
    alignment * 0.12 +
    demand * 0.05 +
    oiConfirmation * 0.05;

  const extended = m.last24Return > CONFIG.EXTENDED_24H_PCT ||
    m.last3Return > CONFIG.EXTENDED_1H_PCT * 1.7;

  return { score: clamp(score), parts, extended };
}

function classifyOpportunity(readiness, momentum, entry, m, ticker, book) {
  const dailyQuote = ticker ? num(ticker.volume_24h_quote) : 0;
  const illiquid = dailyQuote > 0 && dailyQuote < CONFIG.MIN_DAILY_QUOTE_VOLUME;
  const extended = m && (m.last24Return > CONFIG.EXTENDED_24H_PCT || m.last3Return > 10);
  const badSpread = book?.available && book.spreadPct > 0.8;

  if (extended || (illiquid && entry < 45) || (badSpread && entry < 55)) return 'AVOID';
  if (readiness >= 64 && momentum < 70 && entry >= 52) return 'EARLY';
  if (momentum >= 67 && entry >= 58 && !extended) return 'MOMENTUM';
  return 'WATCH';
}

function makeOpportunity(contract, ticker, mainCandles, deep, previousMemory) {
  const m = candleMetrics(mainCandles);
  if (!m) return null;

  const trade = analyzeTrades(deep?.trades || []);
  const book = analyzeOrderBook(deep?.orderBook);
  const oi = analyzeOI(deep?.stats || []);

  const readiness = scoreReadiness(m, trade, oi, book, ticker);
  const momentum = scoreMomentum(m, trade, oi, deep?.fastCandles, deep?.trendCandles);
  const entry = scoreEntry(m, trade, oi, book, ticker, deep?.fastCandles, deep?.trendCandles);

  let opportunity = readiness.score * 0.40 + momentum.score * 0.30 + entry.score * 0.30;

  if (entry.extended) opportunity -= 13;
  if (ticker && num(ticker.volume_24h_quote) < CONFIG.MIN_DAILY_QUOTE_VOLUME) opportunity -= 12;
  if (book.available && book.spreadPct > 1) opportunity -= 8;
  if (trade.available && trade.imbalance < -20) opportunity -= 8;
  opportunity = clamp(opportunity);

  const phase = classifyOpportunity(readiness.score, momentum.score, entry.score, m, ticker, book);
  const price = m.price;
  const oiChange = oi.available ? oi.changePct : null;
  const prev = previousMemory || null;

  return {
    contract,
    score: round(opportunity, 1),
    readiness: round(readiness.score, 1),
    momentum: round(momentum.score, 1),
    entry: round(entry.score, 1),
    phase,
    price,
    change24h: ticker ? num(ticker.change_percentage) : m.last24Return,
    volume24h: ticker ? num(ticker.volume_24h_quote) : 0,
    volumeRatio: round(m.volRatio, 2),
    resistanceDistance: round(m.resistanceDistance, 2),
    buyRatio: trade.available ? round(trade.buyRatio, 1) : null,
    tradeImbalance: trade.available ? round(trade.imbalance, 1) : null,
    oiChange: oiChange === null ? null : round(oiChange, 2),
    topTraderRatio: oi.latest
      ? round(oi.latest.topPositionLongShort || oi.latest.topAccountLongShort || 0, 2)
      : null,
    shortLiquidationUsd: oi.latest ? round(oi.latest.shortLiquidationUsd, 0) : null,
    fundingRate: ticker ? num(ticker.funding_rate) : 0,
    spreadPct: book.available ? round(book.spreadPct, 3) : null,
    bidAskRatio: book.available ? round(book.bidAskRatio, 2) : null,
    absorption: m.absorption,
    breakout: m.breakout,
    higherLow: m.higherLow,
    last3Return: round(m.last3Return, 2),
    last6Return: round(m.last6Return, 2),
    last24Return: round(m.last24Return, 2),
    scoreParts: {
      readiness: readiness.parts,
      momentum: momentum.parts,
      entry: entry.parts,
    },
    dataQuality: {
      trades: trade.available,
      orderBook: book.available,
      oi: oi.available,
      fastCandles: (deep?.fastCandles?.length || 0) >= 30,
      trendCandles: (deep?.trendCandles?.length || 0) >= 30,
      deepErrors: deep?.errors || [],
    },
    previousScore: prev ? num(prev.score) : null,
    previousRank: prev ? num(prev.rank) : null,
    scoreDelta: prev ? round(opportunity - num(prev.score), 1) : null,
  };
}

// ========================= MEMORY =========================

function getGithubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return null;
  return { token, repository, branch: process.env.GITHUB_REF_NAME || 'main' };
}

async function readMemory() {
  const gh = getGithubConfig();

  if (gh) {
    try {
      const apiUrl = `https://api.github.com/repos/${gh.repository}/contents/${CONFIG.MEMORY_FILE}`;
      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${gh.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (response.ok) {
        const file = await response.json();
        const compressed = Buffer.from(String(file.content || '').replace(/\n/g, ''), 'base64');
        const json = await gunzip(compressed);
        return { data: JSON.parse(json.toString('utf8')), sha: file.sha, mode: 'github' };
      }
      if (response.status !== 404) {
        console.warn(`Memory read via GitHub failed: HTTP ${response.status}`);
      }
      return { data: { markets: {}, updatedAt: null }, sha: null, mode: 'github' };
    } catch (error) {
      console.warn(`Memory read error: ${error.message}`);
    }
  }

  try {
    const raw = await fs.readFile(path.resolve(CONFIG.MEMORY_FILE));
    const json = await gunzip(raw);
    return { data: JSON.parse(json.toString('utf8')), sha: null, mode: 'local' };
  } catch {
    return { data: { markets: {}, updatedAt: null }, sha: null, mode: 'local' };
  }
}

function updateMemory(memory, opportunities, rankMap) {
  const now = Date.now();
  const cutoff = now - CONFIG.MEMORY_DAYS * 24 * 60 * 60 * 1000;
  const markets = memory.data.markets || {};

  for (const item of opportunities) {
    const key = item.contract;
    const record = markets[key] || { history: [] };
    const history = Array.isArray(record.history) ? record.history : [];

    history.push({
      ts: now,
      score: item.score,
      readiness: item.readiness,
      momentum: item.momentum,
      entry: item.entry,
      rank: rankMap.get(key) || null,
      phase: item.phase,
      price: item.price,
      oi: item.oiChange,
      vol: item.volumeRatio,
    });

    record.history = history
      .filter(x => num(x.ts) >= cutoff)
      .slice(-CONFIG.MEMORY_MAX_SAMPLES);

    const previous = history.length >= 2 ? history[history.length - 2] : null;
    record.last = record.history[record.history.length - 1];
    record.previous = previous;
    markets[key] = record;
  }

  memory.data = { updatedAt: new Date(now).toISOString(), markets };
  return memory.data;
}

async function writeMemory(memory) {
  const json = Buffer.from(JSON.stringify(memory.data));
  const compressed = await gzip(json, { level: 9 });
  const gh = getGithubConfig();

  if (gh && memory.mode === 'github') {
    const apiUrl = `https://api.github.com/repos/${gh.repository}/contents/${CONFIG.MEMORY_FILE}`;
    const body = {
      message: `Update market radar memory ${new Date().toISOString()}`,
      content: compressed.toString('base64'),
      branch: gh.branch,
    };
    if (memory.sha) body.sha = memory.sha;

    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${gh.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub memory write failed ${response.status}: ${text.slice(0, 300)}`);
    }
    console.log('Persistent memory saved to GitHub repository.');
    return;
  }

  await fs.writeFile(path.resolve(CONFIG.MEMORY_FILE), compressed);
  console.log('Memory saved locally (not persistent between GitHub Actions runs unless cached).');
}

// ========================= TELEGRAM REPORT =========================

function phaseLabel(phase) {
  return ({
    EARLY: '🟢 EARLY',
    MOMENTUM: '🚀 MOMENTUM',
    WATCH: '🟡 WATCH',
    AVOID: '🔴 AVOID',
  })[phase] || phase;
}

function signalTags(item) {
  const tags = [];
  if (item.scoreDelta !== null && item.scoreDelta >= 8) tags.push('📈 RISING');
  if (item.previousRank === null && item.score >= 65) tags.push('🆕 NEW');
  if (item.breakout) tags.push('⚡ BREAKOUT');
  if (item.absorption) tags.push('🧲 ABSORB');
  if (item.oiChange !== null && item.oiChange >= 3) tags.push('OI+');
  if (item.scoreDelta !== null && item.scoreDelta <= -8) tags.push('⚠️ WEAK');
  return tags.slice(0, 3).join(' · ');
}

function renderMarket(item, rank) {
  const lines = [];
  const tags = signalTags(item);
  lines.push(`${String(rank).padStart(2, '0')}  ${item.contract}  ·  ${item.score.toFixed(1)}`);
  lines.push(`${scoreBar(item.score)}  ${phaseLabel(item.phase)}`);
  lines.push(`قیمت: ${item.price}  |  ۲۴ساعت: ${signed(item.change24h)}%  |  حجم: ${fmt(item.volume24h)} USDT`);
  lines.push(`آمادگی ${item.readiness}  ·  شروع ${item.momentum}  ·  ورود ${item.entry}`);
  lines.push(`حجم×${item.volumeRatio}  |  خرید ${item.buyRatio === null ? 'ناموجود' : `${item.buyRatio}%`}  |  OI ${item.oiChange === null ? 'ناموجود' : `${signed(item.oiChange)}%`}`);
  if (item.topTraderRatio !== null) {
    lines.push(`نسبت موقعیت معامله‌گران بزرگ: ${item.topTraderRatio}`);
  }
  if (item.resistanceDistance !== null) {
    lines.push(`فاصله مقاومت: ${signed(item.resistanceDistance)}%  |  اسپرد: ${item.spreadPct === null ? '—' : `${item.spreadPct}%`}`);
  }
  if (tags) lines.push(tags);
  return lines.join('\n');
}

function buildReport(summary, ranked, alerts, scanTime) {
  const lines = [
    '📡 GATE.IO  |  EARLY MOVE RADAR',
    `🕒 ${scanTime}  ·  تحلیل 1H / 15m / 4H`,
    '',
    `بازارها: ${summary.total}  |  تحلیل کامل: ${summary.deep}  |  خطا: ${summary.failed}`,
    `فرصت‌ها: EARLY ${summary.early}  ·  MOMENTUM ${summary.momentum}  ·  WATCH ${summary.watch}`,
    '',
    '🏆 TOP OPPORTUNITIES',
    '',
  ];

  const selected = ranked.slice(0, CONFIG.TOP_LIMIT);
  if (!selected.length) lines.push('فرصت قابل‌اتکایی پیدا نشد.');

  selected.forEach((item, index) => {
    lines.push(renderMarket(item, index + 1));
    if (index !== selected.length - 1) lines.push('────────────');
  });

  if (alerts.length) {
    lines.push('', '🔔 RADAR ALERTS');
    for (const alert of alerts.slice(0, 8)) lines.push(`• ${alert}`);
  }

  lines.push('', 'ℹ️ امتیازها تحلیلی‌اند؛ ورود پول هوشمند یا پامپ را تضمین نمی‌کنند.');
  return lines.join('\n');
}

function splitTelegramMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const blocks = text.split('\n');
  const chunks = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (candidate.length > maxLength && current) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegram(text) {
  if (CONFIG.TELEGRAM_DISABLE) {
    console.log('Telegram disabled. Report follows:\n' + text);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('Telegram credentials missing; report will be printed to logs.');
    console.log(text);
    return;
  }

  const chunks = splitTelegramMessage(text, CONFIG.TELEGRAM_MAX_LENGTH);
  for (let i = 0; i < chunks.length; i++) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
      }),
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(`Telegram send failed: ${JSON.stringify(result).slice(0, 300)}`);
    }
    if (i < chunks.length - 1) await sleep(350);
  }
}

// ========================= MAIN SCAN =========================

async function getMarketUniverse() {
  const [contracts, tickers] = await Promise.all([
    apiGet(`/futures/${CONFIG.SETTLE}/contracts`),
    apiGet(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);

  const tickerMap = new Map((Array.isArray(tickers) ? tickers : []).map(t => [t.contract, t]));
  const active = (Array.isArray(contracts) ? contracts : []).filter(c =>
    c.status === 'trading' &&
    c.type === 'direct' &&
    c.name &&
    c.name.endsWith('_USDT') &&
    !c.in_delisting
  );

  return { active, tickerMap };
}

function preliminaryScore(candles, ticker) {
  const m = candleMetrics(candles);
  if (!m) return 0;
  const vol = scoreVolume(m);
  const structure = clamp(35 + m.higherLowCount * 10 + (m.higherLow ? 10 : 0));
  const near = m.nearBreakout ? 80 : m.breakout ? 100 : clamp(50 - m.resistanceDistance * 10);
  const dailyVol = ticker ? num(ticker.volume_24h_quote) : 0;
  const liquidity = clamp(20 + Math.log10(Math.max(1, dailyVol)) * 8);
  return clamp(vol * 0.35 + structure * 0.25 + near * 0.20 + liquidity * 0.20);
}

function makeAlerts(ranked, oldMarkets) {
  const alerts = [];
  for (const item of ranked) {
    const old = oldMarkets[item.contract]?.last;
    if (!old) continue;

    const delta = item.score - num(old.score);
    const oldRank = num(old.rank);
    const rank = item.rank;

    if (delta >= 8 && item.score >= 60) {
      alerts.push(`${item.contract}: رشد امتیاز ${signed(delta)}؛ اکنون رتبه ${rank}`);
    }
    if (rank <= 10 && oldRank > 10 && oldRank > 0) {
      alerts.push(`${item.contract}: ورود تازه به TOP 10`);
    }
    if (item.phase === 'MOMENTUM' && old.phase !== 'MOMENTUM') {
      alerts.push(`${item.contract}: ورود به مرحله شروع حرکت`);
    }
    if (delta <= -10 && old.score >= 60) {
      alerts.push(`${item.contract}: افت امتیاز ${signed(delta)}؛ ضعف احتمالی`);
    }
  }
  return [...new Set(alerts)];
}

async function main() {
  const start = Date.now();
  console.log('Starting Gate.io Early Move Radar...');
  console.log(`Node ${process.version} | ${isoNow()}`);

  const memory = await readMemory();
  const oldMarkets = memory.data.markets || {};

  const { active, tickerMap } = await getMarketUniverse();
  console.log(`Active direct USDT perpetual markets: ${active.length}`);

  // Stage 1: fetch 15-day 1H history for every active contract.
  let successful = 0;
  let failed = 0;
  const stageOne = await mapLimit(active, CONFIG.CONCURRENCY, async contract => {
    const candles = await getCandles(contract.name, CONFIG.MAIN_INTERVAL, CONFIG.MAIN_CANDLES);
    if (candles.length < 48) return { contract: contract.name, candles, insufficient: true };
    successful++;
    return {
      contract: contract.name,
      candles,
      preliminary: preliminaryScore(candles, tickerMap.get(contract.name)),
    };
  });

  const valid = stageOne.filter(x => x && !x.__error && !x.insufficient && x.candles?.length >= 48);
  failed = stageOne.filter(x => x?.__error).length;
  const insufficient = stageOne.filter(x => x && !x.__error && x.insufficient).length;

  valid.sort((a, b) => b.preliminary - a.preliminary);

  // Stage 2: deep data for strongest candidates.
  const deepTargets = valid.slice(0, CONFIG.DEEP_MAX_PER_RUN);
  console.log(`Deep analysis candidates: ${deepTargets.length}`);

  const deepResults = await mapLimit(deepTargets, CONFIG.CONCURRENCY, async item => ({
    contract: item.contract,
    deep: await getDeepData(item.contract),
  }));
  const deepMap = new Map(
    deepResults.filter(x => x && !x.__error).map(x => [x.contract, x.deep])
  );

  const opportunities = [];
  for (const item of valid) {
    const ticker = tickerMap.get(item.contract);
    const deep = deepMap.get(item.contract) || {
      fastCandles: [],
      trendCandles: [],
      stats: [],
      trades: [],
      orderBook: null,
      errors: ['deep-analysis-not-selected'],
    };

    const result = makeOpportunity(item.contract, ticker, item.candles, deep, oldMarkets[item.contract]?.last);
    if (result) {
      result.deepChecked = deepMap.has(item.contract);
      opportunities.push(result);
    }
  }

  opportunities.sort((a, b) => b.score - a.score);
  opportunities.forEach((item, index) => { item.rank = index + 1; });

  const rankMap = new Map(opportunities.map(x => [x.contract, x.rank]));
  const alerts = makeAlerts(opportunities, oldMarkets);

  const summary = {
    total: active.length,
    deep: deepMap.size,
    successful,
    failed,
    insufficient,
    early: opportunities.filter(x => x.phase === 'EARLY').length,
    momentum: opportunities.filter(x => x.phase === 'MOMENTUM').length,
    watch: opportunities.filter(x => x.phase === 'WATCH').length,
  };

  updateMemory(memory, opportunities, rankMap);
  try {
    await writeMemory(memory);
  } catch (error) {
    console.error(`Memory persistence warning: ${error.message}`);
  }

  const report = buildReport(summary, opportunities, alerts, isoNow());
  await sendTelegram(report);

  const elapsed = round((Date.now() - start) / 1000, 1);
  console.log([
    'Scan completed.',
    `Markets=${summary.total}`,
    `Valid=${opportunities.length}`,
    `Deep=${summary.deep}`,
    `Failed=${summary.failed}`,
    `Insufficient=${summary.insufficient}`,
    `EARLY=${summary.early}`,
    `MOMENTUM=${summary.momentum}`,
    `Elapsed=${elapsed}s`,
  ].join(' | '));
}

main().catch(async error => {
  console.error('FATAL SCANNER ERROR:', error);
  try {
    await sendTelegram(`🚨 GATE.IO RADAR ERROR\n${String(error.message || error).slice(0, 1200)}`);
  } catch (telegramError) {
    console.error('Telegram error notification failed:', telegramError.message);
  }
  process.exitCode = 1;
});
