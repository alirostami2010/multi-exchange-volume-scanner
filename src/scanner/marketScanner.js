/**
 * GATE.IO USDT PERPETUAL — SUSTAINED BULLISH MOVE RADAR
 * Prioritizes sustained bullish trend quality, timely entries, and serious-decline exits.
 * 4H/1H = trend continuity | 15M = move start | 5M = entry/exit timing.
 * File: src/scanner/marketScanner.js | Node.js 20+
 */

import 'dotenv/config';
import { saveMarketSnapshot, getTradeStates } from '../storage/marketStorage.js';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAMES: {
    '5m': { seconds: 300, limit: 100 },
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 },
    '1d': { seconds: 86400, limit: 100 },
  },
  TOP_COUNT: 20,
  MIN_QUOTE_VOLUME_24H: 100000,
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,
  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,
  MIN_SCORE: 58,
  DERIVATIVE_TRADE_LIMIT: 100,
  DERIVATIVE_STATS_LIMIT: 12,
  MAX_RETURN_15M: 4,
  MAX_RETURN_1H: 6,
  MAX_RETURN_4H: 12,
  NEAR_ENTRY_ATR: 1.25,
  SETUP_MAX_AGE_HOURS: { SWING: 240, 'SHORT-TERM': 72, SCALP: 24 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const pctChange = (current, previous) => !previous || previous <= 0 ? 0 : ((current - previous) / previous) * 100;
const formatPrice = (value) => {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);
  return value.toPrecision(5);
};
const getCandleValue = (candle) => candle.turnover > 0 ? candle.turnover : candle.volume;

async function fetchJSON(url) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });
      if (!response.ok) {
        const body = await response.text();
        const error = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
        error.status = response.status;
        error.retryAfter = number(response.headers.get('Retry-After'), 0);
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.RETRIES) await sleep(error.status === 429 ? Math.max(error.retryAfter * 1000, 1800 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 500) : 700 * attempt);
    }
  }
  throw lastError;
}

async function getContracts() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contracts`);
}
async function getTickers() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/tickers`);
}

async function getRecentTrades(contract) {
  const params = new URLSearchParams({ contract, limit: String(CONFIG.DERIVATIVE_TRADE_LIMIT) });
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/trades?${params}`);
}

async function getContractStats(contract) {
  const params = new URLSearchParams({
    contract,
    interval: '5m',
    limit: String(CONFIG.DERIVATIVE_STATS_LIMIT),
  });
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contract_stats?${params}`);
}

function analyzeDerivatives(trades, stats, contractMultiplier = 1) {
  const nowSeconds = Date.now() / 1000;
  const multiplier = number(contractMultiplier) > 0 ? number(contractMultiplier) : 1;
  const validTrades = Array.isArray(trades)
    ? trades.filter((trade) => {
      if (!trade || trade.is_internal === true || number(trade.size) === 0 || number(trade.price) <= 0) return false;
      const rawTime = number(trade.create_time_ms, number(trade.create_time));
      const timestamp = rawTime > 1e12 ? rawTime / 1000 : rawTime;
      return !timestamp || nowSeconds - timestamp <= 15 * 60;
    })
    : [];
  let buyNotional = 0;
  let sellNotional = 0;
  for (const trade of validTrades) {
    const notional = Math.abs(number(trade.size)) * number(trade.price) * multiplier;
    if (number(trade.size) > 0) buyNotional += notional;
    else sellNotional += notional;
  }
  const totalNotional = buyNotional + sellNotional;
  const buyRatio = totalNotional > 0 ? buyNotional / totalNotional : 0.5;
  const imbalance = totalNotional > 0 ? (buyNotional - sellNotional) / totalNotional : 0;

  const points = Array.isArray(stats)
    ? stats.map((item) => ({
      time: number(item.time),
      oi: number(item.open_interest_usd) || number(item.open_interest),
      markPrice: number(item.mark_price),
      longLiq: number(item.long_liq_usd_new, number(item.long_liq_usd)),
      shortLiq: number(item.short_liq_usd_new, number(item.short_liq_usd)),
      takerLong: number(item.long_taker_size),
      takerShort: number(item.short_taker_size),
      lsrTaker: number(item.lsr_taker),
    })).filter((item) => item.time > 0 && item.oi > 0).sort((a, b) => a.time - b.time)
    : [];
  const first = points[0];
  const last = points.at(-1);
  const oiChangePct = first && last && first.oi > 0 ? pctChange(last.oi, first.oi) : null;
  const markChangePct = first && last && first.markPrice > 0 ? pctChange(last.markPrice, first.markPrice) : null;
  const shortLiqTotal = points.reduce((sum, item) => sum + item.shortLiq, 0);
  const longLiqTotal = points.reduce((sum, item) => sum + item.longLiq, 0);
  const latestStats = points.at(-1);
  const statsTakerTotal = number(latestStats?.takerLong) + number(latestStats?.takerShort);
  const statsTakerImbalance = statsTakerTotal > 0
    ? (number(latestStats?.takerLong) - number(latestStats?.takerShort)) / statsTakerTotal : null;
  const combinedImbalance = statsTakerImbalance == null ? imbalance
    : clamp(imbalance * 0.70 + statsTakerImbalance * 0.30, -1, 1);

  // Missing derivatives data is neutral, never a bullish assumption.
  let flowScore = clamp(50 + combinedImbalance * 65, 0, 100);
  let oiScore = 50;
  if (oiChangePct !== null && markChangePct !== null) {
    if (oiChangePct > 0.15 && markChangePct > 0) oiScore = clamp(58 + oiChangePct * 5 + markChangePct * 2, 0, 100);
    else if (oiChangePct < -0.15 && markChangePct > 0) oiScore = clamp(43 + oiChangePct * 3, 0, 60);
    else if (oiChangePct > 0.15 && markChangePct <= 0) oiScore = clamp(48 + oiChangePct * 2, 0, 65);
    else oiScore = clamp(50 + oiChangePct * 2, 0, 100);
  }
  // Large short liquidations can inflate buy flow; reduce its directional value.
  const liquidationDistortion = shortLiqTotal > 0 && totalNotional > 0
    ? clamp(shortLiqTotal / totalNotional, 0, 1) : 0;
  flowScore = clamp(flowScore - liquidationDistortion * 18, 0, 100);

  return {
    tradeCount: validTrades.length,
    buyNotional,
    sellNotional,
    totalNotional,
    buyRatio,
    imbalance: combinedImbalance,
    rawTradeImbalance: imbalance,
    statsTakerImbalance,
    flowScore: Math.round(flowScore),
    openInterest: last?.oi ?? null,
    oiChangePct,
    markChangePct,
    oiScore: Math.round(oiScore),
    shortLiquidations: shortLiqTotal,
    longLiquidations: longLiqTotal,
    statsPoints: points.length,
    dataQuality: validTrades.length >= 10 && points.length >= 2 ? 'GOOD' : validTrades.length >= 5 || points.length >= 2 ? 'PARTIAL' : 'LOW',
  };
}

