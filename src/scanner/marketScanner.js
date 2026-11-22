
/**
 * GATE.IO USDT PERPETUAL — RELATIVE STRENGTH & EARLY BULLISH RADAR
 * ----------------------------------------------------------------
 * One unified active list: maximum 10 coins.
 *
 * Ranking considers:
 * 1. Current growth potential and higher-timeframe structure.
 * 2. Current energy and continuation quality.
 * 3. Each coin's progress compared with its own historical structure.
 * 4. Entry readiness and freshness.
 * 5. Stability: small fluctuations do not reshuffle the active list.
 *
 * Only this file is modified:
 * src/scanner/marketScanner.js
 *
 * Node.js 20+
 */

import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',

  TIMEFRAMES: {
    '5m': { seconds: 300, limit: 100 },
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 },
    '1d': { seconds: 86400, limit: 100 },
  },

  TOP_COUNT: 10,
  MIN_QUOTE_VOLUME_24H: 100000,
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,

  DERIVATIVE_TRADE_LIMIT: 100,
  DERIVATIVE_STATS_LIMIT: 12,

  MAX_ACTIVE_AGE_MINUTES: 240,

  // حافظه
  SCANNER_MEMORY_FILE: 'data/scanner-memory.json',
  WATCHLIST_RETENTION_DAYS: 30,
  HISTORY_RETENTION_DAYS: 30,
  TRADE_STATE_RETENTION_DAYS: 11,

  // مقایسه تاریخی
  HISTORY_MIN_INTERVAL_MINUTES: 10,
  HISTORY_MAX_SNAPSHOTS: 300,
  HISTORY_BASELINE_SNAPSHOTS: 24,

  // جلوگیری از تغییر رتبه با نوسان‌های کوچک
  RANK_STABILITY_MARGIN: 5,

  HTML_REPORT_FILE: 'market-report.html',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const average = (values) =>
  values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;

const median = (values) => {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pctChange = (current, previous) =>
  !previous || previous <= 0
    ? 0
    : ((current - previous) / previous) * 100;

const formatPrice = (value) => {
  if (!Number.isFinite(Number(value))) return '-';

  value = Number(value);

  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);

  return value.toPrecision(5);
};

const getCandleValue = (candle) =>
  candle.turnover > 0 ? candle.turnover : candle.volume;

/* -------------------------------------------------------------------------- */
/* MEMORY                                                                     */
/* -------------------------------------------------------------------------- */

function createEmptyMemory() {
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    watchlist: {},
    tradeStates: {},
    activeList: {},
    coinHistory: {},
  };
}