async function getCandles(contract, interval, limit, includeCurrent = false) {
  const params = new URLSearchParams({ contract, interval, limit: String(limit) });
  const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
  if (!Array.isArray(raw)) throw new Error(`Invalid candle response: ${contract} ${interval}`);

  const candles = raw.map((c) => ({
    time: number(c.t), open: number(c.o), high: number(c.h), low: number(c.l),
    close: number(c.c), volume: number(c.v), turnover: number(c.sum),
  })).filter((c) => c.time > 0 && c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .sort((a, b) => a.time - b.time);

  const intervalSeconds = CONFIG.TIMEFRAMES[interval].seconds;
  const currentBucket = Math.floor(Date.now() / 1000 / intervalSeconds) * intervalSeconds;
  const closed = candles.filter((c) => c.time < currentBucket);
  if (!includeCurrent) return closed;

  const current = candles.find((c) => c.time === currentBucket) || null;
  return {
    closed,
    current: current ? {
      bucketTime: currentBucket, open: current.open, high: current.high, low: current.low,
      close: current.close, volume: current.volume, turnover: current.turnover,
    } : null,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: error.message, item: items[index] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

function calculateEMA(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result = [];
  let ema = average(values.slice(0, period));
  result.push(ema);
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result.push(ema);
  }
  return result;
}

function getVolumeRatio(candles) {
  if (candles.length < 25) return 0;
  const recentAverage = average(candles.slice(-3).map(getCandleValue));
  const baselineMedian = median(candles.slice(-23, -3).map(getCandleValue));
  return baselineMedian > 0 ? recentAverage / baselineMedian : 0;
}

function getCandleStrength(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return { closeLocation: 0, bodyRatio: 0, bullish: false };
  return {
    closeLocation: clamp((candle.close - candle.low) / range, 0, 1),
    bodyRatio: clamp(Math.abs(candle.close - candle.open) / range, 0, 1),
    bullish: candle.close > candle.open,
  };
}

function findSwingPoints(candles, radius = 2) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= radius; j++) {
      if (current.high <= candles[i - j].high || current.high <= candles[i + j].high) isHigh = false;
      if (current.low >= candles[i - j].low || current.low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push(current.high);
    if (isLow) lows.push(current.low);
  }
  return { highs, lows };
}

function analyzeStructure(candles) {
  if (candles.length < 25) return {
    higherHigh: false, higherLow: false, breakout: false, bullishStructure: false, score: 0,
  };
  const swings = findSwingPoints(candles.slice(-35), 2);
  const higherHigh = swings.highs.length >= 2 && swings.highs.at(-1) > swings.highs.at(-2);
  const higherLow = swings.lows.length >= 2 && swings.lows.at(-1) > swings.lows.at(-2);
  const previous = candles.slice(-13, -1);
  const resistance = Math.max(...previous.map((c) => c.high));
  const last = candles[candles.length - 1];
  const breakout = resistance > 0 && last.close > resistance && last.close > last.open;
  const bullishStructure = (higherHigh && higherLow) || (breakout && higherLow);
  let score = 0;
  if (higherHigh) score += 30;
  if (higherLow) score += 30;
  if (breakout) score += 40;
  return { higherHigh, higherLow, breakout, bullishStructure, resistance, score };
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  if (ema9.length < 3 || ema21.length < 3) return null;
  const last = candles.at(-1);
  const previous = candles.at(-2);
  const currentEma9 = ema9.at(-1);
  const currentEma21 = ema21.at(-1);
  const previousEma21 = ema21.at(-2);
  return {
    price: last.close,
    ema9: currentEma9,
    ema21: currentEma21,
    emaBullish: last.close > currentEma9 && currentEma9 > currentEma21,
    emaSlope: currentEma21 > previousEma21,
    structure: analyzeStructure(candles),
    volumeRatio: getVolumeRatio(candles),
    strength: getCandleStrength(last),
    returns: {
      return1: pctChange(last.close, previous.close),
      return4: pctChange(last.close, candles[candles.length - 5].close),
      return16: pctChange(last.close, candles[candles.length - 17].close),
    },
  };
}

function analyzeDaily(candles, currentCandle, livePrice) {
  if (!candles || candles.length < 30) return null;
  const base = analyzeTimeframe(candles);
  if (!base) return null;
  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const last = candles.at(-1);
  const previous5 = candles.slice(-6, -1);
  const previous10 = candles.slice(-11, -1);
  const avg5Volume = average(previous5.map(getCandleValue));
  const avg10Volume = average(previous10.map(getCandleValue));
  const dailyVolume = getCandleValue(last);
  const volumeRatio5 = avg5Volume > 0 ? dailyVolume / avg5Volume : 0;
  const volumeRatio10 = avg10Volume > 0 ? dailyVolume / avg10Volume : 0;
  const previous20 = candles.slice(-21, -1);
  const previous50 = candles.slice(-51, -1);
  const resistance20 = previous20.length ? Math.max(...previous20.map((c) => c.high)) : 0;
  const resistance50 = previous50.length ? Math.max(...previous50.map((c) => c.high)) : 0;
  const price = number(livePrice, last.close);
  const currentOpen = number(currentCandle?.open, last.close);
  const currentHigh = number(currentCandle?.high, price);
  const currentLow = number(currentCandle?.low, price);
  const currentRange = currentHigh - currentLow;
  const currentCloseLocation = currentRange > 0 ? clamp((price - currentLow) / currentRange, 0, 1) : 0.5;
  const dailyReturn = pctChange(price, last.close);
  const dailyOpenReturn = currentCandle ? pctChange(price, currentOpen) : 0;
  const ema9Value = ema9.at(-1);
  const ema21Value = ema21.at(-1);
  const ema50Value = ema50.length ? ema50.at(-1) : 0;
  const emaBullish = price > ema9Value && ema9Value > ema21Value;
  const ema50Bullish = ema50Value > 0 && price > ema50Value;
  const emaSlope = ema21.at(-1) > ema21.at(-2);
  const breakout20 = resistance20 > 0 && price > resistance20;
  const breakout50 = resistance50 > 0 && price > resistance50;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const dayBucket = Math.floor(nowSeconds / 86400) * 86400;
  const elapsedSeconds = clamp(nowSeconds - number(currentCandle?.bucketTime, dayBucket), 300, 86400);
  const dayProgress = clamp(elapsedSeconds / 86400, 0.05, 1);
  const currentTurnover = number(currentCandle?.turnover);
  const projectedVolumeRatio = currentTurnover > 0 && avg10Volume > 0
    ? (currentTurnover / dayProgress) / avg10Volume : 0;

  let score = 50;
  if (emaBullish) score += 10;
  if (ema50Bullish) score += 6;
  if (emaSlope) score += 5;
  if (base.structure.higherHigh) score += 6;
  if (base.structure.higherLow) score += 7;
  if (breakout20) score += 12;
  if (breakout50) score += 8;
  if (volumeRatio5 >= 1.5) score += 8;
  else if (volumeRatio5 >= 1.15) score += 4;
  if (volumeRatio10 >= 1.5) score += 6;
  else if (volumeRatio10 >= 1.15) score += 3;
  if (projectedVolumeRatio >= 2) score += 8;
  else if (projectedVolumeRatio >= 1.3) score += 4;
  if (currentCandle && dailyOpenReturn > 0 && currentCloseLocation >= 0.7) score += 5;
  if (dailyReturn < -5) score -= 8;

  return {
    score: Math.round(clamp(score, 0, 100)), price, dailyReturn, dailyOpenReturn,
    emaBullish, ema50Bullish, emaSlope,
    higherHigh: base.structure.higherHigh, higherLow: base.structure.higherLow,
    breakout20, breakout50, volumeRatio5, volumeRatio10, projectedVolumeRatio,
    currentCandle: Boolean(currentCandle),
  };
}

function emptyDailyAnalysis(price = 0) {
  return {
    score: 50, price, dailyReturn: 0, dailyOpenReturn: 0,
    emaBullish: false, ema50Bullish: false, emaSlope: false,
    higherHigh: false, higherLow: false, breakout20: false, breakout50: false,
    volumeRatio5: 0, volumeRatio10: 0, projectedVolumeRatio: 0, currentCandle: false,
  };
}

function calculateCompression(candles) {
  if (!candles || candles.length < 40) return { score: 35, ratio: null };
  const recent = candles.slice(-12);
  const baseline = candles.slice(-36, -12);
  const recentRange = (Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low))) /
    Math.max(average(recent.map((c) => c.close)), 1e-12);
  const baselineRange = (Math.max(...baseline.map((c) => c.high)) - Math.min(...baseline.map((c) => c.low))) /
    Math.max(average(baseline.map((c) => c.close)), 1e-12);
  const ratio = baselineRange > 0 ? recentRange / baselineRange : 1;
  return { score: Math.round(clamp(100 - ratio * 55, 0, 100)), ratio };
}

function calculateRoomToResistance(candles, price, lookback = 30) {
  const previous = candles.slice(-(lookback + 1), -1);
  if (!previous.length || price <= 0) return { resistance: null, roomPct: null, score: 45 };
  const resistance = Math.max(...previous.map((c) => c.high));
  const roomPct = resistance > price ? pctChange(resistance, price) : 0;
  let score = 35;
  if (roomPct >= 8 && roomPct <= 25) score = 95;
  else if (roomPct > 25 && roomPct <= 45) score = 82;
  else if (roomPct >= 4 && roomPct < 8) score = 75;
  else if (roomPct > 45) score = 65;
  else if (roomPct <= 1) score = 20;
  return { resistance, roomPct, score };
}

function findRecentBreakoutAge(candles, maxAge = 24, lookback = 12) {
  if (!candles || candles.length < lookback + 2) return null;
  const lastIndex = candles.length - 1;
  const firstIndex = Math.max(lookback + 1, lastIndex - maxAge);
  for (let index = lastIndex; index >= firstIndex; index--) {
    const candle = candles[index];
    const resistance = Math.max(...candles.slice(index - lookback, index).map((item) => item.high));
    const previousResistance = Math.max(...candles.slice(index - lookback - 1, index - 1).map((item) => item.high));
    const previousClose = candles[index - 1]?.close ?? 0;
    const wasBelowResistance = previousClose <= previousResistance;
    if (candle.close > resistance && candle.close > candle.open && wasBelowResistance) {
      return lastIndex - index;
    }
  }
  return null;
}

function detectMoveStart(candles15m, candles1h, tf15, tf1h, tf4h, compression) {
  const age15m = findRecentBreakoutAge(candles15m, 24, 12);
  const age1h = findRecentBreakoutAge(candles1h, 12, 12);
  const reversal = Boolean(
    tf1h.structure.higherLow &&
    (tf1h.structure.higherHigh || tf1h.structure.breakout) &&
    (tf15.structure.higherLow || tf15.structure.breakout)
  );

  if (age15m !== null && compression.score >= 45) {
    const status = age15m <= 1 ? (tf1h.structure.breakout ? 'CONFIRMED' : 'EARLY')
      : age15m <= 4 ? 'EARLY' : 'LATE';
    return { type: 'COMPRESSION_BREAKOUT', label: 'خروج از فشردگی', status, ageBars: age15m, ageMinutes: age15m * 15 };
  }
  if (reversal) {
    const age = age1h ?? 6;
    const status = age <= 2 && tf1h.structure.breakout ? 'CONFIRMED' : age <= 4 ? 'EARLY' : 'LATE';
    return { type: 'BULLISH_REVERSAL', label: 'برگشت صعودی', status, ageBars: age, ageMinutes: age * 60 };
  }
  if (age15m !== null) {
    const status = age15m <= 2 ? 'WATCHING' : 'LATE';
    return { type: 'COMPRESSION_BREAKOUT', label: 'شکست محدوده', status, ageBars: age15m, ageMinutes: age15m * 15 };
  }
  if (compression.score >= 65 && (tf4h.emaBullish || tf4h.structure.higherLow)) {
    return { type: 'COMPRESSION_WATCH', label: 'آماده خروج از فشردگی', status: 'WATCHING', ageBars: null, ageMinutes: null };
  }
  return { type: 'NONE', label: 'هنوز شروعی شناسایی نشده', status: 'POTENTIAL', ageBars: null, ageMinutes: null };
}