async function loadScannerMemory() {
  try {
    const raw = await readFile(CONFIG.SCANNER_MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...createEmptyMemory(),
      ...parsed,

      watchlist:
        parsed.watchlist &&
        typeof parsed.watchlist === 'object'
          ? parsed.watchlist
          : {},

      tradeStates:
        parsed.tradeStates &&
        typeof parsed.tradeStates === 'object'
          ? parsed.tradeStates
          : {},

      activeList:
        parsed.activeList &&
        typeof parsed.activeList === 'object'
          ? parsed.activeList
          : {},

      coinHistory:
        parsed.coinHistory &&
        typeof parsed.coinHistory === 'object'
          ? parsed.coinHistory
          : {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('⚠️ SCANNER MEMORY READ FAILED:', error.message);
    }

    return createEmptyMemory();
  }
}

async function saveScannerMemory(memory) {
  await mkdir('data', { recursive: true });

  memory.updatedAt = new Date().toISOString();

  await writeFile(
    CONFIG.SCANNER_MEMORY_FILE,
    JSON.stringify(memory, null, 2),
    'utf8'
  );
}

/* -------------------------------------------------------------------------- */
/* GATE API                                                                   */
/* -------------------------------------------------------------------------- */

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

        const error = new Error(
          `HTTP ${response.status}: ${body.slice(0, 200)}`
        );

        error.status = response.status;
        error.retryAfter = number(
          response.headers.get('Retry-After'),
          0
        );

        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        const delay = error.status === 429
          ? Math.max(
              error.retryAfter * 1000,
              1800 * (2 ** (attempt - 1))
            ) + Math.floor(Math.random() * 500)
          : 700 * attempt;

        await sleep(delay);
      }
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
  const params = new URLSearchParams({
    contract,
    limit: String(CONFIG.DERIVATIVE_TRADE_LIMIT),
  });

  return fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/trades?${params}`
  );
}

async function getContractStats(contract) {
  const params = new URLSearchParams({
    contract,
    interval: '5m',
    limit: String(CONFIG.DERIVATIVE_STATS_LIMIT),
  });

  return fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/contract_stats?${params}`
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
    limit: String(limit),
  });

  const raw = await fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`
  );

  if (!Array.isArray(raw)) {
    throw new Error(`Invalid candle response: ${contract} ${interval}`);
  }

  const candles = raw
    .map((c) => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),
      volume: number(c.v),
      turnover: number(c.sum),
    }))
    .filter((c) =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  const intervalSeconds = CONFIG.TIMEFRAMES[interval].seconds;

  const currentBucket =
    Math.floor(Date.now() / 1000 / intervalSeconds) *
    intervalSeconds;

  const closed = candles.filter(
    (c) => c.time < currentBucket
  );

  if (!includeCurrent) return closed;

  const current = candles.find(
    (c) => c.time === currentBucket
  ) || null;

  return {
    closed,
    current: current
      ? {
          bucketTime: currentBucket,
          open: current.open,
          high: current.high,
          low: current.low,
          close: current.close,
          volume: current.volume,
          turnover: current.turnover,
        }
      : null,
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          error: error.message,
          item: items[index],
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

/* -------------------------------------------------------------------------- */
/* DERIVATIVES                                                                */
/* -------------------------------------------------------------------------- */

function analyzeDerivatives(
  trades,
  stats,
  contractMultiplier = 1
) {
  const nowSeconds = Date.now() / 1000;

  const multiplier = number(contractMultiplier) > 0
    ? number(contractMultiplier)
    : 1;

  const validTrades = Array.isArray(trades)
    ? trades.filter((trade) => {
        if (
          !trade ||
          trade.is_internal === true ||
          number(trade.size) === 0 ||
          number(trade.price) <= 0
        ) {
          return false;
        }

        const rawTime = number(
          trade.create_time_ms,
          number(trade.create_time)
        );

        const timestamp = rawTime > 1e12
          ? rawTime / 1000
          : rawTime;

        return !timestamp || nowSeconds - timestamp <= 15 * 60;
      })
    : [];

  let buyNotional = 0;
  let sellNotional = 0;

  for (const trade of validTrades) {
    const notional =
      Math.abs(number(trade.size)) *
      number(trade.price) *
      multiplier;

    if (number(trade.size) > 0) {
      buyNotional += notional;
    } else {
      sellNotional += notional;
    }
  }

  const totalNotional = buyNotional + sellNotional;

  const buyRatio = totalNotional > 0
    ? buyNotional / totalNotional
    : 0.5;

  const imbalance = totalNotional > 0
    ? (buyNotional - sellNotional) / totalNotional
    : 0;

  const points = Array.isArray(stats)
    ? stats
        .map((item) => ({
          time: number(item.time),
          oi:
            number(item.open_interest_usd) ||
            number(item.open_interest),
          markPrice: number(item.mark_price),
          longLiq: number(
            item.long_liq_usd_new,
            number(item.long_liq_usd)
          ),
          shortLiq: number(
            item.short_liq_usd_new,
            number(item.short_liq_usd)
          ),
          takerLong: number(item.long_taker_size),
          takerShort: number(item.short_taker_size),
        }))
        .filter((item) => item.time > 0 && item.oi > 0)
        .sort((a, b) => a.time - b.time)
    : [];

  const first = points[0];
  const last = points.at(-1);

  const oiChangePct =
    first && last && first.oi > 0
      ? pctChange(last.oi, first.oi)
      : null;

  const markChangePct =
    first && last && first.markPrice > 0
      ? pctChange(last.markPrice, first.markPrice)
      : null;

  const shortLiqTotal = points.reduce(
    (sum, item) => sum + item.shortLiq,
    0
  );

  const longLiqTotal = points.reduce(
    (sum, item) => sum + item.longLiq,
    0
  );

  const latest = points.at(-1);

  const takerTotal =
    number(latest?.takerLong) +
    number(latest?.takerShort);

  const takerImbalance = takerTotal > 0
    ? (
        number(latest?.takerLong) -
        number(latest?.takerShort)
      ) / takerTotal
    : null;

  const combinedImbalance = takerImbalance == null
    ? imbalance
    : clamp(
        imbalance * 0.7 +
        takerImbalance * 0.3,
        -1,
        1
      );

  let flowScore = clamp(
    50 + combinedImbalance * 65,
    0,
    100
  );

  let oiScore = 50;

  if (oiChangePct !== null && markChangePct !== null) {
    if (oiChangePct > 0.15 && markChangePct > 0) {
      oiScore = clamp(
        58 + oiChangePct * 5 + markChangePct * 2,
        0,
        100
      );
    } else if (oiChangePct < -0.15 && markChangePct > 0) {
      oiScore = clamp(43 + oiChangePct * 3, 0, 60);
    } else if (oiChangePct > 0.15 && markChangePct <= 0) {
      oiScore = clamp(48 + oiChangePct * 2, 0, 65);
    } else {
      oiScore = clamp(50 + oiChangePct * 2, 0, 100);
    }
  }

  const liquidationDistortion =
    shortLiqTotal > 0 && totalNotional > 0
      ? clamp(shortLiqTotal / totalNotional, 0, 1)
      : 0;

  flowScore = clamp(
    flowScore - liquidationDistortion * 18,
    0,
    100
  );

  return {
    tradeCount: validTrades.length,
    buyNotional,
    sellNotional,
    totalNotional,
    buyRatio,
    imbalance: combinedImbalance,
    rawTradeImbalance: imbalance,
    statsTakerImbalance: takerImbalance,
    flowScore: Math.round(flowScore),
    openInterest: last?.oi ?? null,
    oiChangePct,
    markChangePct,
    oiScore: Math.round(oiScore),
    shortLiquidations: shortLiqTotal,
    longLiquidations: longLiqTotal,
    statsPoints: points.length,

    dataQuality:
      validTrades.length >= 10 && points.length >= 2
        ? 'GOOD'
        : validTrades.length >= 5 || points.length >= 2
          ? 'PARTIAL'
          : 'LOW',
  };
}

/* -------------------------------------------------------------------------- */
/* TECHNICAL ANALYSIS                                                         */
/* -------------------------------------------------------------------------- */

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

  const recentAverage = average(
    candles.slice(-3).map(getCandleValue)
  );

  const baselineMedian = median(
    candles.slice(-23, -3).map(getCandleValue)
  );

  return baselineMedian > 0
    ? recentAverage / baselineMedian
    : 0;
}

function getCandleStrength(candle) {
  const range = candle.high - candle.low;

  if (range <= 0) {
    return {
      closeLocation: 0,
      bodyRatio: 0,
      bullish: false,
    };
  }

  return {
    closeLocation: clamp(
      (candle.close - candle.low) / range,
      0,
      1
    ),
    bodyRatio: clamp(
      Math.abs(candle.close - candle.open) / range,
      0,
      1
    ),
    bullish: candle.close > candle.open,
  };
}

function findSwingPoints(candles, radius = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = radius;
    i < candles.length - radius;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= radius; j++) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) highs.push(current.high);
    if (isLow) lows.push(current.low);
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  if (candles.length < 25) {
    return {
      higherHigh: false,
      higherLow: false,
      breakout: false,
      bullishStructure: false,
      score: 0,
    };
  }

  const swings = findSwingPoints(
    candles.slice(-35),
    2
  );

  const higherHigh =
    swings.highs.length >= 2 &&
    swings.highs.at(-1) > swings.highs.at(-2);

  const higherLow =
    swings.lows.length >= 2 &&
    swings.lows.at(-1) > swings.lows.at(-2);

  const previous = candles.slice(-13, -1);

  const resistance = Math.max(
    ...previous.map((c) => c.high)
  );

  const last = candles.at(-1);

  const breakout =
    resistance > 0 &&
    last.close > resistance &&
    last.close > last.open;

  const bullishStructure =
    (higherHigh && higherLow) ||
    (breakout && higherLow);

  let score = 0;

  if (higherHigh) score += 30;
  if (higherLow) score += 30;
  if (breakout) score += 40;

  return {
    higherHigh,
    higherLow,
    breakout,
    bullishStructure,
    resistance,
    score,
  };
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

    emaBullish:
      last.close > currentEma9 &&
      currentEma9 > currentEma21,

    emaSlope: currentEma21 > previousEma21,

    structure: analyzeStructure(candles),
    volumeRatio: getVolumeRatio(candles),
    strength: getCandleStrength(last),

    returns: {
      return1: pctChange(last.close, previous.close),

      return4: pctChange(
        last.close,
        candles[candles.length - 5].close
      ),

      return16: pctChange(
        last.close,
        candles[candles.length - 17].close
      ),
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

  const avg5Volume = average(
    previous5.map(getCandleValue)
  );

  const avg10Volume = average(
    previous10.map(getCandleValue)
  );

  const dailyVolume = getCandleValue(last);

  const volumeRatio5 =
    avg5Volume > 0 ? dailyVolume / avg5Volume : 0;

  const volumeRatio10 =
    avg10Volume > 0 ? dailyVolume / avg10Volume : 0;

  const previous20 = candles.slice(-21, -1);
  const previous50 = candles.slice(-51, -1);

  const resistance20 = previous20.length
    ? Math.max(...previous20.map((c) => c.high))
    : 0;

  const resistance50 = previous50.length
    ? Math.max(...previous50.map((c) => c.high))
    : 0;

  const price = number(livePrice, last.close);
  const currentOpen = number(currentCandle?.open, last.close);
  const currentHigh = number(currentCandle?.high, price);
  const currentLow = number(currentCandle?.low, price);

  const currentRange = currentHigh - currentLow;

  const currentCloseLocation = currentRange > 0
    ? clamp((price - currentLow) / currentRange, 0, 1)
    : 0.5;

  const dailyReturn = pctChange(price, last.close);

  const dailyOpenReturn = currentCandle
    ? pctChange(price, currentOpen)
    : 0;

  const ema9Value = ema9.at(-1);
  const ema21Value = ema21.at(-1);
  const ema50Value = ema50.length ? ema50.at(-1) : 0;

  const emaBullish =
    price > ema9Value &&
    ema9Value > ema21Value;

  const ema50Bullish =
    ema50Value > 0 &&
    price > ema50Value;

  const emaSlope =
    ema21.at(-1) > ema21.at(-2);

  const breakout20 =
    resistance20 > 0 &&
    price > resistance20;

  const breakout50 =
    resistance50 > 0 &&
    price > resistance50;

  const nowSeconds = Math.floor(Date.now() / 1000);

  const dayBucket =
    Math.floor(nowSeconds / 86400) * 86400;

  const elapsedSeconds = clamp(
    nowSeconds - number(
      currentCandle?.bucketTime,
      dayBucket
    ),
    300,
    86400
  );

  const dayProgress = clamp(
    elapsedSeconds / 86400,
    0.05,
    1
  );

  const currentTurnover = number(currentCandle?.turnover);

  const projectedVolumeRatio =
    currentTurnover > 0 && avg10Volume > 0
      ? (currentTurnover / dayProgress) / avg10Volume
      : 0;

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

  if (
    currentCandle &&
    dailyOpenReturn > 0 &&
    currentCloseLocation >= 0.7
  ) {
    score += 5;
  }

  if (dailyReturn < -5) score -= 8;

  return {
    score: Math.round(clamp(score, 0, 100)),
    price,
    dailyReturn,
    dailyOpenReturn,
    emaBullish,
    ema50Bullish,
    emaSlope,
    higherHigh: base.structure.higherHigh,
    higherLow: base.structure.higherLow,
    breakout20,
    breakout50,
    volumeRatio5,
    volumeRatio10,
    projectedVolumeRatio,
    currentCandle: Boolean(currentCandle),
  };
}

function emptyDailyAnalysis(price = 0) {
  return {
    score: 50,
    price,
    dailyReturn: 0,
    dailyOpenReturn: 0,
    emaBullish: false,
    ema50Bullish: false,
    emaSlope: false,
    higherHigh: false,
    higherLow: false,
    breakout20: false,
    breakout50: false,
    volumeRatio5: 0,
    volumeRatio10: 0,
    projectedVolumeRatio: 0,
    currentCandle: false,
  };
}

function calculateCompression(candles) {
  if (!candles || candles.length < 40) {
    return { score: 35, ratio: null };
  }

  const recent = candles.slice(-12);
  const baseline = candles.slice(-36, -12);

  const recentRange =
    (
      Math.max(...recent.map((c) => c.high)) -
      Math.min(...recent.map((c) => c.low))
    ) /
    Math.max(average(recent.map((c) => c.close)), 1e-12);

  const baselineRange =
    (
      Math.max(...baseline.map((c) => c.high)) -
      Math.min(...baseline.map((c) => c.low))
    ) /
    Math.max(average(baseline.map((c) => c.close)), 1e-12);

  const ratio = baselineRange > 0
    ? recentRange / baselineRange
    : 1;

  return {
    score: Math.round(
      clamp(100 - ratio * 55, 0, 100)
    ),
    ratio,
  };
}

function calculateRoomToResistance(
  candles,
  price,
  lookback = 30
) {
  const previous = candles.slice(
    -(lookback + 1),
    -1
  );

  if (!previous.length || price <= 0) {
    return {
      resistance: null,
      roomPct: null,
      score: 45,
    };
  }

  const resistance = Math.max(
    ...previous.map((c) => c.high)
  );

  const roomPct = resistance > price
    ? pctChange(resistance, price)
    : 0;

  let score = 35;

  if (roomPct >= 8 && roomPct <= 25) score = 95;
  else if (roomPct > 25 && roomPct <= 45) score = 82;
  else if (roomPct >= 4 && roomPct < 8) score = 75;
  else if (roomPct > 45) score = 65;
  else if (roomPct <= 1) score = 20;

  return { resistance, roomPct, score };
}

function findRecentBreakoutAge(
  candles,
  maxAge = 24,
  lookback = 12
) {
  if (!candles || candles.length < lookback + 2) {
    return null;
  }

  const lastIndex = candles.length - 1;

  const firstIndex = Math.max(
    lookback + 1,
    lastIndex - maxAge
  );

  for (
    let index = lastIndex;
    index >= firstIndex;
    index--
  ) {
    const candle = candles[index];

    const resistance = Math.max(
      ...candles
        .slice(index - lookback, index)
        .map((item) => item.high)
    );

    const previousResistance = Math.max(
      ...candles
        .slice(index - lookback - 1, index - 1)
        .map((item) => item.high)
    );

    const previousClose =
      candles[index - 1]?.close ?? 0;

    if (
      candle.close > resistance &&
      candle.close > candle.open &&
      previousClose <= previousResistance
    ) {
      return lastIndex - index;
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* COIN ANALYSIS                                                              */
/* -------------------------------------------------------------------------- */

function analyzeCoin(data) {
  const {
    symbol,
    candles,
    dailyCurrent,
    livePrice,
    derivatives,
  } = data;

  const tf15 = analyzeTimeframe(candles['15m']);
  const tf1h = analyzeTimeframe(candles['1h']);
  const tf4h = analyzeTimeframe(candles['4h']);

  const daily =
    analyzeDaily(
      candles['1d'],
      dailyCurrent,
      livePrice
    ) ||
    emptyDailyAnalysis(livePrice);

  if (!tf15 || !tf1h || !tf4h) return null;

  const price = number(livePrice, tf15.price);
  const flow = derivatives || analyzeDerivatives([], []);

  const compression15 = calculateCompression(candles['15m']);
  const compression1h = calculateCompression(candles['1h']);
  const compression4h = calculateCompression(candles['4h']);

  const room4h = calculateRoomToResistance(
    candles['4h'],
    price,
    30
  );

  const room1d = calculateRoomToResistance(
    candles['1d'],
    price,
    30
  );

  const structure15 = tf15.structure;
  const structure1h = tf1h.structure;
  const structure4h = tf4h.structure;

  const dailyBias =
    daily.emaBullish ||
    daily.ema50Bullish;

  const trend4h =
    (tf4h.emaBullish || tf4h.emaSlope) &&
    (
      structure4h.higherLow ||
      structure4h.higherHigh ||
      structure4h.breakout
    );

  const trend1h =
    (tf1h.emaBullish || tf1h.emaSlope) &&
    (
      structure1h.higherLow ||
      structure1h.higherHigh ||
      structure1h.breakout
    );

  const trend15m =
    (tf15.emaBullish || tf15.emaSlope) &&
    (
      structure15.higherLow ||
      structure15.higherHigh ||
      structure15.breakout
    );

  const recent15 = candles['15m'].slice(-4);

  const bullish15Count = recent15.filter(
    (c) =>
      c.close > c.open &&
      getCandleStrength(c).closeLocation >= 0.55
  ).length;

  const recent1h = candles['1h'].slice(-3);

  const bullish1hCount = recent1h.filter(
    (c) =>
      c.close > c.open &&
      getCandleStrength(c).closeLocation >= 0.5
  ).length;

  const volume15 = tf15.volumeRatio;
  const volume1h = tf1h.volumeRatio;

  const flowPositive =
    flow.imbalance > 0.04 &&
    flow.buyRatio > 0.51;

  const flowStrong =
    flow.imbalance > 0.13 &&
    flow.buyRatio > 0.56;

  const oiHealthy =
    flow.oiChangePct == null ||
    (
      flow.oiChangePct > 0 &&
      (flow.markChangePct ?? 0) >= 0
    );

  const oiDanger =
    flow.oiChangePct != null &&
    flow.oiChangePct > 0.5 &&
    (flow.markChangePct ?? 0) < -0.35;

  const resistanceRoom =
    room4h.roomPct == null ||
    room4h.roomPct >= 2;

  const noHeavyOverhead =
    room4h.roomPct == null ||
    room4h.roomPct >= 1;

  const excessive15mRun =
    tf15.returns.return16 > 9;

  const excessive1hRun =
    tf1h.returns.return16 > 16;

  const overheated =
    excessive15mRun ||
    excessive1hRun ||
    (
      tf15.returns.return4 > 5.5 &&
      tf15.strength.closeLocation < 0.45
    );

  const bearishFlow =
    flow.imbalance < -0.12 ||
    (
      flow.buyRatio < 0.43 &&
      flow.dataQuality === 'GOOD'
    );

  const structuralDamage =
    (
      !tf4h.emaBullish &&
      !tf4h.structure.higherLow
    ) ||
    (
      !tf1h.emaSlope &&
      !tf1h.structure.higherLow &&
      !tf1h.structure.breakout
    );

  const trendScore = clamp(
    12 +
    (dailyBias ? 7 : 0) +
    (trend4h ? 18 : 0) +
    (trend1h ? 20 : 0) +
    (trend15m ? 12 : 0) +
    (structure4h.higherLow ? 5 : 0) +
    (structure1h.higherLow ? 6 : 0) +
    (structure15.higherLow ? 5 : 0) +
    (tf4h.emaSlope ? 4 : 0) +
    (tf1h.emaSlope ? 4 : 0) +
    (tf15.emaSlope ? 3 : 0) +
    (flowPositive ? 5 : 0) +
    (oiHealthy ? 3 : 0) +
    (resistanceRoom ? 4 : 0) -
    (bearishFlow ? 12 : 0) -
    (oiDanger ? 8 : 0) -
    (structuralDamage ? 9 : 0) -
    (overheated ? 12 : 0),
    0,
    100
  );

  const compressionReady =
    compression15.score >= 48 ||
    compression1h.score >= 48 ||
    compression4h.score >= 55;

  const breakoutFresh = findRecentBreakoutAge(
    candles['15m'],
    8,
    12
  );

  const breakout1hFresh = findRecentBreakoutAge(
    candles['1h'],
    4,
    12
  );

  const earlyReversal =
    structure1h.higherLow &&
    (
      structure1h.higherHigh ||
      structure1h.breakout
    ) &&
    (
      structure15.higherLow ||
      structure15.breakout
    );

  const impulseQuality =
    (
      bullish15Count >= 2 ||
      bullish1hCount >= 2
    ) &&
    (
      volume15 >= 1.05 ||
      volume1h >= 1.05 ||
      flowStrong
    );

  const startEvidence =
    breakoutFresh !== null ||
    breakout1hFresh !== null ||
    earlyReversal ||
    (
      compressionReady &&
      impulseQuality
    );

  const continuationEvidence =
    trend4h &&
    trend1h &&
    (
      trend15m ||
      earlyReversal
    ) &&
    (
      flowPositive ||
      volume15 >= 1.15 ||
      volume1h >= 1.15
    ) &&
    resistanceRoom &&
    !bearishFlow;

  let moveStatus = 'POTENTIAL';
  let moveType = 'NONE';
  let moveTypeLabel = 'هنوز شروع معتبر شناسایی نشده';
  let moveAgeBars = null;

  if (
    startEvidence &&
    continuationEvidence &&
    trendScore >= 70 &&
    !overheated &&
    !oiDanger
  ) {
    moveStatus = 'CONFIRMED';

    moveType =
      breakoutFresh !== null
        ? 'FRESH_15M_BREAKOUT'
        : breakout1hFresh !== null
          ? 'FRESH_1H_BREAKOUT'
          : earlyReversal
            ? 'BULLISH_REVERSAL'
            : 'COMPRESSION_EXPANSION';

    moveTypeLabel = ({
      FRESH_15M_BREAKOUT: 'شکست تازه ۱۵ دقیقه‌ای',
      FRESH_1H_BREAKOUT: 'شکست تازه یک‌ساعته',
      BULLISH_REVERSAL: 'برگشت صعودی ساختاری',
      COMPRESSION_EXPANSION: 'خروج از تراکم با تقاضا',
    })[moveType];

    moveAgeBars =
      breakoutFresh ??
      (
        breakout1hFresh != null
          ? breakout1hFresh * 4
          : null
      );
  } else if (
    startEvidence &&
    trendScore >= 58 &&
    !bearishFlow &&
    !structuralDamage &&
    !overheated &&
    !oiDanger
  ) {
    moveStatus = 'EARLY';

    moveType = earlyReversal
      ? 'BULLISH_REVERSAL'
      : 'EARLY_DEMAND';

    moveTypeLabel = earlyReversal
      ? 'برگشت اولیه صعودی'
      : 'تقاضای اولیه در حال شکل‌گیری';

    moveAgeBars = breakoutFresh;
  } else if (
    compressionReady &&
    trendScore >= 52 &&
    !bearishFlow
  ) {
    moveStatus = 'WATCHING';
    moveType = 'PRE_MOVE_SETUP';
    moveTypeLabel = 'آماده‌سازی پیش از حرکت';
  }

  const entryScore = clamp(
    trendScore * 0.38 +
    (impulseQuality ? 12 : 0) +
    (flowStrong ? 12 : flowPositive ? 6 : 0) +
    (bullish15Count >= 2 ? 8 : 0) +
    (bullish1hCount >= 2 ? 7 : 0) +
    (breakoutFresh !== null ? 10 : 0) +
    (breakout1hFresh !== null ? 7 : 0) +
    (room4h.score * 0.08) +
    (noHeavyOverhead ? 5 : -8) -
    (overheated ? 18 : 0) -
    (bearishFlow ? 18 : 0) -
    (oiDanger ? 10 : 0),
    0,
    100
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
  if (oiHealthy && flow.oiChangePct != null) {
    evidence.push('افزایش OI بدون افت قیمت');
  }
  if (compressionReady) evidence.push('تراکم/آماده‌سازی پیش از حرکت');
  if (breakoutFresh !== null) evidence.push('شکست تازه در 15M');
  if (breakout1hFresh !== null) evidence.push('شکست تازه در 1H');

  if (bearishFlow) warnings.push('فشار فروش در جریان معاملات');

  if (oiDanger) {
    warnings.push(
      'افزایش OI همراه با افت قیمت؛ احتمال ورود پوزیشن‌های فروش'
    );
  }

  if (overheated) {
    warnings.push(
      'حرکت کوتاه‌مدت بیش از حد کشیده شده؛ ورود دیرهنگام پرریسک است'
    );
  }

  if (!resistanceRoom) {
    warnings.push('مقاومت نزدیک در مسیر قیمت');
  }

  if (flow.dataQuality === 'LOW') {
    warnings.push(
      'داده مشتقات ناکافی؛ این بخش با امتیاز خنثی محاسبه شد'
    );
  }

  // امتیاز ساختار مستقل از هیجان کندل‌های کوتاه‌مدت
  const structuralScore = Math.round(clamp(
    daily.score * 0.15 +
    (trend4h ? 90 : 40) * 0.35 +
    (trend1h ? 90 : 40) * 0.30 +
    (trend15m ? 85 : 40) * 0.20,
    0,
    100
  ));

  // پتانسیل رشد میان‌مدت؛ وزن تایم‌فریم‌های بزرگ‌تر بیشتر است
  const potentialScore = Math.round(clamp(
    daily.score * 0.30 +
    (trend4h ? 90 : 35) * 0.35 +
    (trend1h ? 85 : 35) * 0.15 +
    room4h.score * 0.12 +
    compression4h.score * 0.08,
    0,
    100
  ));

  // انرژی حرکت؛ حجم، جریان خریداران و OI
  const volumeEnergy = clamp(
    35 +
    Math.max(0, volume15 - 1) * 22 +
    Math.max(0, volume1h - 1) * 18,
    0,
    100
  );

  const energyScore = Math.round(clamp(
    volumeEnergy * 0.35 +
    flow.flowScore * 0.35 +
    flow.oiScore * 0.15 +
    (impulseQuality ? 15 : 0),
    0,
    100
  ));

  const entryQualityScore = Math.round(clamp(
    moveScore * 0.55 +
    room4h.score * 0.25 +
    (noHeavyOverhead ? 15 : 0) -
    (overheated ? 25 : 0) -
    (bearishFlow ? 20 : 0),
    0,
    100
  ));

  return {
    symbol,

    score: growthScore,
    growthScore,
    moveScore,

    structuralScore,
    potentialScore,
    energyScore,
    entryQualityScore,

    growthStatus:
      trendScore >= 75
        ? 'HIGH_POTENTIAL'
        : trendScore >= 60
          ? 'WATCHLIST'
          : 'NORMAL',

    moveStatus,
    moveType,
    moveTypeLabel,
    moveAgeBars,

    moveAgeMinutes:
      moveAgeBars == null
        ? null
        : moveAgeBars * 15,

    stage:
      moveStatus === 'CONFIRMED'
        ? 'موج صعودی تازه با شواهد ادامه‌دار'
        : moveStatus === 'EARLY'
          ? 'نشانه‌های اولیه شروع موج'
          : moveStatus === 'WATCHING'
            ? 'در حال آماده‌سازی'
            : 'شرایط کافی برای شروع موج وجود ندارد',

    price,
    livePrice: price,

    returns: {
      '15m': tf15.returns.return1,
      '1h': tf1h.returns.return1,
      '4h': tf4h.returns.return1,
      '1d': daily.dailyReturn,
    },

    volume: {
      '15m': volume15,
      '1h': volume1h,
      '1d': daily.volumeRatio5,
    },

    daily,
    derivatives: flow,

    structure: {
      daily: daily.score,
      '4h': Math.round(trend4h ? 85 : 45),
      '1h': Math.round(trend1h ? 85 : 45),
      '15m': Math.round(trend15m ? 85 : 45),

      compression4h: compression4h.score,
      compression1h: compression1h.score,

      roomToResistance4hPct: room4h.roomPct,
      roomToResistance1dPct: room1d.roomPct,

      higherHigh4h: structure4h.higherHigh,
      higherLow4h: structure4h.higherLow,
      higherHigh1h: structure1h.higherHigh,
      higherLow1h: structure1h.higherLow,
    },

    flags: {
      structuralDamage,
      overheated,
      bearishFlow,
      oiDanger,
      trend4h,
      trend1h,
      trend15m,
      flowPositive,
      flowStrong,
      impulseQuality,
    },

    evidence,
    warnings,

    _analysis: {
      tf15: {
        ema21: tf15.ema21,
        emaBullish: tf15.emaBullish,
        structure: tf15.structure,
      },

      tf1h: {
        emaBullish: tf1h.emaBullish,
        structure: tf1h.structure,
      },

      tf4h: {
        emaBullish: tf4h.emaBullish,
        emaSlope: tf4h.emaSlope,
        structure: tf4h.structure,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* HISTORY: EACH COIN COMPARED WITH ITS OWN PAST                              */
/* -------------------------------------------------------------------------- */

function calculateRelativeSelfStrength(coin, previousSnapshots) {
  if (!previousSnapshots.length) {
    return {
      score: 50,
      improvement: 0,
      retention: 1,
      consistency: 0.5,
      historyCount: 0,
      label: 'سابقه در حال تشکیل',
    };
  }

  const baseline = previousSnapshots.slice(
    -CONFIG.HISTORY_BASELINE_SNAPSHOTS
  );

  const averageStructure = average(
    baseline.map((item) => number(item.structuralScore))
  );

  const averageEnergy = average(
    baseline.map((item) => number(item.energyScore))
  );

  const averagePotential = average(
    baseline.map((item) => number(item.potentialScore))
  );

  const bestStructure = Math.max(
    ...previousSnapshots.map((item) =>
      number(item.structuralScore)
    )
  );

  const improvement =
    coin.structuralScore - averageStructure;

  const energyImprovement =
    coin.energyScore - averageEnergy;

  const potentialImprovement =
    coin.potentialScore - averagePotential;

  const retention = bestStructure > 0
    ? coin.structuralScore / bestStructure
    : 1;

  const consistency = baseline.length
    ? baseline.filter((item) =>
        number(item.structuralScore) >= 55
      ).length / baseline.length
    : 0.5;

  const score = clamp(
    50 +
    clamp(improvement * 0.65, -18, 18) +
    clamp(energyImprovement * 0.20, -8, 8) +
    clamp(potentialImprovement * 0.15, -6, 6) +
    clamp((retention - 0.75) * 24, -12, 6) +
    clamp((consistency - 0.5) * 12, -6, 6),
    0,
    100
  );

  let label = 'قدرت نسبتاً پایدار';

  if (score >= 68 && improvement > 3) {
    label = 'تقویت نسبت به گذشته';
  } else if (score <= 38 && improvement < -5) {
    label = 'فرسایش قدرت نسبت به گذشته';
  } else if (retention < 0.75) {
    label = 'فاصله از بهترین ساختار قبلی';
  }

  return {
    score: Math.round(score),
    improvement: Number(improvement.toFixed(2)),
    energyImprovement: Number(energyImprovement.toFixed(2)),
    potentialImprovement: Number(potentialImprovement.toFixed(2)),
    retention: Number(retention.toFixed(3)),
    consistency: Number(consistency.toFixed(3)),
    historyCount: previousSnapshots.length,
    label,
  };
}

function updateCoinHistory(memory, candidates, analyzedSymbols, nowMs) {
  const history = { ...memory.coinHistory };

  const retentionMs =
    CONFIG.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const minimumIntervalMs =
    CONFIG.HISTORY_MIN_INTERVAL_MINUTES * 60 * 1000;

  for (const symbol of analyzedSymbols) {
    const coin = candidates.find(
      (item) => item.symbol === symbol
    );

    if (!coin) continue;

    const oldSnapshots = Array.isArray(history[symbol])
      ? history[symbol]
      : [];

    const validSnapshots = oldSnapshots.filter((item) => {
      const timestamp = Date.parse(item.time || '');

      return timestamp > 0 &&
        nowMs - timestamp <= retentionMs;
    });

    // مقایسه فقط با سابقه قبلی؛ snapshot فعلی هنوز وارد محاسبه نشده است.
    const relative = calculateRelativeSelfStrength(
      coin,
      validSnapshots
    );

    coin.relativeSelf = relative;

    const lastSnapshot = validSnapshots.at(-1);
    const lastTime = Date.parse(lastSnapshot?.time || '');

    const shouldSave =
      !lastTime ||
      nowMs - lastTime >= minimumIntervalMs;

    if (shouldSave) {
      validSnapshots.push({
        time: new Date(nowMs).toISOString(),
        structuralScore: coin.structuralScore,
        potentialScore: coin.potentialScore,
        energyScore: coin.energyScore,
        growthScore: coin.growthScore,
        moveScore: coin.moveScore,
        moveStatus: coin.moveStatus,
      });
    }

    history[symbol] = validSnapshots.slice(
      -CONFIG.HISTORY_MAX_SNAPSHOTS
    );
  }

  // پاک‌سازی سابقه ارزهایی که مدت زیادی داده‌ای از آن‌ها نرسیده است.
  for (const [symbol, snapshots] of Object.entries(history)) {
    const valid = (Array.isArray(snapshots) ? snapshots : [])
      .filter((item) => {
        const timestamp = Date.parse(item.time || '');

        return timestamp > 0 &&
          nowMs - timestamp <= retentionMs;
      });

    if (valid.length) {
      history[symbol] = valid.slice(
        -CONFIG.HISTORY_MAX_SNAPSHOTS
      );
    } else {
      delete history[symbol];
    }
  }

  return {
    ...memory,
    coinHistory: history,
  };
}

/* -------------------------------------------------------------------------- */
/* TRADE SETUP                                                                */
/* -------------------------------------------------------------------------- */

function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;

  const ranges = [];

  for (
    let i = candles.length - period;
    i < candles.length;
    i++
  ) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose)
      )
    );
  }

  return average(ranges);
}

function classifyOpportunity(coin) {
  if (coin.growthScore >= 75) return 'SWING';
  if (coin.growthScore >= 58) return 'SHORT-TERM';

  return 'SCALP';
}

function buildTradeSetup(coin, candles15m, candles5m = []) {
  const price = number(coin.livePrice, coin.price);
  const atr = calculateATR(candles15m, 14);
  const safeCandles5m = Array.isArray(candles5m) ? candles5m : [];

  if (!price || !atr || !Array.isArray(candles15m) || candles15m.length < 25) {
    return null;
  }

  const ema21 = number(coin._analysis?.tf15?.ema21);

  const swingPoints = findSwingPoints(
    candles15m.slice(-60),
    2
  );

  const validSupports = [
    ema21,
    ...swingPoints.lows,
  ]
    .filter((level) =>
      level > 0 &&
      level < price &&
      price - level <= atr * 3.5
    )
    .sort((a, b) => b - a);

  const support =
    validSupports[0] ||
    Math.max(0, price - atr * 1.25);

  const entryLow = support - atr * 0.25;
  const entryHigh = support + atr * 0.18;

  const structuralLow = swingPoints.lows
    .filter((level) => level < entryLow)
    .sort((a, b) => b - a)[0];

  const stopLoss = Math.min(
    entryLow - atr * 0.35,
    (structuralLow || entryLow) - atr * 0.25
  );

  const risk = Math.max(
    entryHigh - stopLoss,
    atr * 0.5
  );

  const resistanceLevels = swingPoints.highs
    .filter((level) => level > entryHigh)
    .sort((a, b) => a - b);

  const target = (multiple, index) =>
    resistanceLevels[index] &&
    resistanceLevels[index] > entryHigh + risk * 0.8
      ? Math.max(
          resistanceLevels[index],
          entryHigh + risk * multiple
        )
      : entryHigh + risk * multiple;

  const tp1 = target(1.5, 0);
  const tp2 = target(2.5, 1);
  const tp3 = target(4, 2);

  const last5m = safeCandles5m.at(-1);
  const previous5m = safeCandles5m.at(-2);

  const strength5m = last5m
    ? getCandleStrength(last5m)
    : null;

  const bouncedFromZone = Boolean(
    last5m &&
    last5m.low <= entryHigh &&
    last5m.close > entryHigh &&
    last5m.close > last5m.open &&
    strength5m.closeLocation >= 0.65 &&
    previous5m &&
    last5m.close > previous5m.high
  );

  return {
    entryLow,
    entryHigh,
    entryMid: (entryLow + entryHigh) / 2,

    confirmation:
      'کندل بسته‌شده ۵ دقیقه‌ای باید محدوده ورود را لمس کند، صعودی بسته شود و سقف کندل قبلی را بشکند.',

    confirmationMet: bouncedFromZone,

    stopLoss,
    tp1,
    tp2,
    tp3,

    riskReward: Number(
      ((tp1 - entryHigh) / risk).toFixed(2)
    ),

    atr,
    support,
  };
}

function isSameSetup(previous, setup, opportunityType) {
  if (
    !previous?.setup ||
    !setup ||
    previous.opportunityType !== opportunityType
  ) {
    return false;
  }

  const oldMid = number(previous.setup.entryMid);
  const newMid = number(setup.entryMid);

  if (!oldMid || !newMid) return false;

  return Math.abs(newMid - oldMid) / oldMid <= 0.012;
}

function detectSeriousDecline(candles5m, candles15m, flow) {
  if (
    !Array.isArray(candles5m) ||
    candles5m.length < 25 ||
    !Array.isArray(candles15m) ||
    candles15m.length < 25
  ) {
    return {
      confirmed: false,
      reason: null,
      severity: 'UNKNOWN',
    };
  }

  const closes5 = candles5m.map((c) => c.close);

  const ema9_5 = calculateEMA(closes5, 9);
  const ema21_5 = calculateEMA(closes5, 21);

  const last5 = candles5m.at(-1);
  const prev5 = candles5m.at(-2);
  const last15 = candles15m.at(-1);

  const ema9_15 = calculateEMA(
    candles15m.map((c) => c.close),
    9
  );

  const strength5 = getCandleStrength(last5);
  const volume5 = getVolumeRatio(candles5m);

  const breakdown5 =
    last5.close < ema9_5.at(-1) &&
    ema9_5.at(-1) < ema21_5.at(-1) &&
    last5.close < prev5.low &&
    strength5.closeLocation <= 0.35;

  const strongSellCandle =
    last5.close < last5.open &&
    strength5.closeLocation <= 0.18 &&
    volume5 >= 1.65;

  const confirm15 =
    last15.close < ema9_15.at(-1) &&
    last15.close < last15.open;

  const sellersControl =
    number(flow?.imbalance) < -0.12 ||
    number(flow?.buyRatio, 0.5) < 0.43;

  const hardBreakdown =
    breakdown5 &&
    (confirm15 || sellersControl);

  const panicSell =
    strongSellCandle &&
    (sellersControl || confirm15);

  return {
    confirmed: hardBreakdown || panicSell,

    reason: hardBreakdown
      ? 'شکست ساختار کوتاه‌مدت همراه با تأیید فروش'
      : panicSell
        ? 'کندل فروش قدرتمند با حجم بالا و تأیید فشار فروش'
        : null,

    severity:
      hardBreakdown || panicSell
        ? 'SERIOUS'
        : breakdown5 || strongSellCandle
          ? 'WARNING'
          : 'NORMAL',
  };
}

function updateTradeState(
  coin,
  setup,
  previousState,
  nowMs,
  candles5m = [],
  candles15m = []
) {
  const opportunityType = coin.opportunityType;

  const sameSetup = isSameSetup(
    previousState,
    setup,
    opportunityType
  );

  const previous = sameSetup
    ? previousState
    : null;

  const price = number(coin.livePrice, coin.price);
  const now = new Date(nowMs).toISOString();

  const labels = {
    ENTRY_CONFIRMED: 'ورود تأیید شده',
    NEAR_ENTRY: 'نزدیک ورود',
    WAITING: 'در انتظار',
    NEAR_EXIT: 'نزدیک خروج',
    EXIT_CONFIRMED: 'خروج قطعی',
    INVALIDATED: 'ابطال موقعیت',
    EXPIRED: 'منقضی شده',
  };

  if (!setup) {
    return {
      symbol: coin.symbol,
      opportunityType,
      status: 'WAITING',
      statusLabel: labels.WAITING,
      setup: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const terminal = new Set([
    'EXIT_CONFIRMED',
    'INVALIDATED',
    'EXPIRED',
  ]);

  const maxAgeHours = {
    SWING: 240,
    'SHORT-TERM': 72,
    SCALP: 24,
  }[opportunityType] || 72;

  const createdAt = previous?.createdAt || now;

  const ageHours =
    (nowMs - Date.parse(createdAt)) / 3600000;

  const oldStatus = previous?.status;

  let status = previous?.status || 'WAITING';
  let enteredAt = previous?.enteredAt || null;

  let entryPrice =
    number(previous?.entryPrice, 0) || null;

  let exitReason = previous?.exitReason || null;

  const decline = detectSeriousDecline(
    candles5m,
    candles15m,
    coin.derivatives
  );

  if (previous && terminal.has(oldStatus)) {
    status = oldStatus;
  } else if (ageHours > maxAgeHours) {
    status = 'EXPIRED';
    exitReason = 'عمر setup از محدوده مجاز گذشت';
  } else if (
    price <= setup.stopLoss &&
    (
      oldStatus === 'ENTRY_CONFIRMED' ||
      oldStatus === 'NEAR_EXIT'
    )
  ) {
    status = 'EXIT_CONFIRMED';
    exitReason = 'حد ضرر معامله فعال لمس شد';
  } else if (
    (
      oldStatus === 'ENTRY_CONFIRMED' ||
      oldStatus === 'NEAR_EXIT'
    ) &&
    decline.confirmed
  ) {
    status = 'EXIT_CONFIRMED';
    exitReason = decline.reason;
  } else if (price <= setup.stopLoss) {
    status = 'INVALIDATED';
    exitReason = 'شکست حد ضرر ساختاری پیش از ورود';
  } else if (
    oldStatus === 'ENTRY_CONFIRMED' ||
    oldStatus === 'NEAR_EXIT'
  ) {
    const nearTarget = price >= setup.tp1 * 0.985;

    const nearStop =
      price <= setup.stopLoss + setup.atr * 0.25;

    if (price >= setup.tp1) {
      status = 'EXIT_CONFIRMED';
      exitReason = 'هدف اول لمس شد';
    } else if (nearTarget || nearStop) {
      status = 'NEAR_EXIT';

      exitReason = nearTarget
        ? 'قیمت به هدف اول نزدیک شده'
        : 'قیمت به حد ضرر نزدیک شده';
    } else {
      status = 'ENTRY_CONFIRMED';
      exitReason = null;
    }
  } else if (
    setup.confirmationMet &&
    price > setup.entryHigh
  ) {
    status = 'ENTRY_CONFIRMED';
    enteredAt = now;
    entryPrice = price;
  } else if (
    price >= setup.entryLow - setup.atr * 1.25 &&
    price <= setup.entryHigh + setup.atr * 1.25
  ) {
    status = 'NEAR_ENTRY';
  } else {
    status = 'WAITING';
  }

  return {
    symbol: coin.symbol,
    opportunityType,
    status,
    statusLabel: labels[status] || status,
    setup,
    createdAt,
    updatedAt: now,
    enteredAt,
    entryPrice,
    exitReason,
    ageHours: Number(Math.max(0, ageHours).toFixed(1)),
  };
}

/* -------------------------------------------------------------------------- */
/* ACTIVE CANDIDATES AND UNIFIED PRIORITY                                     */
/* -------------------------------------------------------------------------- */

function isActiveCandidate(coin) {
  if (!coin) return false;

  if (
    coin.moveStatus !== 'CONFIRMED' &&
    coin.moveStatus !== 'EARLY'
  ) {
    return false;
  }

  if (number(coin.moveScore) < 65) return false;
  if (number(coin.growthScore) < 58) return false;
  if (number(coin.structuralScore) < 58) return false;
  if (number(coin.potentialScore) < 60) return false;
  if (number(coin.energyScore) < 52) return false;
  if (number(coin.entryQualityScore) < 55) return false;

  const flags = coin.flags || {};

  if (
    flags.structuralDamage ||
    flags.bearishFlow ||
    flags.overheated ||
    flags.oiDanger
  ) {
    return false;
  }

  if (
    coin.moveAgeMinutes != null &&
    number(coin.moveAgeMinutes, Infinity) > CONFIG.MAX_ACTIVE_AGE_MINUTES
  ) {
    return false;
  }

  const historyCount = number(coin.relativeSelf?.historyCount);
  const relativeScore = number(coin.relativeSelf?.score, 50);

  // امتیاز خنثیِ سابقه ناکافی نباید باعث حذف ارز تازه‌وارد شود.
  if (historyCount >= 6 && relativeScore < 35) return false;

  return true;
}

function calculateActivePriority(coin) {
  const age = coin.moveAgeMinutes;

  const freshness = age == null
    ? 65
    : clamp(
        100 -
        (age / CONFIG.MAX_ACTIVE_AGE_MINUTES) * 100,
        0,
        100
      );

  const relativeScore =
    number(coin.relativeSelf?.score, 50);

  return Number((
    number(coin.potentialScore) * 0.28 +
    number(coin.structuralScore) * 0.24 +
    relativeScore * 0.18 +
    number(coin.energyScore) * 0.14 +
    number(coin.entryQualityScore) * 0.11 +
    freshness * 0.05
  ).toFixed(2));
}

function calculateStructuralAdvantage(coin) {
  return (
    number(coin.structuralScore) * 0.45 +
    number(coin.potentialScore) * 0.40 +
    number(coin.relativeSelf?.score, 50) * 0.15
  );
}

function stableSortByPriority(coins, previousActiveList) {
  const sorted = [...coins].sort((a, b) =>
    b.activePriority - a.activePriority
  );

  const previousRank = new Map(
    Object.entries(previousActiveList || {})
      .map(([symbol, item]) => [
        symbol,
        number(item.rank, 999),
      ])
  );

  // مرتب‌سازی پایدار: اختلاف‌های کوچک باعث جابه‌جایی رتبه نمی‌شوند.
  for (let i = 1; i < sorted.length; i++) {
    let j = i;

    while (j > 0) {
      const current = sorted[j];
      const previous = sorted[j - 1];

      const difference =
        previous.activePriority - current.activePriority;

      if (
        difference <= CONFIG.RANK_STABILITY_MARGIN
      ) {
        const currentOldRank =
          previousRank.get(current.symbol) ?? 999;

        const previousOldRank =
          previousRank.get(previous.symbol) ?? 999;

        if (currentOldRank < previousOldRank) {
          [sorted[j - 1], sorted[j]] =
            [sorted[j], sorted[j - 1]];

          j--;
          continue;
        }
      }

      break;
    }
  }

  return sorted;
}

function assignStableRanks(candidates, previousMemory, nowMs) {
  const previousActiveList = previousMemory.activeList || {};

  // همه واجدین شرایط در هر اسکن دوباره رتبه‌بندی می‌شوند؛
  // سابقه فقط در اختلاف‌های کوچکِ رتبه اثر دارد، نه در انتخاب اجباری اعضا.
  const eligible = candidates
    .filter(isActiveCandidate)
    .map((coin) => {
      coin.activePriority = calculateActivePriority(coin);
      coin.structuralPriority = calculateStructuralAdvantage(coin);
      return coin;
    });

  const rankedAll = stableSortByPriority(
    eligible,
    previousActiveList
  );

  const ranked = rankedAll.slice(0, CONFIG.TOP_COUNT);

  ranked.forEach((coin, index) => {
    coin.activeRank = index + 1;
  });

  // activeList فقط اعضای واجد شرایط همین اسکن را نگه می‌دارد؛
  // هیچ عضو قدیمی یا تحلیل‌نشده‌ای وارد فهرست فعال نمی‌شود.
  const activeList = {};
  const now = new Date(nowMs).toISOString();

  for (const coin of ranked) {
    const previous = previousActiveList[coin.symbol];

    activeList[coin.symbol] = {
      symbol: coin.symbol,
      rank: coin.activeRank,
      activePriority: coin.activePriority,
      structuralPriority: coin.structuralPriority,
      structuralScore: coin.structuralScore,
      potentialScore: coin.potentialScore,
      relativeSelfScore: coin.relativeSelf?.score ?? 50,
      firstSeen: previous?.firstSeen || now,
      lastSeen: now,
      moveStatus: coin.moveStatus,
      snapshot: {
        growthScore: coin.growthScore,
        moveScore: coin.moveScore,
        energyScore: coin.energyScore,
        entryQualityScore: coin.entryQualityScore,
      },
    };
  }

  return {
    activeRanked: ranked,
    activeList,
  };
}

/* -------------------------------------------------------------------------- */
/* WATCHLIST AND MEMORY UPDATE                                                */
/* -------------------------------------------------------------------------- */

function isWatchCandidate(coin) {
  if (!coin) return false;

  if (
    coin.moveStatus !== 'WATCHING' &&
    coin.moveStatus !== 'POTENTIAL'
  ) {
    return false;
  }

  if (number(coin.growthScore) < 52) return false;

  const flags = coin.flags || {};

  if (
    flags.structuralDamage ||
    flags.bearishFlow ||
    flags.overheated ||
    flags.oiDanger
  ) {
    return false;
  }

  return true;
}

function updateScannerMemory(
  memory,
  candidates,
  activeList,
  analyzedSymbols,
  nowMs
) {
  const now = new Date(nowMs).toISOString();

  const activeSymbols = new Set(
    Object.keys(activeList)
  );

  const candidateMap = new Map(
    candidates.map((coin) => [coin.symbol, coin])
  );

  const analyzedSet = new Set(analyzedSymbols);

  const watchlist = { ...memory.watchlist };
  const tradeStates = { ...memory.tradeStates };

  const watchRetentionMs =
    CONFIG.WATCHLIST_RETENTION_DAYS * 86400000;

  const tradeRetentionMs =
    CONFIG.TRADE_STATE_RETENTION_DAYS * 86400000;

  for (const [symbol, item] of Object.entries(watchlist)) {
    if (activeSymbols.has(symbol)) {
      delete watchlist[symbol];
      continue;
    }

    const coin = candidateMap.get(symbol);

    if (analyzedSet.has(symbol)) {
      if (coin && isWatchCandidate(coin)) {
        watchlist[symbol] = {
          ...item,
          symbol,
          lastSeen: now,
          growthScore: coin.growthScore,
          moveScore: coin.moveScore,
          structuralScore: coin.structuralScore,
          potentialScore: coin.potentialScore,
          energyScore: coin.energyScore,
          moveStatus: coin.moveStatus,
          reason: coin.moveTypeLabel,
        };
      } else {
        delete watchlist[symbol];
      }

      continue;
    }

    const lastSeen = Date.parse(
      item.lastSeen || item.firstSeen || ''
    );

    if (!lastSeen || nowMs - lastSeen > watchRetentionMs) {
      delete watchlist[symbol];
    }
  }

  for (const coin of candidates) {
    if (activeSymbols.has(coin.symbol)) continue;
    if (!isWatchCandidate(coin)) continue;

    const previous = watchlist[coin.symbol];

    watchlist[coin.symbol] = {
      symbol: coin.symbol,
      firstSeen: previous?.firstSeen || now,
      lastSeen: now,
      growthScore: coin.growthScore,
      moveScore: coin.moveScore,
      structuralScore: coin.structuralScore,
      potentialScore: coin.potentialScore,
      energyScore: coin.energyScore,
      moveStatus: coin.moveStatus,
      reason: coin.moveTypeLabel,
    };
  }

  for (const coin of candidates) {
    if (coin.tradeState) {
      tradeStates[coin.symbol] = coin.tradeState;
    }
  }

  for (const [symbol, state] of Object.entries(tradeStates)) {
    const referenceTime = Date.parse(
      state.createdAt || state.updatedAt || ''
    );

    if (
      !referenceTime ||
      nowMs - referenceTime > tradeRetentionMs
    ) {
      delete tradeStates[symbol];
    }
  }

  return {
    version: 3,
    updatedAt: now,
    watchlist,
    tradeStates,
    activeList,
    coinHistory: memory.coinHistory || {},
  };
}

/* -------------------------------------------------------------------------- */
/* TELEGRAM                                                                   */
/* -------------------------------------------------------------------------- */

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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );

  const raw = await response.text();

  let result;

  try {
    result = raw ? JSON.parse(raw) : null;
  } catch {
    result = null;
  }

  if (!response.ok || !result?.ok) {
    const error = new Error(
      result?.description ||
      `Telegram HTTP ${response.status}: ${raw.slice(0, 160) || 'empty response'}`
    );

    error.retryAfter = result?.parameters?.retry_after;

    throw error;
  }
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text
    .split('\n\n')
    .filter(Boolean);

  const messages = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current
      ? `${current}\n\n${block}`
      : block;

    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      messages.push(current);
      current = '';
    }

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    for (const line of block.split('\n')) {
      const next = current
        ? `${current}\n${line}`
        : line;

      if (next.length > maxLength && current) {
        messages.push(current);
        current = line;
      } else {
        current = next;
      }
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
      `📄 گزارش ${i + 1}/${messages.length}\n\n${messages[i]}`;

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

/* -------------------------------------------------------------------------- */
/* UNIFIED REPORT                                                             */
/* -------------------------------------------------------------------------- */

function buildReport(candidates, stats, duration, activeRanked) {
  const blocks = [
    [
      '🚀 GATE.IO | RELATIVE STRENGTH BULLISH RADAR',
      '━━━━━━━━━━━━━━━━━━',
      '🏆 بهترین فرصت‌های صعود؛ رتبه‌بندی یکپارچه',
      `📌 بازارهای بررسی‌شده: ${candidates.length}`,
      `📊 قرارداد فعال: ${stats.active} | نقدشونده: ${stats.liquid}`,
      `🔍 بررسی موفق: ${stats.success} | خطا: ${stats.errors}`,
      `⚡ فهرست فعال: ${activeRanked.length} از ${CONFIG.TOP_COUNT}`,
      `⏱ زمان اسکن: ${(duration / 1000).toFixed(1)} ثانیه`,
      '📄 جزئیات کامل در فایل market-report.html',
      '━━━━━━━━━━━━━━━━━━',
    ].join('\n'),
  ];

  if (!activeRanked.length) {
    blocks.push(
      'در این اسکن هیچ ارز واجد شرایط فهرست فعال نشد.'
    );
  }

  for (const coin of activeRanked) {
    const setup = coin.tradeSetup;
    const relative = coin.relativeSelf || {};

    const entry = setup
      ? `\n🎯 محدوده ورود: ${formatPrice(setup.entryLow)} تا ${formatPrice(setup.entryHigh)}`
      : '';

    blocks.push([
      `${coin.activeRank}. ${coin.symbol} | ${coin.moveStatus}`,
      `🏆 اولویت: ${coin.activePriority}/100`,
      `🧱 ساختار: ${coin.structuralScore} | پتانسیل: ${coin.potentialScore}`,
      `⚡ انرژی: ${coin.energyScore} | ورود: ${coin.entryQualityScore}`,
      `📈 نسبت به گذشته خودش: ${relative.score ?? 50}/100 (${relative.label || 'سابقه در حال تشکیل'})`,
      `💰 قیمت: ${formatPrice(coin.livePrice)}`,
      `📊 روند: ${coin.growthScore} | آمادگی حرکت: ${coin.moveScore}`,
      `🔎 ${coin.moveTypeLabel}`,
      `🧾 وضعیت معامله: ${coin.tradeStatusLabel || 'نامشخص'}${entry}`,
    ].join('\n'));
  }

  blocks.push(
    '━━━━━━━━━━━━━━━━━━\nℹ️ رتبه‌بندی بر اساس قدرت ساختار، پتانسیل رشد، مقایسه با سابقه همان ارز، انرژی و کیفیت ورود است؛ تضمین رشد یا توصیه قطعی ورود نیست.'
  );

  return blocks.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* HTML REPORT                                                                */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '-')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function displayNumber(value, digits = 2, suffix = '') {
  if (value == null || !Number.isFinite(Number(value))) {
    return 'نامشخص';
  }

  return `${Number(value).toFixed(digits)}${suffix}`;
}

function htmlRow(label, value) {
  return `
    <div class="detail-row">
      <span class="detail-label">${escapeHtml(label)}</span>
      <span class="detail-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function htmlList(items, emptyText = 'موردی ثبت نشده است') {
  if (!Array.isArray(items) || !items.length) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${items.map((item) =>
    `<li>${escapeHtml(item)}</li>`
  ).join('')}</ul>`;
}

function buildCoinHtml(coin) {
  const d = coin.derivatives || {};
  const s = coin.structure || {};
  const daily = coin.daily || {};
  const setup = coin.tradeSetup || {};
  const state = coin.tradeState || {};
  const relative = coin.relativeSelf || {};
  const returns = coin.returns || {};
  const volume = coin.volume || {};

  const rows = [
    htmlRow('رتبه واحد', coin.activeRank),
    htmlRow('اولویت نهایی', displayNumber(coin.activePriority)),
    htmlRow('امتیاز ساختاری', coin.structuralScore),
    htmlRow('پتانسیل رشد', coin.potentialScore),
    htmlRow('انرژی حرکت', coin.energyScore),
    htmlRow('کیفیت ورود', coin.entryQualityScore),
    htmlRow('امتیاز روند', coin.growthScore),
    htmlRow('امتیاز آمادگی حرکت', coin.moveScore),
    htmlRow('وضعیت حرکت', coin.moveStatus),
    htmlRow('نوع حرکت', coin.moveTypeLabel),
    htmlRow('سن حرکت به دقیقه', coin.moveAgeMinutes ?? 'نامشخص'),
    htmlRow('قدرت نسبت به گذشته خودش', relative.score ?? 50),
    htmlRow('تغییر ساختار نسبت به میانگین گذشته', displayNumber(relative.improvement)),
    htmlRow('حفظ قدرت نسبت به بهترین ساختار', displayNumber(relative.retention, 3)),
    htmlRow('ثبات ساختار در سابقه', displayNumber(relative.consistency, 3)),
    htmlRow('تعداد نمونه‌های تاریخی', relative.historyCount ?? 0),
    htmlRow('تفسیر مقایسه تاریخی', relative.label || 'سابقه در حال تشکیل'),

    htmlRow('بازده ۱۵ دقیقه', displayNumber(returns['15m'], 2, '%')),
    htmlRow('بازده ۱ ساعت', displayNumber(returns['1h'], 2, '%')),
    htmlRow('بازده ۴ ساعت', displayNumber(returns['4h'], 2, '%')),
    htmlRow('بازده روزانه', displayNumber(returns['1d'], 2, '%')),

    htmlRow('نسبت حجم ۱۵ دقیقه', displayNumber(volume['15m'], 2, 'x')),
    htmlRow('نسبت حجم ۱ ساعت', displayNumber(volume['1h'], 2, 'x')),
    htmlRow('نسبت حجم روزانه', displayNumber(volume['1d'], 2, 'x')),

    htmlRow('ساختار روزانه', daily.score),
    htmlRow('ساختار ۴ ساعته', s['4h']),
    htmlRow('ساختار ۱ ساعته', s['1h']),
    htmlRow('ساختار ۱۵ دقیقه', s['15m']),
    htmlRow('فشردگی ۴ ساعته', s.compression4h),
    htmlRow('فشردگی ۱ ساعته', s.compression1h),
    htmlRow('فضای مقاومت ۴ ساعته', displayNumber(s.roomToResistance4hPct, 2, '%')),
    htmlRow('فضای مقاومت روزانه', displayNumber(s.roomToResistance1dPct, 2, '%')),

    htmlRow('نسبت خرید', displayNumber(number(d.buyRatio) * 100, 2, '%')),
    htmlRow('عدم تعادل جریان معاملات', displayNumber(number(d.imbalance) * 100, 2, '%')),
    htmlRow('امتیاز جریان معاملات', d.flowScore),
    htmlRow('تغییر OI', displayNumber(d.oiChangePct, 2, '%')),
    htmlRow('تغییر قیمت مارک', displayNumber(d.markChangePct, 2, '%')),
    htmlRow('امتیاز OI', d.oiScore),
    htmlRow('کیفیت داده مشتقات', d.dataQuality),
    htmlRow('تعداد معاملات بررسی‌شده', d.tradeCount),

    htmlRow('EMA روزانه صعودی', daily.emaBullish ? 'بله' : 'خیر'),
    htmlRow('قیمت بالای EMA50', daily.ema50Bullish ? 'بله' : 'خیر'),
    htmlRow('Higher High روزانه', daily.higherHigh ? 'بله' : 'خیر'),
    htmlRow('Higher Low روزانه', daily.higherLow ? 'بله' : 'خیر'),

    htmlRow('وضعیت معامله', coin.tradeStatusLabel || coin.tradeStatus),
    htmlRow('محدوده ورود پایین', setup.entryLow ? formatPrice(setup.entryLow) : 'محاسبه نشده'),
    htmlRow('محدوده ورود بالا', setup.entryHigh ? formatPrice(setup.entryHigh) : 'محاسبه نشده'),
    htmlRow('تأیید ۵ دقیقه', setup.confirmationMet ? 'تأیید شده' : 'تأیید نشده'),
    htmlRow('حد ضرر', setup.stopLoss ? formatPrice(setup.stopLoss) : 'نامشخص'),
    htmlRow('هدف اول', setup.tp1 ? formatPrice(setup.tp1) : 'نامشخص'),
    htmlRow('هدف دوم', setup.tp2 ? formatPrice(setup.tp2) : 'نامشخص'),
    htmlRow('هدف سوم', setup.tp3 ? formatPrice(setup.tp3) : 'نامشخص'),
    htmlRow('نسبت ریسک به بازده', displayNumber(setup.riskReward, 2, 'R')),
    htmlRow('دلیل خروج', state.exitReason || 'ندارد'),

    htmlRow('آسیب ساختاری', coin.flags?.structuralDamage ? 'بله' : 'خیر'),
    htmlRow('بیش‌ازحد کشیده', coin.flags?.overheated ? 'بله' : 'خیر'),
    htmlRow('فشار فروش', coin.flags?.bearishFlow ? 'بله' : 'خیر'),
    htmlRow('خطر OI', coin.flags?.oiDanger ? 'بله' : 'خیر'),
  ].join('');

  return `
    <details class="coin-card" open>
      <summary>
        <span class="coin-rank">#${escapeHtml(coin.activeRank)}</span>
        <span class="coin-symbol">${escapeHtml(coin.symbol)}</span>
        <span class="coin-price">${escapeHtml(formatPrice(coin.livePrice))}</span>
        <span class="coin-score">${escapeHtml(coin.activePriority)}/100</span>
        <span class="coin-status">${escapeHtml(coin.moveStatus)}</span>
      </summary>

      <div class="coin-content">
        <div class="quick-grid">
          <div class="quick-item">
            <span>پتانسیل رشد</span>
            <strong>${escapeHtml(coin.potentialScore)}/100</strong>
          </div>
          <div class="quick-item">
            <span>ساختار فعلی</span>
            <strong>${escapeHtml(coin.structuralScore)}/100</strong>
          </div>
          <div class="quick-item">
            <span>قدرت نسبت به گذشته</span>
            <strong>${escapeHtml(relative.score ?? 50)}/100</strong>
          </div>
          <div class="quick-item">
            <span>انرژی حرکت</span>
            <strong>${escapeHtml(coin.energyScore)}/100</strong>
          </div>
        </div>

        <section class="detail-section">
          <h3>جزئیات رتبه‌بندی و مقایسه تاریخی</h3>
          <div class="detail-grid">${rows}</div>
        </section>

        <section class="detail-section">
          <h3>شواهد صعود</h3>
          ${htmlList(coin.evidence)}
        </section>

        <section class="detail-section warning-section">
          <h3>هشدارها و ریسک‌ها</h3>
          ${htmlList(coin.warnings, 'هشدار مشخصی ثبت نشده است')}
        </section>
      </div>
    </details>
  `;
}

function buildHtmlReport(
  candidates,
  stats,
  duration,
  generatedAt,
  activeRanked
) {
  const cards = activeRanked.length
    ? activeRanked.map(buildCoinHtml).join('\n')
    : '<p class="empty">در این اسکن ارز واجد شرایطی برای فهرست فعال پیدا نشد.</p>';

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Gate.io Relative Strength Bullish Radar</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0b1020;
  --panel: #121a2d;
  --panel2: #19243b;
  --border: #293650;
  --text: #e8eefc;
  --muted: #9baac5;
  --green: #37d69a;
  --blue: #62a9ff;
  --yellow: #f4c96b;
  --red: #ff7777;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font-family: Tahoma, Arial, sans-serif;
  line-height: 1.8;
}
.container { max-width: 1100px; margin: auto; }
header {
  background: linear-gradient(135deg, #172746, #142033);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 24px;
  margin-bottom: 22px;
}
h1 { margin: 0 0 8px; font-size: 23px; }
.subtitle { color: var(--muted); font-size: 13px; }
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  margin-top: 20px;
}
.stat {
  background: rgba(8, 15, 30, .55);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
}
.stat span { display: block; color: var(--muted); font-size: 12px; }
.stat strong { font-size: 19px; }
.section {
  margin: 24px 0;
  padding: 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 16px;
  font-size: 19px;
}
.count {
  background: var(--panel2);
  color: var(--muted);
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
}
.coin-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  margin: 12px 0;
  overflow: hidden;
  background: #0f1729;
}
.coin-card summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 13px 15px;
  background: #172239;
}
.coin-card summary::-webkit-details-marker { display: none; }
.coin-card summary::before {
  content: '＋';
  color: var(--muted);
  font-size: 16px;
}
.coin-card[open] summary::before { content: '−'; }
.coin-rank { color: var(--yellow); font-weight: bold; }
.coin-symbol { font-weight: bold; direction: ltr; }
.coin-price { color: var(--green); direction: ltr; }
.coin-score { color: var(--blue); font-weight: bold; }
.coin-status { color: var(--muted); font-size: 12px; }
.coin-content { padding: 15px; }
.quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
  gap: 9px;
  margin-bottom: 18px;
}
.quick-item {
  background: var(--panel2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
}
.quick-item span { display: block; color: var(--muted); font-size: 11px; }
.quick-item strong { display: block; overflow-wrap: anywhere; }
.detail-section {
  border-top: 1px solid var(--border);
  padding: 13px 0;
}
.detail-section h3 { margin: 0 0 10px; font-size: 14px; color: var(--blue); }
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 7px;
}
.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  background: #151f33;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
}
.detail-label { color: var(--muted); }
.detail-value { text-align: left; direction: ltr; overflow-wrap: anywhere; }
ul { margin: 5px 0; padding-right: 22px; }
li { margin: 4px 0; font-size: 13px; }
.warning-section h3 { color: var(--red); }
.warning-section li { color: #ffc0a8; }
.muted, .empty { color: var(--muted); font-size: 13px; }
.empty {
  padding: 16px;
  background: #151f33;
  border-radius: 10px;
}
footer {
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  padding: 20px 0;
}
@media (max-width: 600px) {
  body { padding: 10px; }
  header, .section { padding: 13px; }
  h1 { font-size: 18px; }
  .coin-card summary { gap: 7px; padding: 11px; }
  .detail-grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🚀 گزارش تحلیل بازار Gate.io</h1>
  <div class="subtitle">Relative Strength & Early Bullish Radar | رتبه‌بندی بر اساس قدرت فعلی و سابقه هر ارز</div>
  <div class="stats">
    <div class="stat"><span>زمان تولید گزارش</span><strong>${escapeHtml(generatedAt)}</strong></div>
    <div class="stat"><span>بازارهای بررسی‌شده</span><strong>${candidates.length}</strong></div>
    <div class="stat"><span>قراردادهای فعال</span><strong>${stats.active}</strong></div>
    <div class="stat"><span>بازارهای نقدشونده</span><strong>${stats.liquid}</strong></div>
    <div class="stat"><span>تحلیل موفق</span><strong>${stats.success}</strong></div>
    <div class="stat"><span>خطاها</span><strong>${stats.errors}</strong></div>
    <div class="stat"><span>زمان اسکن</span><strong>${(duration / 1000).toFixed(1)}s</strong></div>
  </div>
</header>

<section class="section">
  <h2 class="section-title">
    🏆 بهترین فرصت‌های صعود
    <span class="count">${activeRanked.length} از ${CONFIG.TOP_COUNT} ارز</span>
  </h2>
  ${cards}
</section>

<footer>
  رتبه‌بندی بر اساس ساختار، پتانسیل، مقایسه تاریخی هر ارز، انرژی حرکت و کیفیت ورود است. رتبه بالا تضمین‌کننده رشد قیمت نیست.
</footer>
</div>
</body>
</html>`;
}