function analyzeCoin(data) {
  const { symbol, candles, dailyCurrent, livePrice, derivatives } = data;
  const tf15 = analyzeTimeframe(candles['15m']);
  const tf1h = analyzeTimeframe(candles['1h']);
  const tf4h = analyzeTimeframe(candles['4h']);
  const daily = analyzeDaily(candles['1d'], dailyCurrent, livePrice) || emptyDailyAnalysis(livePrice);
  if (!tf15 || !tf1h || !tf4h) return null;

  const price = number(livePrice, tf15.price);
  const flow = derivatives || analyzeDerivatives([], []);
  const compression15 = calculateCompression(candles['15m']);
  const compression1h = calculateCompression(candles['1h']);
  const compression4h = calculateCompression(candles['4h']);
  const room4h = calculateRoomToResistance(candles['4h'], price, 30);
  const room1d = calculateRoomToResistance(candles['1d'], price, 30);

  // The objective is a fresh, sustained bullish leg, not a low-growth/low-price coin.
  const structure15 = tf15.structure;
  const structure1h = tf1h.structure;
  const structure4h = tf4h.structure;
  const dailyBias = daily.emaBullish || daily.ema50Bullish;
  const trend4h = (tf4h.emaBullish || tf4h.emaSlope) && (structure4h.higherLow || structure4h.higherHigh || structure4h.breakout);
  const trend1h = (tf1h.emaBullish || tf1h.emaSlope) && (structure1h.higherLow || structure1h.higherHigh || structure1h.breakout);
  const trend15m = (tf15.emaBullish || tf15.emaSlope) && (structure15.higherLow || structure15.higherHigh || structure15.breakout);

  const recent15 = candles['15m'].slice(-4);
  const bullish15Count = recent15.filter((c) => c.close > c.open && getCandleStrength(c).closeLocation >= 0.55).length;
  const recent1h = candles['1h'].slice(-3);
  const bullish1hCount = recent1h.filter((c) => c.close > c.open && getCandleStrength(c).closeLocation >= 0.5).length;
  const volume15 = tf15.volumeRatio;
  const volume1h = tf1h.volumeRatio;
  const flowPositive = flow.imbalance > 0.04 && flow.buyRatio > 0.51;
  const flowStrong = flow.imbalance > 0.13 && flow.buyRatio > 0.56;
  const oiHealthy = flow.oiChangePct == null || (flow.oiChangePct > 0 && (flow.markChangePct ?? 0) >= 0);
  const oiDanger = flow.oiChangePct != null && flow.oiChangePct > 0.5 && (flow.markChangePct ?? 0) < -0.35;
  const resistanceRoom = room4h.roomPct == null || room4h.roomPct >= 2.0;
  const noHeavyOverhead = room4h.roomPct == null || room4h.roomPct >= 1.0;
  const excessive15mRun = tf15.returns.return16 > 9;
  const excessive1hRun = tf1h.returns.return16 > 16;
  const overheated = excessive15mRun || excessive1hRun || (tf15.returns.return4 > 5.5 && tf15.strength.closeLocation < 0.45);
  const bearishFlow = flow.imbalance < -0.12 || (flow.buyRatio < 0.43 && flow.dataQuality === 'GOOD');
  const structuralDamage = (!tf4h.emaBullish && !tf4h.structure.higherLow) || (!tf1h.emaSlope && !tf1h.structure.higherLow && !tf1h.structure.breakout);

  const trendScore = clamp(
    12 + (dailyBias ? 7 : 0) + (trend4h ? 18 : 0) + (trend1h ? 20 : 0) + (trend15m ? 12 : 0) +
    (structure4h.higherLow ? 5 : 0) + (structure1h.higherLow ? 6 : 0) + (structure15.higherLow ? 5 : 0) +
    (tf4h.emaSlope ? 4 : 0) + (tf1h.emaSlope ? 4 : 0) + (tf15.emaSlope ? 3 : 0) +
    (flowPositive ? 5 : 0) + (oiHealthy ? 3 : 0) + (resistanceRoom ? 4 : 0) -
    (bearishFlow ? 12 : 0) - (oiDanger ? 8 : 0) - (structuralDamage ? 9 : 0) - (overheated ? 12 : 0),
    0, 100
  );

  const compressionReady = compression15.score >= 48 || compression1h.score >= 48 || compression4h.score >= 55;
  const breakoutFresh = findRecentBreakoutAge(candles['15m'], 8, 12);
  const breakout1hFresh = findRecentBreakoutAge(candles['1h'], 4, 12);
  const earlyReversal = structure1h.higherLow && (structure1h.higherHigh || structure1h.breakout) &&
    (structure15.higherLow || structure15.breakout);
  const impulseQuality = (bullish15Count >= 2 || bullish1hCount >= 2) && (volume15 >= 1.05 || volume1h >= 1.05 || flowStrong);
  const startEvidence = breakoutFresh !== null || breakout1hFresh !== null || earlyReversal || (compressionReady && impulseQuality);
  const continuationEvidence = trend4h && trend1h && (trend15m || earlyReversal) &&
    (flowPositive || volume15 >= 1.15 || volume1h >= 1.15) && resistanceRoom && !bearishFlow;

  let moveStatus = 'POTENTIAL';
  let moveType = 'NONE';
  let moveTypeLabel = 'هنوز شروع معتبر شناسایی نشده';
  let moveAgeBars = null;
  if (startEvidence && continuationEvidence && trendScore >= 70 && !overheated && !oiDanger) {
    moveStatus = 'CONFIRMED';
    moveType = breakoutFresh !== null ? 'FRESH_15M_BREAKOUT' : breakout1hFresh !== null ? 'FRESH_1H_BREAKOUT' : earlyReversal ? 'BULLISH_REVERSAL' : 'COMPRESSION_EXPANSION';
    moveTypeLabel = ({
      FRESH_15M_BREAKOUT: 'شکست تازه ۱۵ دقیقه‌ای', FRESH_1H_BREAKOUT: 'شکست تازه یک‌ساعته',
      BULLISH_REVERSAL: 'برگشت صعودی ساختاری', COMPRESSION_EXPANSION: 'خروج از تراکم با تقاضا',
    })[moveType];
    moveAgeBars = breakoutFresh ?? (breakout1hFresh != null ? breakout1hFresh * 4 : null);
  } else if (startEvidence && trendScore >= 58 && !bearishFlow && !structuralDamage) {
    moveStatus = 'EARLY';
    moveType = earlyReversal ? 'BULLISH_REVERSAL' : 'EARLY_DEMAND';
    moveTypeLabel = earlyReversal ? 'برگشت اولیه صعودی' : 'تقاضای اولیه در حال شکل‌گیری';
    moveAgeBars = breakoutFresh;
  } else if (compressionReady && trendScore >= 52 && !bearishFlow) {
    moveStatus = 'WATCHING';
    moveType = 'PRE_MOVE_SETUP';
    moveTypeLabel = 'آماده‌سازی پیش از حرکت';
  }

  const entryScore = clamp(
    trendScore * 0.38 + (impulseQuality ? 12 : 0) + (flowStrong ? 12 : flowPositive ? 6 : 0) +
    (bullish15Count >= 2 ? 8 : 0) + (bullish1hCount >= 2 ? 7 : 0) +
    (breakoutFresh !== null ? 10 : 0) + (breakout1hFresh !== null ? 7 : 0) +
    (room4h.score * 0.08) + (noHeavyOverhead ? 5 : -8) - (overheated ? 18 : 0) -
    (bearishFlow ? 18 : 0) - (oiDanger ? 10 : 0), 0, 100
  );
  const growthScore = Math.round(trendScore);
  const moveScore = Math.round(entryScore);

  const evidence = [];
  const warnings = [];
  if (trend4h) evidence.push('جهت ساختاری 4H صعودی');
  if (trend1h) evidence.push('ساختار 1H در حال تقویت');
  if (trend15m) evidence.push('ساختار کوتاه‌مدت صعودی');
  if (flowPositive) evidence.push('برتری خریداران در معاملات واقعی');
  if (flowStrong) evidence.push('فشار خرید قوی');
  if (oiHealthy && flow.oiChangePct != null) evidence.push('افزایش OI بدون افت قیمت');
  if (compressionReady) evidence.push('تراکم/آماده‌سازی پیش از حرکت');
  if (breakoutFresh !== null) evidence.push('شکست تازه در 15M');
  if (breakout1hFresh !== null) evidence.push('شکست تازه در 1H');
  if (bearishFlow) warnings.push('فشار فروش در جریان معاملات');
  if (oiDanger) warnings.push('افزایش OI همراه با افت قیمت؛ احتمال ورود پوزیشن‌های فروش');
  if (overheated) warnings.push('حرکت کوتاه‌مدت بیش از حد کشیده شده؛ ورود دیرهنگام پرریسک است');
  if (!resistanceRoom) warnings.push('مقاومت نزدیک در مسیر قیمت');
  if (flow.dataQuality === 'LOW') warnings.push('داده مشتقات ناکافی؛ این بخش با امتیاز خنثی محاسبه شد');

  return {
    symbol, score: growthScore, growthScore, moveScore,
    growthStatus: trendScore >= 75 ? 'HIGH_POTENTIAL' : trendScore >= 60 ? 'WATCHLIST' : 'NORMAL',
    moveStatus, moveType, moveTypeLabel, moveAgeBars,
    moveAgeMinutes: moveAgeBars == null ? null : moveAgeBars * 15,
    stage: moveStatus === 'CONFIRMED' ? 'موج صعودی تازه با شواهد ادامه‌دار' : moveStatus === 'EARLY' ? 'نشانه‌های اولیه شروع موج' : moveStatus === 'WATCHING' ? 'در حال آماده‌سازی' : 'شرایط کافی برای شروع موج وجود ندارد',
    price, livePrice: price,
    returns: { '15m': tf15.returns.return1, '1h': tf1h.returns.return1, '4h': tf4h.returns.return1, '1d': daily.dailyReturn },
    volume: { '15m': volume15, '1h': volume1h, '1d': daily.volumeRatio5 },
    daily, derivatives: flow,
    structure: {
      daily: daily.score, '4h': Math.round(trend4h ? 85 : 45), '1h': Math.round(trend1h ? 85 : 45),
      '15m': Math.round(trend15m ? 85 : 45), compression4h: compression4h.score,
      compression1h: compression1h.score, roomToResistance4hPct: room4h.roomPct,
      roomToResistance1dPct: room1d.roomPct,
    },
    evidence, warnings,
    _analysis: {
      tf15: { ema21: tf15.ema21, emaBullish: tf15.emaBullish, structure: tf15.structure },
      tf1h: { emaBullish: tf1h.emaBullish, structure: tf1h.structure },
      tf4h: { emaBullish: tf4h.emaBullish, emaSlope: tf4h.emaSlope, structure: tf4h.structure },
    },
  };
}

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previousClose), Math.abs(current.low - previousClose)));
  }
  return average(ranges);
}

function classifyOpportunity(coin) {
  if (coin.growthScore >= 75) return 'SWING';
  if (coin.growthScore >= 58) return 'SHORT-TERM';
  return 'SCALP';
}

function buildTradeSetup(coin, candles15m) {
  const price = number(coin.livePrice, coin.price);
  const atr = calculateATR(candles15m, 14);
  if (!price || !atr) return null;

  const ema21 = number(coin._analysis?.tf15?.ema21);
  const swingPoints = findSwingPoints(candles15m.slice(-60), 2);
  const validSupports = [ema21, ...swingPoints.lows]
    .filter((level) => level > 0 && level < price && price - level <= atr * 3.5)
    .sort((a, b) => b - a);
  const support = validSupports[0] || Math.max(0, price - atr * 1.25);
  const entryLow = support - atr * 0.25;
  const entryHigh = support + atr * 0.18;
  const structuralLow = swingPoints.lows.filter((level) => level < entryLow).sort((a, b) => b - a)[0];
  const stopLoss = Math.min(entryLow - atr * 0.35, (structuralLow || entryLow) - atr * 0.25);
  const risk = Math.max(entryHigh - stopLoss, atr * 0.5);
  const resistanceLevels = swingPoints.highs.filter((level) => level > entryHigh).sort((a, b) => a - b);
  const target = (multiple, index) => resistanceLevels[index] && resistanceLevels[index] > entryHigh + risk * 0.8
    ? Math.max(resistanceLevels[index], entryHigh + risk * multiple)
    : entryHigh + risk * multiple;
  const tp1 = target(1.5, 0);
  const tp2 = target(2.5, 1);
  const tp3 = target(4, 2);
  const last5m = coin._candles5m?.at(-1);
  const previous5m = coin._candles5m?.at(-2);
  const strength5m = last5m ? getCandleStrength(last5m) : null;
  const bouncedFromZone = Boolean(last5m && last5m.low <= entryHigh && last5m.close > entryHigh &&
    last5m.close > last5m.open && strength5m.closeLocation >= 0.65 &&
    previous5m && last5m.close > previous5m.high);

  return {
    entryLow, entryHigh, entryMid: (entryLow + entryHigh) / 2,
    confirmation: 'کندل بسته‌شده ۵ دقیقه‌ای باید محدوده ورود را لمس کند، صعودی بسته شود و سقف کندل قبلی را بشکند.',
    confirmationMet: bouncedFromZone,
    stopLoss, tp1, tp2, tp3,
    riskReward: Number(((tp1 - entryHigh) / risk).toFixed(2)),
    atr,
    support,
  };
}

function isSameSetup(previous, setup, opportunityType) {
  if (!previous?.setup || !setup || previous.opportunityType !== opportunityType) return false;
  const oldMid = number(previous.setup.entryMid);
  const newMid = number(setup.entryMid);
  if (!oldMid || !newMid) return false;
  return Math.abs(newMid - oldMid) / oldMid <= 0.012;
}