async function saveHtmlReport(
  candidates,
  stats,
  duration,
  activeRanked
) {
  const generatedAt = new Date().toLocaleString(
    'fa-IR',
    {
      dateStyle: 'full',
      timeStyle: 'medium',
    }
  );

  const html = buildHtmlReport(
    candidates,
    stats,
    duration,
    generatedAt,
    activeRanked
  );

  await writeFile(
    CONFIG.HTML_REPORT_FILE,
    html,
    'utf8'
  );

  console.log(
    `📄 HTML report saved: ${CONFIG.HTML_REPORT_FILE}`
  );
}

/* -------------------------------------------------------------------------- */
/* MAIN                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const startedAt = Date.now();
  const nowMs = Date.now();

  console.log('\n🚀 GATE.IO RELATIVE STRENGTH BULLISH RADAR');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎯 Ranking current strength against each coin own history');
  console.log('🏆 One unified active list | Maximum 10 coins');
  console.log('🛑 Small 5m fluctuations do not remove active members.');

  const previousMemory = await loadScannerMemory();

  const previousTradeStates =
    previousMemory.tradeStates || {};

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers(),
  ]);

  if (
    !Array.isArray(contracts) ||
    !Array.isArray(tickers)
  ) {
    throw new Error(
      'داده قراردادها یا تیکرهای Gate.io معتبر نیست.'
    );
  }

  const tickerMap = new Map(
    tickers.map((ticker) => [
      ticker.contract,
      ticker,
    ])
  );

  const activeContracts = contracts.filter(
    (contract) =>
      contract?.name &&
      contract.in_delisting !== true &&
      tickerMap.has(contract.name)
  );

  const liquidMarkets = activeContracts
    .map((contract) => {
      const ticker = tickerMap.get(contract.name);

      return {
        symbol: contract.name,
        ticker,
        contract,
        quoteVolume: number(ticker.volume_24h_quote),
        lastPrice: number(ticker.last),
      };
    })
    .filter((market) =>
      market.lastPrice > 0 &&
      market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
    )
    .sort((a, b) =>
      b.quoteVolume - a.quoteVolume
    );

  console.log(
    `📊 Active contracts: ${activeContracts.length}`
  );

  console.log(
    `💧 Liquid contracts: ${liquidMarkets.length}`
  );

  console.log('🔍 Scanning liquid contracts...\n');

  let success = 0;
  let errors = 0;

  const analyzedSymbols = new Set();

  const analyzed = await mapLimit(
    liquidMarkets,
    CONFIG.CONCURRENCY,
    async (market) => {
      const [
        candles5mData,
        candles15mData,
        candles1h,
        candles4h,
        candles1dData,
        tradesResult,
        statsResult,
      ] = await Promise.all([
        getCandles(
          market.symbol,
          '5m',
          CONFIG.TIMEFRAMES['5m'].limit,
          true
        ).catch(() => ({
          closed: [],
          current: null,
        })),

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
        ),

        getCandles(
          market.symbol,
          '1d',
          CONFIG.TIMEFRAMES['1d'].limit,
          true
        ),

        getRecentTrades(market.symbol).catch(() => []),
        getContractStats(market.symbol).catch(() => []),
      ]);

      const candles5m = Array.isArray(candles5mData?.closed)
        ? candles5mData.closed
        : [];
      const candles15m = candles15mData.closed;
      const candles1d = candles1dData.closed;

      if (
        candles15m.length < 30 ||
        candles1h.length < 30 ||
        candles4h.length < 30 ||
        candles1d.length < 30
      ) {
        throw new Error(
          'کندل کافی برای تحلیل تایم‌فریم‌ها دریافت نشد.'
        );
      }

      const derivatives = analyzeDerivatives(
        tradesResult,
        statsResult,
        market.contract?.quanto_multiplier
      );

      const candidate = analyzeCoin({
        symbol: market.symbol,

        candles: {
          '15m': candles15m,
          '1h': candles1h,
          '4h': candles4h,
          '1d': candles1d,
        },

        dailyCurrent: candles1dData.current,
        livePrice: market.lastPrice,
        derivatives,
      });

      if (!candidate) {
        throw new Error('تحلیل تکنیکال خروجی معتبر نداشت.');
      }

      success++;
      analyzedSymbols.add(market.symbol);

      candidate.livePrice = market.lastPrice;
      candidate.live15m = candles15mData.current;
      candidate.live1d = candles1dData.current;

      candidate.opportunityType =
        classifyOpportunity(candidate);

      const setup = buildTradeSetup(
        candidate,
        candles15m,
        candles5m
      );

      const tradeState = updateTradeState(
        candidate,
        setup,
        previousTradeStates[market.symbol],
        nowMs,
        candles5m,
        candles15m
      );

      candidate.tradeStatus = tradeState.status;
      candidate.tradeStatusLabel = tradeState.statusLabel;
      candidate.tradeSetup = tradeState.setup;
      candidate.tradeState = tradeState;

      delete candidate._analysis;

      return candidate;
    }
  );

  const candidates = [];

  for (const result of analyzed) {
    if (result?.error) {
      errors++;
      continue;
    }

    if (result) candidates.push(result);
  }

  // ابتدا سابقه هر ارز به‌روزرسانی و قدرت فعلی با گذشته خودش مقایسه می‌شود.
  const memoryWithHistory = updateCoinHistory(
    previousMemory,
    candidates,
    analyzedSymbols,
    nowMs
  );

  let rankChanges = null;

  try {
    // فایل marketStorage.js بدون تغییر باقی می‌ماند.
    const storageResult =
      await saveMarketSnapshot(candidates);

    rankChanges =
      storageResult?.rankChanges ?? null;

    console.log('\n💾 MARKET DATA SAVED');
    console.log('📊 Market snapshot saved successfully.');
  } catch (storageError) {
    console.error(
      '⚠️ MARKET STORAGE FAILED:',
      storageError
    );
  }

  // رتبه‌بندی واحد با ثبات ساختاری و مقایسه با گذشته هر ارز
  const {
    activeRanked,
    activeList,
  } = assignStableRanks(
    candidates,
    memoryWithHistory,
    nowMs
  );

  const updatedMemory = updateScannerMemory(
    memoryWithHistory,
    candidates,
    activeList,
    analyzedSymbols,
    nowMs
  );

  try {
    await saveScannerMemory(updatedMemory);

    console.log(
      `💾 Scanner memory saved | Active memory: ${Object.keys(updatedMemory.activeList).length} | Watchlist: ${Object.keys(updatedMemory.watchlist).length} | Historical coins: ${Object.keys(updatedMemory.coinHistory).length} | Trade states: ${Object.keys(updatedMemory.tradeStates).length}`
    );
  } catch (memoryError) {
    console.error(
      '⚠️ SCANNER MEMORY SAVE FAILED:',
      memoryError
    );
  }

  const duration = Date.now() - startedAt;

  const stats = {
    active: activeContracts.length,
    liquid: liquidMarkets.length,
    success,
    errors,
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏆 UNIFIED ACTIVE BULLISH OPPORTUNITIES');
  console.log(
    `Active opportunities: ${activeRanked.length}/${CONFIG.TOP_COUNT}`
  );

  activeRanked.forEach((coin) => {
    console.log(
      [
        `${coin.activeRank}. ${coin.symbol}`,
        `Priority ${coin.activePriority}`,
        `Structure ${coin.structuralScore}`,
        `Potential ${coin.potentialScore}`,
        `Relative ${coin.relativeSelf?.score ?? 50}`,
        `Energy ${coin.energyScore}`,
        coin.moveStatus,
      ].join(' | ')
    );
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    `Analyzed candidates: ${candidates.length}`
  );
  console.log(
    `Successful analyses: ${success}`
  );
  console.log(`Errors: ${errors}`);
  console.log(
    `Internal Watchlist: ${Object.keys(updatedMemory.watchlist).length}`
  );
  console.log(
    `Historical coin profiles: ${Object.keys(updatedMemory.coinHistory).length}`
  );
  console.log(
    `Duration: ${(duration / 1000).toFixed(1)}s`
  );
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    await saveHtmlReport(
      candidates,
      stats,
      duration,
      activeRanked
    );
  } catch (htmlError) {
    console.error(
      '⚠️ HTML REPORT FAILED:',
      htmlError
    );
  }

  await sendReports(
    buildReport(
      candidates,
      stats,
      duration,
      activeRanked
    )
  );

  console.log(
    '✅ Telegram report sent successfully.'
  );
}

main().catch((error) => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