function detectSeriousDecline(candles5m, candles15m, flow) {
  if (!Array.isArray(candles5m) || candles5m.length < 25 || !Array.isArray(candles15m) || candles15m.length < 25) {
    return { confirmed: false, reason: null, severity: 'UNKNOWN' };
  }
  const closes5 = candles5m.map((c) => c.close);
  const ema9_5 = calculateEMA(closes5, 9);
  const ema21_5 = calculateEMA(closes5, 21);
  const last5 = candles5m.at(-1);
  const prev5 = candles5m.at(-2);
  const last15 = candles15m.at(-1);
  const ema9_15 = calculateEMA(candles15m.map((c) => c.close), 9);
  const strength5 = getCandleStrength(last5);
  const volume5 = getVolumeRatio(candles5m);
  const breakdown5 = last5.close < ema9_5.at(-1) && ema9_5.at(-1) < ema21_5.at(-1) &&
    last5.close < prev5.low && strength5.closeLocation <= 0.35;
  const strongSellCandle = last5.close < last5.open && strength5.closeLocation <= 0.18 && volume5 >= 1.65;
  const confirm15 = last15.close < ema9_15.at(-1) && last15.close < last15.open;
  const sellersControl = number(flow?.imbalance) < -0.12 || number(flow?.buyRatio, 0.5) < 0.43;
  const hardBreakdown = breakdown5 && (confirm15 || sellersControl);
  const panicSell = strongSellCandle && (sellersControl || confirm15);
  return {
    confirmed: hardBreakdown || panicSell,
    reason: hardBreakdown ? 'شکست ساختار کوتاه‌مدت همراه با تأیید فروش' : panicSell ? 'کندل فروش قدرتمند با حجم بالا و تأیید فشار فروش' : null,
    severity: hardBreakdown || panicSell ? 'SERIOUS' : breakdown5 || strongSellCandle ? 'WARNING' : 'NORMAL',
  };
}

function updateTradeState(coin, setup, previousState, nowMs, candles5m = [], candles15m = []) {
  const opportunityType = coin.opportunityType;
  const sameSetup = isSameSetup(previousState, setup, opportunityType);
  const previous = sameSetup ? previousState : null;
  const price = number(coin.livePrice, coin.price);
  const now = new Date(nowMs).toISOString();
  const statusLabels = {
    ENTRY_CONFIRMED: 'ورود تأیید شده', NEAR_ENTRY: 'نزدیک ورود', WAITING: 'در انتظار',
    NEAR_EXIT: 'نزدیک خروج', EXIT_CONFIRMED: 'خروج قطعی', INVALIDATED: 'ابطال موقعیت', EXPIRED: 'منقضی شده',
  };

  if (!setup) return {
    symbol: coin.symbol, opportunityType, status: 'WAITING', statusLabel: statusLabels.WAITING,
    setup: null, updatedAt: now,
  };

  const terminal = new Set(['EXIT_CONFIRMED', 'INVALIDATED', 'EXPIRED']);
  const maxAgeHours = CONFIG.SETUP_MAX_AGE_HOURS[opportunityType] || 72;
  const createdAt = previous?.createdAt || now;
  const ageHours = (nowMs - Date.parse(createdAt)) / 3600000;
  const oldStatus = previous?.status;
  let status = previous?.status || 'WAITING';
  let enteredAt = previous?.enteredAt || null;
  let entryPrice = number(previous?.entryPrice, 0) || null;
  let exitReason = previous?.exitReason || null;

  if (previous && terminal.has(oldStatus)) {
    status = oldStatus;
  } else if (ageHours > maxAgeHours) {
    status = 'EXPIRED';
    exitReason = 'عمر setup از محدوده مجاز گذشت';
  } else if (price <= setup.stopLoss && (oldStatus === 'ENTRY_CONFIRMED' || oldStatus === 'NEAR_EXIT')) {
    status = 'EXIT_CONFIRMED';
    exitReason = 'حد ضرر معامله فعال لمس شد';
  } else if ((oldStatus === 'ENTRY_CONFIRMED' || oldStatus === 'NEAR_EXIT') && detectSeriousDecline(candles5m, candles15m, coin.derivatives).confirmed) {
    status = 'EXIT_CONFIRMED';
    exitReason = detectSeriousDecline(candles5m, candles15m, coin.derivatives).reason;
  } else if (price <= setup.stopLoss) {
    status = 'INVALIDATED';
    exitReason = 'شکست حد ضرر ساختاری پیش از ورود';
  } else if (oldStatus === 'ENTRY_CONFIRMED' || oldStatus === 'NEAR_EXIT') {
    const nearTarget = price >= setup.tp1 * 0.985;
    const nearStop = price <= setup.stopLoss + setup.atr * 0.25;
    if (price >= setup.tp1) {
      status = 'EXIT_CONFIRMED';
      exitReason = 'هدف اول لمس شد';
    } else if (nearTarget || nearStop) {
      status = 'NEAR_EXIT';
      exitReason = nearTarget ? 'قیمت به هدف اول نزدیک شده' : 'قیمت به حد ضرر نزدیک شده';
    } else {
      status = 'ENTRY_CONFIRMED';
      exitReason = null;
    }
  } else if (setup.confirmationMet && price > setup.entryHigh) {
    status = 'ENTRY_CONFIRMED';
    enteredAt = now;
    entryPrice = price;
  } else if (price >= setup.entryLow - setup.atr * CONFIG.NEAR_ENTRY_ATR && price <= setup.entryHigh + setup.atr * CONFIG.NEAR_ENTRY_ATR) {
    status = 'NEAR_ENTRY';
  } else {
    status = 'WAITING';
  }

  return {
    symbol: coin.symbol,
    opportunityType,
    status,
    statusLabel: statusLabels[status] || status,
    setup,
    createdAt,
    updatedAt: now,
    enteredAt,
    entryPrice,
    exitReason,
    ageHours: Number(Math.max(0, ageHours).toFixed(1)),
  };
}

function attachTradeLifecycle(coin, candles15m, candles5m, previousStates, nowMs) {
  coin.opportunityType = classifyOpportunity(coin);
  coin._candles5m = candles5m;
  const setup = buildTradeSetup(coin, candles15m);
  const tradeState = updateTradeState(coin, setup, previousStates[coin.symbol], nowMs);
  coin.tradeStatus = tradeState.status;
  coin.tradeStatusLabel = tradeState.statusLabel;
  coin.tradeSetup = tradeState.setup;
  coin.tradeState = tradeState;
  delete coin._candles5m;
  delete coin._analysis;
  return coin;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let result;
  try { result = raw ? JSON.parse(raw) : null; } catch { result = null; }
  if (!response.ok || !result?.ok) {
    const error = new Error(result?.description || `Telegram HTTP ${response.status}: ${raw.slice(0, 160) || 'empty response'}`);
    error.retryAfter = result?.parameters?.retry_after;
    throw error;
  }
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text.split('\n\n').filter(Boolean);
  const messages = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLength) { current = candidate; continue; }
    if (current) { messages.push(current); current = ''; }
    if (block.length <= maxLength) { current = block; continue; }
    for (const line of block.split('\n')) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > maxLength && current) { messages.push(current); current = line; }
      else current = next;
    }
  }
  if (current) messages.push(current);
  return messages;
}

async function sendReports(report) {
  const messages = splitTelegramMessage(report, CONFIG.TELEGRAM_MAX_LENGTH - 50);
  for (let i = 0; i < messages.length; i++) {
    const payload = `📄 گزارش ${i + 1}/${messages.length}\n\n${messages[i]}`;
    try { await sendTelegram(payload); }
    catch (error) {
      if (!error.retryAfter) throw error;
      await sleep(error.retryAfter * 1000 + 500);
      await sendTelegram(payload);
    }
    if (i < messages.length - 1) await sleep(CONFIG.TELEGRAM_DELAY);
  }
}

function buildReport(candidates, stats, duration, rankChanges = null) {
  const growth = candidates.filter((coin) => number(coin.growthRank) <= CONFIG.TOP_COUNT)
    .sort((a, b) => number(a.growthRank) - number(b.growthRank));
  const early = candidates.filter((coin) => number(coin.moveRank) <= CONFIG.TOP_COUNT)
    .sort((a, b) => number(a.moveRank) - number(b.moveRank));
  const blocks = [[
    '🚀 GATE.IO | SUSTAINED BULLISH MOVE RADAR',
    '━━━━━━━━━━━━━━━━━━',
    '🎯 هدف: شکار شروع موج صعودی پیوسته و ورود در زمان مناسب',
    '🧱 رتبه روند: کیفیت و پیوستگی ساختار صعودی | ⚡ رتبه ورود: تازگی حرکت + تقاضا + جریان معاملات',
    '🛑 خروج: اولین شکست جدی ساختار کوتاه‌مدت با تأیید فشار فروش؛ کندل قرمز منفرد کافی نیست.',
    `📌 بازارهای بررسی‌شده: ${candidates.length}`,
    `📊 قرارداد فعال: ${stats.active} | نقدشونده: ${stats.liquid}`,
    `🔍 بررسی موفق: ${stats.success} | خطا: ${stats.errors}`,
    `⏱ زمان اسکن: ${(duration / 1000).toFixed(1)} ثانیه`,
    '━━━━━━━━━━━━━━━━━━',
  ].join('\n')];

  const rankIcon = (changes, key, symbol) => {
    const item = changes?.[symbol]?.[key];
    if (!item || item.status === 'NEW') return '🆕';
    if (item.change > 0) return `🟢↑${item.change}`;
    if (item.change < 0) return `🔴↓${Math.abs(item.change)}`;
    return '➖';
  };
  const statusLabel = (coin) => ({
    HIGH_POTENTIAL: '🟢 روند صعودی باکیفیت', WATCHLIST: '🟡 روند در حال شکل‌گیری', NORMAL: '⚪ شرایط ناکافی',
  }[coin.growthStatus] || coin.growthStatus);
  const moveLabel = (coin) => ({
    CONFIRMED: '🟢 موج صعودی پیوسته تأیید شد', EARLY: '🔵 نشانه‌های شروع موج', WATCHING: '🟡 آماده‌سازی',
    POTENTIAL: '⚪ بدون تأیید شروع', INVALIDATED: '🔴 ابطال‌شده', LATE: '🟠 حرکت انجام‌شده',
  }[coin.moveStatus] || coin.moveStatus);
  const makeCoinBlock = (coin, rank, kind) => {
    const isGrowth = kind === 'growth';
    const score = isGrowth ? coin.growthScore : coin.moveScore;
    const rankChange = rankIcon(rankChanges, isGrowth ? 'growth' : 'move', coin.symbol);
    const lines = [
      `${rank}. ${coin.symbol} ${rankChange} | امتیاز ${score}/100`,
      isGrowth
        ? `🧱 استعداد: ${statusLabel(coin)} | رتبه شروع: ${coin.moveRank ?? '-'} | امتیاز شروع: ${coin.moveScore ?? '-'}`
        : `⚡ وضعیت حرکت: ${moveLabel(coin)} | نوع: ${coin.moveTypeLabel} | رتبه استعداد: ${coin.growthRank ?? '-'} | امتیاز استعداد: ${coin.growthScore ?? '-'}`,
      `💰 قیمت: ${formatPrice(number(coin.livePrice, coin.price))}`,
      `📈 بازده: 15M ${number(coin.returns['15m']).toFixed(2)}% | 1H ${number(coin.returns['1h']).toFixed(2)}% | 4H ${number(coin.returns['4h']).toFixed(2)}% | 1D ${number(coin.returns['1d']).toFixed(2)}%`,
      `📐 ساختار: 1D ${coin.structure.daily} | 4H ${coin.structure['4h']} | فشردگی 4H ${coin.structure.compression4h} | فضای مقاومت ${coin.structure.roomToResistance4hPct == null ? 'نامشخص' : `${coin.structure.roomToResistance4hPct.toFixed(1)}%`}`,
      `🧾 جریان معاملات: خرید ${(coin.derivatives.buyRatio * 100).toFixed(1)}% | عدم‌تعادل ${(coin.derivatives.imbalance * 100).toFixed(1)}% | OI ${coin.derivatives.oiChangePct == null ? 'N/A' : `${coin.derivatives.oiChangePct.toFixed(2)}%`} | کیفیت داده ${coin.derivatives.dataQuality}`,
      coin.growthEvent ? `🕒 رویداد: ${coin.growthEvent.status} | عمر ${coin.growthEvent.ageMinutes ?? '-'} دقیقه | تغییر از شروع ${coin.growthEvent.gainPct ?? 0}%` : null,
    ].filter(Boolean);
    if (coin.tradeStatus) lines.push(`📍 وضعیت معامله: ${coin.tradeStatusLabel || coin.tradeStatus}`);
    if (coin.tradeStatus === 'EXIT_CONFIRMED') lines.push(`🚨 خروج: ${coin.tradeState?.exitReason || 'ریزش جدی تأیید شد'}`);
    if (coin.tradeSetup) {
      lines.push(`🎯 محدوده ورود: ${formatPrice(coin.tradeSetup.entryLow)} تا ${formatPrice(coin.tradeSetup.entryHigh)} | تأیید 5M: ${coin.tradeSetup.confirmationMet ? 'دریافت شد' : 'دریافت نشده'}`);
      lines.push(`🛑 حد ضرر: ${formatPrice(coin.tradeSetup.stopLoss)} | TP1 ${formatPrice(coin.tradeSetup.tp1)} | RR ${coin.tradeSetup.riskReward}R`);
    }
    if (coin.evidence?.length) lines.push(`✔️ شواهد: ${coin.evidence.slice(0, 5).join('، ')}`);
    if (coin.warnings?.length) lines.push(`⚠️ هشدار: ${coin.warnings.slice(0, 3).join('، ')}`);
    return lines.join('\n');
  };

  blocks.push(`🧱 رتبه‌بندی اول: کیفیت روند صعودی (${growth.length} مورد)\n━━━━━━━━━━━━━━━━━━`);
  if (!growth.length) blocks.push('موردی در فهرست روند صعودی باکیفیت نیست.');
  growth.forEach((coin, index) => blocks.push(makeCoinBlock(coin, index + 1, 'growth')));
  blocks.push(`⚡ رتبه‌بندی دوم: بهترین زمان ورود (${early.length} مورد)\n━━━━━━━━━━━━━━━━━━`);
  if (!early.length) blocks.push('هنوز ارز واجد شرایط ورود وجود ندارد.');
  early.forEach((coin, index) => blocks.push(makeCoinBlock(coin, index + 1, 'move')));
  blocks.push('━━━━━━━━━━━━━━━━━━\nℹ️ این رتبه‌بندی احتمال و کیفیت شرایط را نشان می‌دهد، نه تضمین رشد یا توصیه ورود.');
  return blocks.join('\n\n');
}

async function main() {
  const startedAt = Date.now();
  const nowMs = Date.now();
  console.log('\n🚀 GATE.IO SUSTAINED BULLISH MOVE RADAR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎯 Sustained bullish trend quality + timely entry readiness');
  console.log('🛑 Exit requires serious short-term structure breakdown with selling confirmation.');

  const [contracts, tickers, previousTradeStates] = await Promise.all([
    getContracts(), getTickers(), getTradeStates(),
  ]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');

  const tickerMap = new Map(tickers.map((ticker) => [ticker.contract, ticker]));
  const activeContracts = contracts.filter((contract) => contract?.name && contract.in_delisting !== true && tickerMap.has(contract.name));
  const liquidMarkets = activeContracts.map((contract) => {
    const ticker = tickerMap.get(contract.name);
    return {
      symbol: contract.name, ticker, contract,
      quoteVolume: number(ticker.volume_24h_quote), lastPrice: number(ticker.last),
    };
  }).filter((market) => market.lastPrice > 0 && market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log(`📊 Active contracts: ${activeContracts.length}`);
  console.log(`💧 Liquid contracts: ${liquidMarkets.length}`);
  console.log('🔍 Scanning all liquid contracts...\n');

  let success = 0;
  let errors = 0;
  const analyzed = await mapLimit(liquidMarkets, CONFIG.CONCURRENCY, async (market) => {
    const [candles5mData, candles15mData, candles1h, candles4h, candles1dData, tradesResult, statsResult] = await Promise.all([
      getCandles(market.symbol, '5m', CONFIG.TIMEFRAMES['5m'].limit, true).catch(() => ({ closed: [], current: null })),
      getCandles(market.symbol, '15m', CONFIG.TIMEFRAMES['15m'].limit, true),
      getCandles(market.symbol, '1h', CONFIG.TIMEFRAMES['1h'].limit),
      getCandles(market.symbol, '4h', CONFIG.TIMEFRAMES['4h'].limit),
      getCandles(market.symbol, '1d', CONFIG.TIMEFRAMES['1d'].limit, true),
      getRecentTrades(market.symbol).catch(() => []),
      getContractStats(market.symbol).catch(() => []),
    ]);
    const candles5m = candles5mData.closed;
    const candles15m = candles15mData.closed;
    const candles1d = candles1dData.closed;
    if (candles15m.length < 30 || candles1h.length < 30 || candles4h.length < 30) {
      throw new Error('کندل کافی برای تحلیل تایم‌فریم‌ها دریافت نشد.');
    }
    success++;
    const derivatives = analyzeDerivatives(tradesResult, statsResult, market.contract?.quanto_multiplier);
    const candidate = analyzeCoin({
      symbol: market.symbol,
      candles: { '15m': candles15m, '1h': candles1h, '4h': candles4h, '1d': candles1d },
      dailyCurrent: candles1dData.current,
      livePrice: market.lastPrice,
      derivatives,
    });
    if (!candidate) return null;
    candidate.livePrice = market.lastPrice;
    candidate.live15m = candles15mData.current;
    candidate.live1d = candles1dData.current;
    candidate.opportunityType = classifyOpportunity(candidate);
    candidate._candles5m = candles5m;
    const setup = buildTradeSetup(candidate, candles15m);
    const tradeState = updateTradeState(candidate, setup, previousTradeStates[market.symbol], nowMs, candles5m, candles15m);
    candidate.tradeStatus = tradeState.status;
    candidate.tradeStatusLabel = tradeState.statusLabel;
    candidate.tradeSetup = tradeState.setup;
    candidate.tradeState = tradeState;
    delete candidate._analysis;
    delete candidate._candles5m;
    return candidate;
  });

  const candidates = [];
  for (const result of analyzed) {
    if (result?.error) { errors++; continue; }
    if (result) candidates.push(result);
  }

  const updatedTradeStates = { ...previousTradeStates };
  for (const coin of candidates) updatedTradeStates[coin.symbol] = coin.tradeState;

  let rankChanges = null;
  let rankedCandidates = candidates;
  try {
    const storageResult = await saveMarketSnapshot(candidates, { tradeStates: updatedTradeStates });
    rankChanges = storageResult.rankChanges;
    rankedCandidates = storageResult.rankedCandidates;
    console.log('\n💾 MARKET DATA SAVED');
    console.log(`Snapshots: ${storageResult.snapshotsSaved}`);
    console.log(`History records: ${storageResult.historyCount}`);
    console.log(`Coin summaries: ${storageResult.summaryCount}`);
    console.log(`Trade states: ${storageResult.tradeStateCount}`);
    console.log('📊 Independent growth and early-move ranks calculated.');
  } catch (storageError) {
    console.error('⚠️ MARKET STORAGE FAILED:', storageError);
    rankedCandidates = [...candidates].sort((a, b) => number(b.growthScore) - number(a.growthScore));
    rankedCandidates.forEach((coin, index) => { coin.growthRank = index + 1; });
    [...candidates].sort((a, b) => number(b.moveScore) - number(a.moveScore))
      .forEach((coin, index) => { coin.moveRank = index + 1; });
  }

  const duration = Date.now() - startedAt;
  const stats = { active: activeContracts.length, liquid: liquidMarkets.length, success, errors };
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏆 TOP SUSTAINED BULLISH TRENDS');
  [...rankedCandidates].sort((a, b) => number(a.growthRank) - number(b.growthRank))
    .slice(0, CONFIG.TOP_COUNT).forEach((coin) => console.log(`${coin.growthRank}. ${coin.symbol} | ${coin.growthScore}/100 | ${coin.growthStatus}`));
  console.log('\n⚡ TOP ENTRY TIMING');
  [...rankedCandidates].sort((a, b) => number(a.moveRank) - number(b.moveRank))
    .slice(0, CONFIG.TOP_COUNT).forEach((coin) => console.log(`${coin.moveRank}. ${coin.symbol} | ${coin.moveScore}/100 | ${coin.moveStatus} | ${coin.moveTypeLabel}`));
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Candidates: ${rankedCandidates.length}`);
  console.log(`Successful analyses: ${success}`);
  console.log(`Errors: ${errors}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await sendReports(buildReport(rankedCandidates, stats, duration, rankChanges));
  console.log('✅ Telegram report sent successfully.');
}

main().catch((error) => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
