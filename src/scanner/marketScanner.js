```javascript
/**
 * src/scanner/marketScanner.js
 * Node.js 20+ / ESM
 *
 * Gate.io USDT perpetual — LONG + SHORT
 * Fixed strategy settings; Telegram credentials from process.env.
 * Historical targets only. No order execution.
 * Scores are heuristic, not success probabilities.
 * No persistent cross-run Telegram deduplication.
 */

import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

const CONFIG = Object.freeze({
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',

  MODE: 'BALANCED',
  ENABLE_LONG: true,
  ENABLE_SHORT: true,

  MIN_QUOTE_VOLUME_24H: 1_000_000,
  SCAN_LIMIT: 0,
  TOP_COUNT: 5,
  TELEGRAM_SEND_EMPTY: false,

  MIN_LONG_SCORE: 70,
  MIN_LONG_SCORE_NEUTRAL: 75,
  MIN_LONG_SCORE_BEARISH: 82,
  MIN_SHORT_SCORE: 70,
  MIN_SHORT_SCORE_NEUTRAL: 75,
  MIN_SHORT_SCORE_BULLISH: 82,

  CONCURRENCY: 5,
  REQUEST_SPACING_MS: 120,
  REQUEST_TIMEOUT_MS: 15_000,
  RETRIES: 3,
  TELEGRAM_MAX_LENGTH: 3800,

  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,
  MIN_CANDLES_15M: 220,
  MIN_CANDLES_4H: 250,

  HISTORY_HOURS: 24,
  HISTORY_REPORT_HOURS: 6,
  TRADE_LIMIT: 1000,

  MIN_RECENT_BUY_NOTIONAL: 1500,
  MIN_RECENT_SELL_NOTIONAL: 1500,
  MIN_PREVIOUS_FLOW_BASELINE: 300,

  MAX_RSI_LONG_ENTRY: 70,
  MAX_RSI_LONG_4H: 75,
  MIN_RSI_SHORT_ENTRY: 30,
  MIN_RSI_SHORT_4H: 25,

  MAX_FUNDING_RATE_LONG: 0.001,
  MIN_FUNDING_RATE_SHORT: -0.001,

  MIN_RR_TP1: 1.0,
  MIN_RR_TP2: 1.8,
  MIN_SINGLE_TARGET_RR: 1.8,
  MIN_COUNTER_BTC_RR: 2.2,

  STOP_ATR_BUFFER: 0.5,
  MIN_STOP_ATR: 0.8,
  MAX_STOP_ATR: 5,
  MAX_STOP_PCT: 6,

  MAX_DISTANCE_EMA_ATR: 2,
  MAX_TRIGGER_DRIFT_ATR: 0.75,
  MAX_TRIGGER_DRIFT_PCT: 2.5,

  ENTRY_ZONE_ATR: 0.15,
  MAX_ENTRY_ZONE_PCT: 0.2,
  ENTRY_VALID_MINUTES: 15,

  FEE_RATE_PER_SIDE: 0.0006,
  SLIPPAGE_RATE_PER_SIDE: 0.0003,

  MAX_SCAN_AGE_SECONDS: 240,
  MAX_QUOTE_AGE_SECONDS: 60,
  LEVEL_CLUSTER_ATR: 0.25,
});

// ==================== Utilities ====================

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const num = value => {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
};

const positive = value => Number.isFinite(value) && value > 0;

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const round = (value, digits = 2) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

const fmt = (value, digits = 2) =>
  Number.isFinite(value) ? value.toFixed(digits) : '—';

const average = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const pctChange = (current, previous) =>
  Number.isFinite(current) && positive(previous)
    ? ((current - previous) / previous) * 100
    : null;

function fmtPrice(value) {
  if (!positive(value)) return '—';
  if (value < 0.00000001) return value.toPrecision(6);

  return Number(value.toPrecision(8)).toLocaleString('en-US', {
    maximumFractionDigits: 12,
    useGrouping: false,
  });
}

function directionalPct(side, entry, exit) {
  if (!positive(entry) || !positive(exit)) return null;

  return side === 'SHORT'
    ? ((entry - exit) / entry) * 100
    : ((exit - entry) / entry) * 100;
}

function directionalPctText(side, entry, exit) {
  const value = directionalPct(side, entry, exit);

  return value == null
    ? '—'
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected array response`);
  }
  return value;
}

function reject(context, reason, side = null) {
  const bucket = side
    ? context.rejectStats[side]
    : context.rejectStats.GLOBAL;

  bucket[reason] = (bucket[reason] ?? 0) + 1;
  return null;
}

// ==================== Requests ====================

let lastRequestAt = 0;
let requestQueue = Promise.resolve();
let runningScan = null;

async function reserveRequestSlot() {
  const slot = requestQueue.then(async () => {
    const wait = CONFIG.REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });

  requestQueue = slot.catch(() => {});
  await slot;
}

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  let lastError;

  for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    await reserveRequestSlot();

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return await response.json();

      const body = await response.text().catch(() => '');
      const error = new Error(
        `Gate HTTP ${response.status} ${path}: ${body.slice(0, 180)}`
      );

      error.status = response.status;

      const retryHeader = response.headers.get('retry-after');
      const retrySeconds = Number(retryHeader);

      error.retryAfterMs =
        retryHeader && Number.isFinite(retrySeconds)
          ? retrySeconds * 1000
          : retryHeader
            ? Math.max(0, Date.parse(retryHeader) - Date.now()) || 0
            : 0;

      throw error;
    } catch (error) {
      lastError = error;

      const retryable = [
        408, 425, 429, 500, 502, 503, 504,
      ].includes(error.status);

      if (
        attempt === CONFIG.RETRIES ||
        (error.status != null && !retryable)
      ) {
        break;
      }

      const delay = error.retryAfterMs > 0
        ? Math.min(error.retryAfterMs, 30_000)
        : Math.min(500 * (2 ** attempt), 8000);

      await sleep(delay);
    }
  }

  throw lastError || new Error(`Gate request failed: ${path}`);
}

async function optionalArrayRequest(path, params, label) {
  try {
    return requireArray(await requestGate(path, params), label);
  } catch (error) {
    console.warn(`[OPTIONAL DATA] ${label}: ${error.message}`);
    return null;
  }
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
            console.error(
              `[MARKET ERROR] ${items[index]?.symbol}: ${error.message}`
            );

            output[index] = {
              __error: error.message,
              symbol: items[index]?.symbol,
            };
          }
        }
      }
    )
  );

  return output;
}

// ==================== Candles ====================

function normalizeCandle(raw) {
  const time = num(raw?.t);
  const open = num(raw?.o);
  const high = num(raw?.h);
  const low = num(raw?.l);
  const close = num(raw?.c);

  if (
    !positive(time) ||
    ![open, high, low, close].every(positive) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    high < low
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volumeContracts: num(raw?.v),
    quoteTurnover: num(raw?.sum),
  };
}

function toClosedCandles(raw, intervalSeconds, asOf) {
  const unique = new Map();

  for (const row of requireArray(raw, 'candles')) {
    const candle = normalizeCandle(row);

    if (candle && candle.time + intervalSeconds <= asOf) {
      unique.set(candle.time, candle);
    }
  }

  return [...unique.values()].sort((a, b) => a.time - b.time);
}

function validCandleSeries(candles, seconds, minimum, asOf) {
  if (candles.length < minimum) return false;

  const expectedLastStart =
    Math.floor(asOf / seconds) * seconds - seconds;

  if (candles.at(-1).time !== expectedLastStart) return false;

  const recent = candles.slice(-minimum);

  for (let i = 1; i < recent.length; i++) {
    if (recent[i].time - recent[i - 1].time !== seconds) {
      return false;
    }
  }

  return true;
}

// ==================== Indicators ====================

function emaSeries(values, period) {
  const alpha = 2 / (period + 1);
  let previous = values[0];

  return values.map((value, index) => {
    previous = index === 0
      ? value
      : alpha * value + (1 - alpha) * previous;

    return previous;
  });
}

function wilderSeries(values, period = 14) {
  const output = new Array(values.length).fill(null);
  if (values.length < period) return output;

  let previous = average(values.slice(0, period));
  output[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous = (previous * (period - 1) + values[i]) / period;
    output[i] = previous;
  }

  return output;
}

function rsiSeries(closes, period = 14) {
  const output = new Array(closes.length).fill(null);
  if (closes.length <= period) return output;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }

  gain /= period;
  loss /= period;

  const rsiValue = () =>
    gain === 0 && loss === 0
      ? 50
      : loss === 0
        ? 100
        : 100 - 100 / (1 + gain / loss);

  output[period] = rsiValue();

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];

    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;

    output[i] = rsiValue();
  }

  return output;
}

function addIndicators(candles) {
  if (!candles.length) return [];

  const closes = candles.map(c => c.close);
  const ema9 = emaSeries(closes, 9);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);

  const macd = closes.map((_, i) => ema12[i] - ema26[i]);
  const macdSignal = emaSeries(macd, 9);
  const rsi = rsiSeries(closes);

  const trueRanges = [];
  const plusDM = [];
  const minusDM = [];

  candles.forEach((c, i) => {
    const previous = candles[i - 1];

    trueRanges.push(
      previous
        ? Math.max(
            c.high - c.low,
            Math.abs(c.high - previous.close),
            Math.abs(c.low - previous.close)
          )
        : c.high - c.low
    );

    const up = previous ? c.high - previous.high : 0;
    const down = previous ? previous.low - c.low : 0;

    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  });

  const atr = wilderSeries(trueRanges);
  const plus = wilderSeries(plusDM);
  const minus = wilderSeries(minusDM);

  const plusDI = atr.map((value, i) =>
    positive(value) ? 100 * plus[i] / value : null
  );

  const minusDI = atr.map((value, i) =>
    positive(value) ? 100 * minus[i] / value : null
  );

  const dx = atr.map((value, i) => {
    if (value == null) return null;
    const total = (plusDI[i] ?? 0) + (minusDI[i] ?? 0);

    return total > 0
      ? 100 * Math.abs(plusDI[i] - minusDI[i]) / total
      : 0;
  });

  const adx = new Array(candles.length).fill(null);
  const dxStart = dx.findIndex(value => value != null);

  if (dxStart >= 0) {
    wilderSeries(dx.slice(dxStart)).forEach((value, i) => {
      adx[dxStart + i] = value;
    });
  }

  return candles.map((c, i) => {
    const prior = candles.slice(Math.max(0, i - 20), i);

    const quoteAvailable =
      c.quoteTurnover != null &&
      c.quoteTurnover >= 0 &&
      prior.every(x =>
        x.quoteTurnover != null && x.quoteTurnover >= 0
      );

    const volume = quoteAvailable
      ? c.quoteTurnover
      : c.volumeContracts;

    const previousVolumes = prior.map(x =>
      quoteAvailable ? x.quoteTurnover : x.volumeContracts
    );

    const volMa20 =
      prior.length === 20 &&
      previousVolumes.every(x => x != null && x >= 0)
        ? average(previousVolumes)
        : null;

    return {
      ...c,
      ema9: ema9[i],
      ema20: ema20[i],
      ema50: ema50[i],
      ema200: ema200[i],
      rsi: rsi[i],
      macdHist: macd[i] - macdSignal[i],
      atr: atr[i],
      adx: adx[i],
      plusDI: plusDI[i],
      minusDI: minusDI[i],
      volumeRatio:
        positive(volMa20) && volume != null
          ? volume / volMa20
          : null,
    };
  });
}

// ==================== Patterns ====================

function engulfingPattern(candles, side) {
  const last = candles.at(-1);
  const previous = candles.at(-2);

  if (side === 'LONG') {
    return last.close > last.open &&
      previous.close < previous.open &&
      last.close >= previous.open &&
      last.open <= previous.close;
  }

  return last.close < last.open &&
    previous.close > previous.open &&
    last.open >= previous.close &&
    last.close <= previous.open;
}

function rejectionCandle(candles, side) {
  const last = candles.at(-1);
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;

  if (!positive(body) || !positive(range)) return false;

  const lower = Math.min(last.open, last.close) - last.low;
  const upper = last.high - Math.max(last.open, last.close);

  if (side === 'LONG') {
    return last.close > last.open &&
      lower >= body * 2 &&
      upper <= body &&
      (last.close - last.low) / range >= 0.65;
  }

  return last.close < last.open &&
    upper >= body * 2 &&
    lower <= body &&
    (last.close - last.low) / range <= 0.35;
}

// ==================== Historical targets ====================

function findTargetZones(candles15, candles4, entry, atr, side) {
  const isLong = side === 'LONG';
  const points = [];

  for (const [timeframe, candles] of [
    ['15m', candles15],
    ['4h', candles4],
  ]) {
    for (let i = 2; i < candles.length - 2; i++) {
      const price = isLong ? candles[i].high : candles[i].low;

      const confirmed = isLong
        ? (
            price > candles[i - 1].high &&
            price > candles[i - 2].high &&
            price >= candles[i + 1].high &&
            price >= candles[i + 2].high
          )
        : (
            price < candles[i - 1].low &&
            price < candles[i - 2].low &&
            price <= candles[i + 1].low &&
            price <= candles[i + 2].low
          );

      if (confirmed) {
        points.push({
          price,
          timeframe,
          time: candles[i].time,
        });
      }
    }
  }

  points.sort((a, b) => a.price - b.price);

  const zones = [];

  for (const point of points) {
    const previous = zones.at(-1);

    const tolerance = Math.min(
      atr * CONFIG.LEVEL_CLUSTER_ATR,
      point.price * 0.003
    );

    if (previous && point.price - previous.low <= tolerance) {
      previous.high = Math.max(previous.high, point.price);
      previous.touches++;
      previous.timeframes = [
        ...new Set([...previous.timeframes, point.timeframe]),
      ];
    } else {
      zones.push({
        low: point.price,
        high: point.price,
        touches: 1,
        timeframes: [point.timeframe],
      });
    }
  }

  return isLong
    ? zones
        .filter(zone => zone.high >= entry)
        .sort((a, b) => a.low - b.low)
    : zones
        .filter(zone => zone.low <= entry)
        .sort((a, b) => b.high - a.high);
}

function netRR(side, entry, stop, target) {
  const costRate =
    CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE;

  const priceRisk = side === 'LONG' ? entry - stop : stop - entry;
  const priceReward = side === 'LONG' ? target - entry : entry - target;

  const risk = priceRisk + (entry + stop) * costRate;
  const reward = priceReward - (entry + target) * costRate;

  return positive(risk) ? reward / risk : null;
}

// ==================== Trade samples ====================

function tradeTime(trade) {
  const milliseconds = num(trade?.create_time_ms);

  return positive(milliseconds)
    ? milliseconds / 1000
    : num(trade?.create_time);
}

function aggregateTrades(rawTrades, multiplier, requestedFrom, asOf) {
  const available = Array.isArray(rawTrades);
  const rows = available ? rawTrades : [];

  let invalid = 0;
  const seen = new Set();
  const normalized = [];

  for (const trade of rows) {
    const time = tradeTime(trade);
    const size = num(trade?.size);
    const price = num(trade?.price);

    if (
      !positive(time) ||
      size == null ||
      !positive(price) ||
      !positive(multiplier)
    ) {
      invalid++;
      continue;
    }

    if (trade.id != null) {
      const id = String(trade.id);
      if (seen.has(id)) continue;
      seen.add(id);
    }

    if (time < requestedFrom || time > asOf) continue;

    normalized.push({
      time,
      buy: size > 0 ? size * multiplier * price : 0,
      sell: size < 0 ? Math.abs(size) * multiplier * price : 0,
    });
  }

  const oldest = normalized.length
    ? Math.min(...normalized.map(x => x.time))
    : null;

  const truncated = rows.length >= CONFIG.TRADE_LIMIT;
  const coveredFrom = truncated ? oldest : requestedFrom;

  const covered = start =>
    available &&
    invalid === 0 &&
    coveredFrom != null &&
    coveredFrom <= start;

  const sumWindow = (start, end) => {
    const trades = normalized.filter(x =>
      x.time >= start && x.time < end
    );

    const buy = trades.reduce((sum, x) => sum + x.buy, 0);
    const sell = trades.reduce((sum, x) => sum + x.sell, 0);

    return {
      buy,
      sell,
      total: buy + sell,
      delta: buy - sell,
      buyShare: buy + sell > 0 ? 100 * buy / (buy + sell) : null,
      count: trades.length,
    };
  };

  const end = Math.floor(asOf / 60) * 60;
  const recent = sumWindow(end - 180, end);
  const previous = sumWindow(end - 360, end - 180);
  const prior = sumWindow(end - 540, end - 360);
  const recentComplete = covered(end - 180);

  const buyBaselineValid =
    covered(end - 360) &&
    previous.buy >= CONFIG.MIN_PREVIOUS_FLOW_BASELINE;

  const sellBaselineValid =
    covered(end - 360) &&
    previous.sell >= CONFIG.MIN_PREVIOUS_FLOW_BASELINE;

  const buyRateMultiple = buyBaselineValid
    ? recent.buy / previous.buy
    : null;

  const sellRateMultiple = sellBaselineValid
    ? recent.sell / previous.sell
    : null;

  const buyAcceleration =
    buyRateMultiple != null &&
    covered(end - 540) &&
    prior.buy >= CONFIG.MIN_PREVIOUS_FLOW_BASELINE
      ? buyRateMultiple - previous.buy / prior.buy
      : null;

  const sellAcceleration =
    sellRateMultiple != null &&
    covered(end - 540) &&
    prior.sell >= CONFIG.MIN_PREVIOUS_FLOW_BASELINE
      ? sellRateMultiple - previous.sell / prior.sell
      : null;

  let activeBuyMinutes = 0;
  let activeSellMinutes = 0;

  for (let start = end - 180; start < end; start += 60) {
    const bucket = sumWindow(start, start + 60);
    if (bucket.buy > 0) activeBuyMinutes++;
    if (bucket.sell > 0) activeSellMinutes++;
  }

  const hourStart = Math.floor(asOf / 3600) * 3600;
  const hour = sumWindow(hourStart, asOf + 0.001);

  const coveragePct = !available
    ? null
    : !truncated
      ? 100
      : oldest == null
        ? 0
        : clamp(
            100 * (asOf - Math.max(hourStart, oldest)) /
            Math.max(1, asOf - hourStart)
          );

  return {
    available,
    recentComplete,
    validTrades: normalized.length,

    currentHour: {
      buyNotionalSample: round(hour.buy),
      sellNotionalSample: round(hour.sell),
      buySharePct: round(hour.buyShare, 1),
      netDeltaSample: round(hour.delta),
      sampleCoveragePct: round(coveragePct, 0),
      sampleTruncated: truncated,
      sampleTrades: hour.count,
    },

    recent3m: {
      buyNotional: round(recent.buy),
      sellNotional: round(recent.sell),
      buySharePct: round(recent.buyShare, 1),
      sellSharePct: recent.buyShare == null
        ? null
        : round(100 - recent.buyShare, 1),
      netDelta: round(recent.delta),
      buyNotionalPerMinute: round(recent.buy / 3),
      sellNotionalPerMinute: round(recent.sell / 3),
      previousBuyNotionalPerMinute: round(previous.buy / 3),
      previousSellNotionalPerMinute: round(previous.sell / 3),
      buyRateMultiple: round(buyRateMultiple),
      sellRateMultiple: round(sellRateMultiple),
      buyAcceleration: round(buyAcceleration),
      sellAcceleration: round(sellAcceleration),
      baselineValid: buyBaselineValid,
      sellBaselineValid,
      sampleComplete: recentComplete,
      persistencePct: round(activeBuyMinutes / 3 * 100, 0),
      sellPersistencePct: round(activeSellMinutes / 3 * 100, 0),
      activeBuyMinutes,
      activeSellMinutes,
      windowEnd: new Date(end * 1000).toISOString(),
    },
  };
}

// ==================== Hourly storage context ====================

function buildHourlyContext(rawCandles, rawStats, multiplier, asOf) {
  const candles = Array.isArray(rawCandles)
    ? toClosedCandles(rawCandles, 3600, asOf)
    : [];

  const statsByHour = new Map();

  for (const row of rawStats || []) {
    const time = num(row?.time);
    if (!positive(time)) continue;

    const bucket = Math.floor(time / 3600) * 3600;
    if (bucket + 3600 <= asOf) statsByHour.set(bucket, row);
  }

  const history = candles.map(candle => {
    const stat = statsByHour.get(candle.time);
    const long = num(stat?.long_taker_size);
    const short = num(stat?.short_taker_size);
    const directionalDataAvailable = long != null && short != null;

    const buy = directionalDataAvailable
      ? Math.abs(long) * multiplier * candle.close
      : null;

    const sell = directionalDataAvailable
      ? Math.abs(short) * multiplier * candle.close
      : null;

    return {
      time: new Date(candle.time * 1000).toISOString(),
      open: candle.open,
      close: candle.close,
      priceChangePct: round(pctChange(candle.close, candle.open)),
      totalVolumeUSDT: round(candle.quoteTurnover),
      buyVolumeUSDT: round(buy),
      sellVolumeUSDT: round(sell),
      buySharePct: directionalDataAvailable && buy + sell > 0
        ? round(100 * buy / (buy + sell), 1)
        : null,
      deltaUSDT: directionalDataAvailable ? round(buy - sell) : null,
      directionalDataAvailable,
    };
  }).slice(-CONFIG.HISTORY_REPORT_HOURS);

  const previous = history.slice(0, 3);
  const recent = history.slice(-3);
  const enough = history.length === 6;

  const fieldAverage = (group, field) =>
    group.length === 3 && group.every(x => x[field] != null)
      ? average(group.map(x => x[field]))
      : null;

  const previousSell = fieldAverage(previous, 'sellVolumeUSDT');
  const recentSell = fieldAverage(recent, 'sellVolumeUSDT');
  const previousShare = fieldAverage(previous, 'buySharePct');
  const recentShare = fieldAverage(recent, 'buySharePct');
  const previousVolume = fieldAverage(previous, 'totalVolumeUSDT');
  const recentVolume = fieldAverage(recent, 'totalVolumeUSDT');

  const sellerPressureFalling =
    enough &&
    positive(previousSell) &&
    recentSell != null &&
    recentSell < previousSell * 0.9;

  const buyShareImproving =
    enough &&
    previousShare != null &&
    recentShare != null &&
    recentShare > previousShare + 3;

  const directionalCoveragePct = history.length
    ? round(
        100 * history.filter(x => x.directionalDataAvailable).length /
        history.length,
        0
      )
    : 0;

  const change = history.length >= 2
    ? pctChange(history.at(-1).close, history[0].close)
    : null;

  return {
    available: history.length >= 4,
    priceTrend: change == null
      ? 'UNKNOWN'
      : change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'FLAT',
    priceChangePct: round(change),

    volumeTrend:
      !enough || !positive(previousVolume) || recentVolume == null
        ? 'UNKNOWN'
        : recentVolume < previousVolume * 0.9
          ? 'FALLING'
          : recentVolume > previousVolume * 1.1
            ? 'RISING'
            : 'STABLE',

    sellerPressure:
      !enough || previousSell == null || recentSell == null
        ? 'INSUFFICIENT_DIRECTIONAL_DATA'
        : sellerPressureFalling ? 'FALLING' : 'NOT_FALLING',

    sellerPressureFalling,
    buyShareImproving,
    directionalCoveragePct,
    candles: history,
  };
}

// ==================== Markets / BTC ====================

async function getMarkets() {
  const [rawContracts, rawTickers] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/contracts`),
    requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);

  const contracts = requireArray(rawContracts, 'contracts');
  const tickers = requireArray(rawTickers, 'tickers');
  const tickerMap = new Map(
    tickers.map(ticker => [ticker.contract, ticker])
  );

  const active = contracts.filter(contract =>
    typeof contract.name === 'string' &&
    contract.name.endsWith('_USDT') &&
    contract.status === 'trading' &&
    contract.in_delisting === false &&
    positive(num(contract.quanto_multiplier))
  );

  const markets = active.map(contract => {
    const ticker = tickerMap.get(contract.name);
    const quoteVolume = num(ticker?.volume_24h_quote);

    if (
      !positive(num(ticker?.last)) ||
      quoteVolume == null ||
      quoteVolume < CONFIG.MIN_QUOTE_VOLUME_24H
    ) {
      return null;
    }

    return {
      symbol: contract.name,
      contract,
      ticker,
      quoteVolume,
    };
  })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  return { active, markets };
}

async function getBtcRegime(asOf) {
  try {
    const raw = await requestGate(
      `/futures/${CONFIG.SETTLE}/candlesticks`,
      {
        contract: 'BTC_USDT',
        interval: '4h',
        limit: CONFIG.CANDLES_4H_LIMIT,
      }
    );

    const candles = toClosedCandles(raw, 14400, asOf);

    if (!validCandleSeries(
      candles, 14400, CONFIG.MIN_CANDLES_4H, asOf
    )) {
      throw new Error('BTC candles insufficient, stale or discontinuous');
    }

    const last = addIndicators(candles).at(-1);

    if (last.close > last.ema50 && last.ema50 > last.ema200) {
      return 'BULLISH';
    }

    if (last.close < last.ema50 && last.ema50 < last.ema200) {
      return 'BEARISH';
    }

    return 'NEUTRAL';
  } catch (error) {
    console.error('[BTC REGIME]', error.message);
    return 'UNKNOWN';
  }
}

function prepareAnalysis(raw15, raw4, context) {
  const candles15 = toClosedCandles(raw15, 900, context.asOf);
  const candles4 = toClosedCandles(raw4, 14400, context.asOf);

  if (
    candles15.length < CONFIG.MIN_CANDLES_15M ||
    candles4.length < CONFIG.MIN_CANDLES_4H
  ) {
    return { error: 'INSUFFICIENT_CANDLES' };
  }

  if (
    !validCandleSeries(
      candles15, 900, CONFIG.MIN_CANDLES_15M, context.asOf
    ) ||
    !validCandleSeries(
      candles4, 14400, CONFIG.MIN_CANDLES_4H, context.asOf
    )
  ) {
    return { error: 'STALE_OR_GAPPED_CANDLES' };
  }

  return {
    c15: addIndicators(candles15),
    c4: addIndicators(candles4),
  };
}

// ==================== LONG / SHORT analyzer ====================

function analyzeDirection(market, prepared, context, side) {
  const isLong = side === 'LONG';
  const fail = reason => reject(context, reason, side);

  if (context.regime === 'UNKNOWN') return fail('BTC_DATA_UNKNOWN');

  const counterBTC = isLong
    ? context.regime === 'BEARISH'
    : context.regime === 'BULLISH';

  if (CONFIG.MODE === 'STRICT' && counterBTC) {
    return fail('BTC_OPPOSITE_STRICT');
  }

  const { c15, c4 } = prepared;
  const last = c15.at(-1);
  const previous = c15.at(-2);
  const trend = c4.at(-1);
  const price = num(market.ticker.last);
  const atr = last.atr;

  if (
    !positive(price) ||
    !positive(atr) ||
    ![
      last.rsi,
      previous.rsi,
      trend.rsi,
      trend.adx,
      trend.plusDI,
      trend.minusDI,
    ].every(Number.isFinite)
  ) {
    return fail('BAD_PRICE_OR_INDICATOR');
  }

  const trendValid = isLong
    ? trend.close > trend.ema50 && trend.ema50 > trend.ema200
    : trend.close < trend.ema50 && trend.ema50 < trend.ema200;

  if (!trendValid) return fail('COIN_4H_TREND');

  if (
    isLong &&
    (
      last.rsi > CONFIG.MAX_RSI_LONG_ENTRY ||
      trend.rsi > CONFIG.MAX_RSI_LONG_4H
    )
  ) {
    return fail('RSI_OVERBOUGHT');
  }

  if (
    !isLong &&
    (
      last.rsi < CONFIG.MIN_RSI_SHORT_ENTRY ||
      trend.rsi < CONFIG.MIN_RSI_SHORT_4H
    )
  ) {
    return fail('RSI_OVERSOLD');
  }

  const drift = Math.abs(price - last.close);

  if (
    drift > atr * CONFIG.MAX_TRIGGER_DRIFT_ATR ||
    drift / last.close * 100 > CONFIG.MAX_TRIGGER_DRIFT_PCT
  ) {
    return fail('PRICE_MOVED_AWAY_FROM_TRIGGER');
  }

  const emaDistance = isLong
    ? price - last.ema20
    : last.ema20 - price;

  if (emaDistance > atr * CONFIG.MAX_DISTANCE_EMA_ATR) {
    return fail('PRICE_CHASING');
  }

  const funding =
    num(market.contract.funding_rate) ??
    num(market.ticker.funding_rate);

  if (funding == null) return fail('FUNDING_UNKNOWN');

  if (
    (isLong && funding > CONFIG.MAX_FUNDING_RATE_LONG) ||
    (!isLong && funding < CONFIG.MIN_FUNDING_RATE_SHORT)
  ) {
    return fail('FUNDING_CROWDED');
  }

  const priorWindow = c15.slice(-41, -1);

  const structure = isLong
    ? Math.min(...priorWindow.map(x => x.low))
    : Math.max(...priorWindow.map(x => x.high));

  const structureBroken = isLong
    ? price <= structure || last.close <= structure
    : price >= structure || last.close >= structure;

  if (structureBroken) {
    return fail(isLong ? 'SUPPORT_BROKEN' : 'RESISTANCE_BROKEN');
  }

  const nearStructure = isLong
    ? (
        Math.abs(last.low - structure) <= atr * 0.6 &&
        last.close > structure
      )
    : (
        Math.abs(last.high - structure) <= atr * 0.6 &&
        last.close < structure
      );

  const touchedEma = isLong
    ? (
        last.low <= last.ema20 + atr * 0.25 &&
        last.high >= last.ema20 - atr * 0.25 &&
        last.close >= last.ema20
      )
    : (
        last.high >= last.ema20 - atr * 0.25 &&
        last.low <= last.ema20 + atr * 0.25 &&
        last.close <= last.ema20
      );

  const priorCorrection = c15.slice(-5, -1).some(x =>
    isLong
      ? x.close < x.ema20 || x.close < x.open
      : x.close > x.ema20 || x.close > x.open
  );

  const directionCandle = isLong
    ? last.close > last.open && last.close > previous.close
    : last.close < last.open && last.close < previous.close;

  const pullback =
    priorCorrection &&
    (nearStructure || touchedEma) &&
    directionCandle;

  const beforeBreak = c15.slice(-42, -2);

  const breakLevel = isLong
    ? Math.max(...beforeBreak.map(x => x.high))
    : Math.min(...beforeBreak.map(x => x.low));

  const breakVolume =
    previous.volumeRatio != null &&
    previous.volumeRatio >= 1.3;

  const breakRetest = breakVolume && (
    isLong
      ? (
          previous.close > breakLevel &&
          previous.close - breakLevel <= atr &&
          last.low >= breakLevel - atr * 0.5 &&
          last.low <= breakLevel + atr * 0.35 &&
          last.close > breakLevel &&
          last.close > last.open &&
          price >= breakLevel &&
          price - breakLevel <= atr
        )
      : (
          previous.close < breakLevel &&
          breakLevel - previous.close <= atr &&
          last.high <= breakLevel + atr * 0.5 &&
          last.high >= breakLevel - atr * 0.35 &&
          last.close < breakLevel &&
          last.close < last.open &&
          price <= breakLevel &&
          breakLevel - price <= atr
        )
  );

  if (!pullback && !breakRetest) return fail('NO_VALID_SETUP');

  const setup = breakRetest
    ? isLong ? 'BreakoutRetest' : 'BreakdownRetest'
    : 'Pullback';

  const cross = isLong
    ? previous.macdHist <= 0 && last.macdHist > 0
    : previous.macdHist >= 0 && last.macdHist < 0;

  const rsiTurn = isLong
    ? (
        last.rsi >= 35 &&
        last.rsi <= 60 &&
        last.rsi >= previous.rsi + 2
      )
    : (
        last.rsi >= 40 &&
        last.rsi <= 65 &&
        last.rsi <= previous.rsi - 2
      );

  const engulfing = engulfingPattern(c15, side);
  const rejection = rejectionCandle(c15, side);

  const emaTrigger = isLong
    ? (
        previous.close <= previous.ema9 &&
        last.close > last.ema9 &&
        last.close > last.open
      )
    : (
        previous.close >= previous.ema9 &&
        last.close < last.ema9 &&
        last.close < last.open
      );

  if (!(cross || rsiTurn || engulfing || rejection || emaTrigger || breakRetest)) {
    return fail('NO_15M_TRIGGER');
  }

  let stopStructure;

  if (breakRetest) {
    stopStructure = isLong
      ? Math.min(last.low, breakLevel)
      : Math.max(last.high, breakLevel);
  } else if (nearStructure) {
    stopStructure = isLong
      ? Math.min(structure, last.low)
      : Math.max(structure, last.high);
  } else {
    stopStructure = isLong
      ? Math.min(...c15.slice(-5).map(x => x.low))
      : Math.max(...c15.slice(-5).map(x => x.high));
  }

  const stopLoss = isLong
    ? stopStructure - atr * CONFIG.STOP_ATR_BUFFER
    : stopStructure + atr * CONFIG.STOP_ATR_BUFFER;

  const halfZone = Math.min(
    atr * CONFIG.ENTRY_ZONE_ATR,
    price * CONFIG.MAX_ENTRY_ZONE_PCT / 100
  );

  const entryLow = price - halfZone;
  const entryHigh = price + halfZone;
  const referenceEntry = isLong ? entryHigh : entryLow;

  const risk = isLong
    ? referenceEntry - stopLoss
    : stopLoss - referenceEntry;

  const invalidStop = isLong
    ? stopLoss >= entryLow
    : stopLoss <= entryHigh;

  if (
    !positive(stopLoss) ||
    !positive(entryLow) ||
    invalidStop ||
    risk < atr * CONFIG.MIN_STOP_ATR ||
    risk > atr * CONFIG.MAX_STOP_ATR ||
    risk / referenceEntry * 100 > CONFIG.MAX_STOP_PCT
  ) {
    return fail('BAD_RISK');
  }

  const zones = findTargetZones(
    c15, c4, referenceEntry, atr, side
  );

  if (!zones.length) return fail('NO_HISTORICAL_TARGET');

  const entryInsideObstacle = isLong
    ? zones[0].low <= referenceEntry
    : zones[0].high >= referenceEntry;

  if (entryInsideObstacle) {
    return fail(
      isLong ? 'ENTRY_INSIDE_RESISTANCE' : 'ENTRY_INSIDE_SUPPORT'
    );
  }

  const source = isLong
    ? 'HISTORICAL_PIVOT_RESISTANCE'
    : 'HISTORICAL_PIVOT_SUPPORT';

  const targets = zones.slice(0, 3).map((zone, index) => {
    const target = isLong ? zone.low : zone.high;

    return {
      level: index + 1,
      price: target,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      source,
      timeframes: zone.timeframes,
      touches: zone.touches,
      pct: round(directionalPct(side, referenceEntry, target)),
      rrNet: round(netRR(side, referenceEntry, stopLoss, target)),
    };
  });

  const rr1 = netRR(
    side, referenceEntry, stopLoss, targets[0].price
  );

  const rr2 = targets[1]
    ? netRR(side, referenceEntry, stopLoss, targets[1].price)
    : null;

  if (
    !Number.isFinite(rr1) ||
    rr1 < CONFIG.MIN_RR_TP1 ||
    (rr2 != null && rr2 < CONFIG.MIN_RR_TP2) ||
    (rr2 == null && rr1 < CONFIG.MIN_SINGLE_TARGET_RR)
  ) {
    return fail('LOW_RR_AT_NEAREST_LEVEL');
  }

  const finalRR = rr2 ?? rr1;

  const directionalStrength = isLong
    ? trend.plusDI > trend.minusDI
    : trend.minusDI > trend.plusDI;

  if (
    counterBTC &&
    (
      trend.adx < 25 ||
      !directionalStrength ||
      finalRR < CONFIG.MIN_COUNTER_BTC_RR
    )
  ) {
    return fail('COUNTER_BTC_WEAK_SETUP');
  }

  const emaAligned = isLong
    ? trend.ema20 > trend.ema50
    : trend.ema20 < trend.ema50;

  const trendScore =
    10 +
    (emaAligned ? 10 : 0) +
    (trend.adx >= 20 && directionalStrength ? 10 : 0);

  const setupScore = breakRetest
    ? 25
    : 15 + (nearStructure && touchedEma ? 10 : 0);

  const triggerScore = Math.min(
    25,
    (cross ? 10 : 0) +
    (rsiTurn ? 8 : 0) +
    (engulfing ? 7 : 0) +
    (rejection ? 5 : 0) +
    (emaTrigger ? 5 : 0) +
    (breakRetest ? 8 : 0)
  );

  const candleVolumeScore =
    last.volumeRatio >= 1.5 ? 10 :
    last.volumeRatio >= 1 ? 5 : 0;

  const rrScore = rr1 >= 2 ? 5 : rr1 >= 1.5 ? 3 : 0;

  const baseScore =
    trendScore + setupScore + triggerScore + candleVolumeScore + rrScore;

  const required = isLong
    ? (
        counterBTC
          ? CONFIG.MIN_LONG_SCORE_BEARISH
          : context.regime === 'NEUTRAL'
            ? CONFIG.MIN_LONG_SCORE_NEUTRAL
            : CONFIG.MIN_LONG_SCORE
      )
    : (
        counterBTC
          ? CONFIG.MIN_SHORT_SCORE_BULLISH
          : context.regime === 'NEUTRAL'
            ? CONFIG.MIN_SHORT_SCORE_NEUTRAL
            : CONFIG.MIN_SHORT_SCORE
      );

  const directionText = isLong ? 'صعودی' : 'نزولی';

  const triggerReasons = [
    cross ? `کراس ${directionText} MACD` : null,
    rsiTurn ? `چرخش ${directionText} RSI` : null,
    engulfing ? `پوشای ${directionText}` : null,
    rejection ? (isLong ? 'چکش صعودی' : 'ستاره ثاقب نزولی') : null,
    emaTrigger ? (isLong ? 'بازپس‌گیری EMA9' : 'از دست رفتن EMA9') : null,
  ].filter(Boolean);

  const setupReason = breakRetest
    ? isLong
      ? 'شکست مقاومت و بازآزمایی'
      : 'شکست حمایت و بازآزمایی از پایین'
    : isLong
      ? 'پولبک و برگشت از حمایت'
      : 'پولبک و برگشت نزولی از مقاومت';

  const reasons = [
    setupReason,
    triggerReasons.slice(0, 2).join(' + ') || 'کندل تأیید بازآزمایی',
    last.volumeRatio >= 1
      ? `حجم ${fmt(last.volumeRatio, 1)} برابر میانگین قبلی`
      : `روند 4H مطابق فیلتر ${directionText}`,
  ];

  const tp1 = targets[0]?.price ?? null;
  const tp2 = targets[1]?.price ?? null;
  const tp3 = targets[2]?.price ?? null;

  return {
    symbol: market.symbol,
    contract: market.symbol,
    side,
    setup,
    status: `${side}_ENTRY`,
    statusLabel: `${isLong ? 'لانگ' : 'شورت'}؛ ${setupReason}`,

    price,
    entryLow,
    entryHigh,
    referenceEntry,
    entry: { low: entryLow, high: entryHigh, price },

    stopLoss,
    stopLossPct: round(directionalPct(side, referenceEntry, stopLoss)),

    tp1,
    tp2,
    tp3,
    tp1Pct: round(directionalPct(side, referenceEntry, tp1)),
    tp2Pct: round(directionalPct(side, referenceEntry, tp2)),
    tp3Pct: round(directionalPct(side, referenceEntry, tp3)),
    takeProfits: targets,
    targetCount: targets.length,

    riskRewardToTp1: round(rr1),
    riskRewardToTp2: round(rr2),
    rr: round(finalRR),

    rsi15: round(last.rsi, 1),
    rsi4h: round(trend.rsi, 1),
    fundingRate: funding,
    change24h: num(market.ticker.change_percentage),
    quoteVolume24h: num(market.ticker.volume_24h_quote),

    triggerCandleTime: new Date(last.time * 1000).toISOString(),
    analyzedAt: new Date(context.asOf * 1000).toISOString(),

    validUntil: new Date(
      (last.time + 900 + CONFIG.ENTRY_VALID_MINUTES * 60) * 1000
    ).toISOString(),

    riskNote: counterBTC
      ? isLong
        ? 'BTC نزولی؛ لانگ خلاف جهت بازار و پرریسک‌تر است.'
        : 'BTC صعودی؛ شورت خلاف جهت بازار و پرریسک‌تر است.'
      : null,

    reasons,
    score: Math.round(baseScore),
    rankScore: Math.round(baseScore),

    scoreBreakdown: {
      trend: trendScore,
      setup: setupScore,
      trigger: triggerScore,
      candleVolume: candleVolumeScore,
      liveFlow: 0,
      firstTargetRR: rrScore,
    },

    costAssumptions: {
      feeRatePerSide: CONFIG.FEE_RATE_PER_SIDE,
      slippageRatePerSide: CONFIG.SLIPPAGE_RATE_PER_SIDE,
      fundingIncludedInRR: false,
    },

    _required: required,
  };
}

// ==================== Per-market scan ====================

function addNearMiss(context, item) {
  context.nearMisses.push({
    symbol: item.symbol,
    side: item.side,
    score: item.score,
    required: item._required,
    setup: item.setup,
    rsi15: item.rsi15,
    rr1: item.riskRewardToTp1,
    rr2: item.riskRewardToTp2,
    targetCount: item.targetCount,
    scoreBreakdown: item.scoreBreakdown,
    reasons: item.reasons,
  });
}

async function scanOneMarket(market, context) {
  const [raw15, raw4] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, {
      contract: market.symbol,
      interval: '15m',
      limit: CONFIG.CANDLES_15M_LIMIT,
    }),
    requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, {
      contract: market.symbol,
      interval: '4h',
      limit: CONFIG.CANDLES_4H_LIMIT,
    }),
  ]);

  const prepared = prepareAnalysis(raw15, raw4, context);

  if (prepared.error) return reject(context, prepared.error);

  const longCandidate = CONFIG.ENABLE_LONG
    ? analyzeDirection(market, prepared, context, 'LONG')
    : null;

  const shortCandidate = CONFIG.ENABLE_SHORT
    ? analyzeDirection(market, prepared, context, 'SHORT')
    : null;

  if (longCandidate && shortCandidate) {
    return reject(context, 'CONFLICTING_DIRECTIONS');
  }

  const candidate = longCandidate || shortCandidate;
  if (!candidate) return null;

  const hourStart = Math.floor(context.asOf / 3600) * 3600;

  const tradeFrom = Math.min(
    hourStart,
    Math.floor(context.asOf / 60) * 60 - 540
  );

  const [trades, candles1h, stats] = await Promise.all([
    optionalArrayRequest(
      `/futures/${CONFIG.SETTLE}/trades`,
      {
        contract: market.symbol,
        from: tradeFrom,
        to: Math.floor(context.asOf),
        limit: CONFIG.TRADE_LIMIT,
      },
      `${market.symbol} trades`
    ),
    optionalArrayRequest(
      `/futures/${CONFIG.SETTLE}/candlesticks`,
      {
        contract: market.symbol,
        interval: '1h',
        limit: CONFIG.HISTORY_HOURS + 2,
      },
      `${market.symbol} hourly candles`
    ),
    optionalArrayRequest(
      `/futures/${CONFIG.SETTLE}/contract_stats`,
      {
        contract: market.symbol,
        from: hourStart - CONFIG.HISTORY_HOURS * 3600,
        interval: '1h',
        limit: CONFIG.HISTORY_HOURS + 2,
      },
      `${market.symbol} contract stats`
    ),
  ]);

  const multiplier = num(market.contract.quanto_multiplier);

  const flow = aggregateTrades(
    trades, multiplier, tradeFrom, context.asOf
  );

  const hourly = buildHourlyContext(
    candles1h, stats, multiplier, context.asOf
  );

  const recent = flow.recent3m;
  const isLong = candidate.side === 'LONG';

  const liveConfirmed = flow.recentComplete && (
    isLong
      ? (
          recent.buyNotional >= CONFIG.MIN_RECENT_BUY_NOTIONAL &&
          recent.buySharePct >= 56 &&
          recent.netDelta > 0
        )
      : (
          recent.sellNotional >= CONFIG.MIN_RECENT_SELL_NOTIONAL &&
          recent.sellSharePct >= 56 &&
          recent.netDelta < 0
        )
  );

  const liveScore = liveConfirmed ? 5 : 0;

  candidate.score = Math.round(clamp(candidate.score + liveScore));
  candidate.rankScore = candidate.score;
  candidate.scoreBreakdown.liveFlow = liveScore;

  if (liveConfirmed) {
    candidate.reasons[2] = isLong
      ? `خرید تهاجمی ${fmt(recent.buySharePct, 0)}٪ در نمونه کامل ۳دقیقه`
      : `فروش تهاجمی ${fmt(recent.sellSharePct, 0)}٪ در نمونه کامل ۳دقیقه`;
  }

  if (candidate.score < candidate._required) {
    addNearMiss(context, candidate);
    return reject(context, 'SCORE_LOW', candidate.side);
  }

  candidate.grade =
    candidate.score >= 85 ? 'A+' :
    candidate.score >= 75 ? 'A' : 'B';

  candidate.currentHour = flow.currentHour;
  candidate.recent3m = flow.recent3m;
  candidate.hourlyHistory = hourly;

  candidate.volume = {
    currentHour: { ...flow.currentHour },
    recent3m: { ...flow.recent3m },
    hourlyHistory: { ...hourly },
  };

  candidate.tradesObserved = flow.validTrades;

  candidate.dataQuality = {
    currentHour: !flow.available
      ? 'UNAVAILABLE'
      : flow.currentHour.sampleTruncated
        ? 'TRUNCATED_RECENT_TRADE_SAMPLE'
        : 'RETURNED_RANGE_NOT_TRUNCATED',
    recent3mComplete: flow.recentComplete,
    hourlyDirectionalCoveragePct: hourly.directionalCoveragePct,
    targetSource: isLong
      ? 'HISTORICAL_PIVOT_RESISTANCE'
      : 'HISTORICAL_PIVOT_SUPPORT',
  };

  delete candidate._required;
  return candidate;
}

// ==================== Price revalidation ====================

async function revalidateCandidates(candidates, context) {
  if (!candidates.length) return [];

  if (Date.now() / 1000 - context.asOf > CONFIG.MAX_SCAN_AGE_SECONDS) {
    candidates.forEach(() => reject(context, 'SCAN_TOO_OLD'));
    return [];
  }

  try {
    const rows = requireArray(
      await requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
      'fresh tickers'
    );

    const map = new Map(
      rows.map(ticker => [ticker.contract, ticker])
    );

    const checkedAt = new Date().toISOString();

    return candidates.filter(item => {
      const price = num(map.get(item.symbol)?.last);

      if (Date.now() >= Date.parse(item.validUntil)) {
        reject(context, 'ENTRY_EXPIRED', item.side);
        return false;
      }

      if (
        !positive(price) ||
        price < item.entryLow ||
        price > item.entryHigh
      ) {
        reject(context, 'PRICE_LEFT_ENTRY_ZONE', item.side);
        return false;
      }

      item.lastCheckedPrice = price;
      item.priceCheckedAt = checkedAt;
      return true;
    });
  } catch (error) {
    console.error('[PRICE RECHECK]', error.message);
    candidates.forEach(() => reject(context, 'PRICE_RECHECK_FAILED'));
    return [];
  }
}

function rankCandidates(items) {
  return [...items]
    .sort((a, b) =>
      b.score - a.score ||
      b.riskRewardToTp1 - a.riskRewardToTp1 ||
      b.quoteVolume24h - a.quoteVolume24h
    )
    .map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
}

// ==================== Telegram reporting ====================

function reportLine(item, index) {
  const isLong = item.side === 'LONG';
  const icon = isLong ? '🟢' : '🔴';
  const entry = isLong ? item.entryHigh : item.entryLow;

  const targets = item.takeProfits.map(target =>
    `T${target.level}: ${fmtPrice(target.price)} ` +
    `(${directionalPctText(item.side, entry, target.price)})`
  ).join(' | ');

  const rrText = [
    `RR خالص تخمینی T1: ${fmt(item.riskRewardToTp1)}`,
    item.tp2 != null ? `T2: ${fmt(item.riskRewardToTp2)}` : null,
  ].filter(Boolean).join(' | ');

  const lines = [
    `${index + 1}. ${item.symbol} ${icon} ${item.side} | ${item.score}/100`,
    `ورود: ${fmtPrice(item.entryLow)} تا ${fmtPrice(item.entryHigh)}`,
    `حد ضرر: ${fmtPrice(item.stopLoss)} ` +
      `(${directionalPctText(item.side, entry, item.stopLoss)})`,
    `${isLong ? 'مقاومت‌های هدف' : 'حمایت‌های هدف'}: ${targets}`,
    rrText,
    `دلیل: ${item.reasons.slice(0, 3).join(' • ')}`,
    `اعتبار تا ${item.validUntil.slice(11, 16)} UTC؛ فقط داخل ناحیه ورود`,
  ];

  if (item.targetCount < 3) {
    lines.push(
      `هدف تاریخی شناسایی‌شده: ${item.targetCount} مورد؛ بقیه نامشخص.`
    );
  }

  if (item.riskNote) lines.push(`⚠️ ${item.riskNote}`);

  return lines.join('\n');
}

function buildReport(output) {
  const regimeText = {
    BULLISH: 'صعودی',
    BEARISH: 'نزولی',
    NEUTRAL: 'خنثی',
    UNKNOWN: 'داده نامعتبر/ناموجود',
  }[output.marketRegime];

  const lines = [
    '📊 Gate.io | فرصت‌های لانگ و شورت',
    `BTC 4H: ${regimeText} | حالت: ${CONFIG.MODE}`,
    `زمان: ${output.scannedAt}`,
    `بررسی: ${output.stats.scanned}/${output.stats.liquid} بازار | ` +
      `لانگ: ${output.stats.longCandidates} | شورت: ${output.stats.shortCandidates}`,
    `نمایش: ${output.candidates.length} فرصت برتر`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  if (!output.candidates.length) {
    lines.push(
      output.marketRegime === 'UNKNOWN'
        ? 'داده معتبر BTC در دسترس نیست؛ سیگنال صادر نشد.'
        : 'در این اسکن ورود مطابق شروط پیدا نشد.'
    );
  } else {
    output.candidates.forEach((item, index) => {
      lines.push(reportLine(item, index), '━━━━━━━━━━━━━━━━━━');
    });

    lines.push(
      'اهداف حمایت/مقاومت تاریخی‌اند، نه قیمت تضمینی.',
      'درصدها ناخالص و بدون اهرم از بدترین قیمت ورودند؛ RR با هزینه تخمینی و بدون فاندینگ است.',
      'امتیاز، احتمال موفقیت نیست؛ این برنامه سفارش اجرا نمی‌کند.'
    );
  }

  return lines.join('\n');
}

function splitTelegramMessage(message) {
  const chunks = [];
  let current = '';

  for (const line of message.split('\n')) {
    const pieces = [];

    for (let i = 0; i < line.length; i += CONFIG.TELEGRAM_MAX_LENGTH) {
      pieces.push(line.slice(i, i + CONFIG.TELEGRAM_MAX_LENGTH));
    }

    if (!pieces.length) pieces.push('');

    for (const piece of pieces) {
      const next = current ? `${current}\n${piece}` : piece;

      if (next.length > CONFIG.TELEGRAM_MAX_LENGTH) {
        if (current) chunks.push(current);
        current = piece;
      } else {
        current = next;
      }
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
    console.warn('[TELEGRAM] Credentials missing.');
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }

  const chunks = splitTelegramMessage(message);

  for (let index = 0; index < chunks.length; index++) {
    let response;

    try {
      response = await fetch(
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
    } catch {
      throw new Error(
        `Telegram network/timeout error on part ${index + 1}`
      );
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.description ||
        `Telegram HTTP ${response.status}, part ${index + 1}`
      );
    }

    await sleep(250);
  }

  return { sent: true, parts: chunks.length };
}

// ==================== Main scan ====================

async function runScan() {
  const started = Date.now();

  console.log('\n📊 GATE.IO LONG + SHORT — STRUCTURAL TARGETS');

  const { active, markets: liquidMarkets } = await getMarkets();

  const context = {
    asOf: Date.now() / 1000,
    regime: 'UNKNOWN',
    rejectStats: {
      LONG: {},
      SHORT: {},
      GLOBAL: {},
    },
    nearMisses: [],
  };

  context.regime = await getBtcRegime(context.asOf);
  const unknownBTC = context.regime === 'UNKNOWN';

  const limit = CONFIG.SCAN_LIMIT > 0
    ? CONFIG.SCAN_LIMIT
    : liquidMarkets.length;

  const markets = unknownBTC
    ? []
    : liquidMarkets.slice(0, limit);

  if (unknownBTC) {
    context.rejectStats.GLOBAL.BTC_DATA_UNKNOWN_SKIPPED =
      liquidMarkets.length;
  }

  const enabledSides = [
    CONFIG.ENABLE_LONG ? 'LONG' : null,
    CONFIG.ENABLE_SHORT ? 'SHORT' : null,
  ].filter(Boolean);

  console.log(
    `Active contracts: ${active.length} | ` +
    `Liquid markets: ${liquidMarkets.length} | ` +
    `Scanning: ${markets.length} | ` +
    `BTC regime: ${context.regime} | ` +
    `Mode: ${CONFIG.MODE} | Sides: ${enabledSides.join(' + ')}`
  );

  let completed = 0;

  const results = await mapPool(
    markets,
    CONFIG.CONCURRENCY,
    async market => {
      try {
        return await scanOneMarket(market, context);
      } finally {
        completed++;

        if (completed % 25 === 0 || completed === markets.length) {
          console.log(`[PROGRESS] ${completed}/${markets.length}`);
        }
      }
    }
  );

  const failed = results.filter(item => item?.__error).length;
  const success = results.length - failed;

  const initialCandidates = results.filter(
    item => item && !item.__error
  );

  const verified = await revalidateCandidates(
    initialCandidates,
    context
  );

  const rankedAll = rankCandidates(verified);
  const ranked = rankedAll.slice(0, CONFIG.TOP_COUNT);

  const nearMisses = [...context.nearMisses]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const longCount = rankedAll.filter(item => item.side === 'LONG').length;
  const shortCount = rankedAll.filter(item => item.side === 'SHORT').length;

  const output = {
    success: !unknownBTC && (markets.length === 0 || success > 0),
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategy: 'LONG + SHORT: 4H TREND + 15M SETUP + HISTORICAL LEVELS',
    marketRegime: context.regime,
    longMode: CONFIG.MODE,
    mode: CONFIG.MODE,
    sides: enabledSides,
    scannedAt: new Date().toISOString(),

    stats: {
      active: active.length,
      liquid: liquidMarkets.length,
      scanned: markets.length,
      success,
      failed,
      candidates: rankedAll.length,
      longCandidates: longCount,
      shortCandidates: shortCount,
      durationMs: Date.now() - started,
    },

    filterStats: {
      LONG: { ...context.rejectStats.LONG },
      SHORT: { ...context.rejectStats.SHORT },
      GLOBAL: { ...context.rejectStats.GLOBAL },
    },

    nearMisses,
    candidates: ranked,
    rankedCandidates: ranked,
  };

  if (markets.length > 0 && success > 0) {
    try {
      const stored = await saveMarketSnapshot(rankedAll);

      output.historyCount = stored?.historyCount ?? 0;
      output.summaryCount = stored?.summaryCount ?? rankedAll.length;
      output.rankChanges = stored?.rankChanges ?? {};
    } catch (error) {
      console.error(
        '[STORAGE] Snapshot save failed:',
        error?.message || error
      );
    }
  }

  console.log('[FILTER STATS]', JSON.stringify(output.filterStats));
  console.log('[NEAR MISSES]', JSON.stringify(nearMisses, null, 2));

  const report = buildReport(output);
  console.log(report);

  try {
    if (!ranked.length && !CONFIG.TELEGRAM_SEND_EMPTY) {
      output.telegram = {
        sent: false,
        reason: 'NO_ENTRY_CANDIDATES_SKIPPED',
      };
    } else {
      const staleReport = ranked.some(item =>
        Date.now() >= Date.parse(item.validUntil) ||
        Date.now() - Date.parse(item.priceCheckedAt) >
          CONFIG.MAX_QUOTE_AGE_SECONDS * 1000
      );

      if (staleReport) {
        output.telegram = {
          sent: false,
          reason: 'REPORT_EXPIRED_BEFORE_DELIVERY',
        };
      } else {
        output.telegram = await sendTelegram(report);
      }
    }
  } catch (error) {
    console.error('[TELEGRAM DELIVERY ERROR]', error.message);

    output.telegram = {
      sent: false,
      reason: error.message,
    };
  }

  output.stats.durationMs = Date.now() - started;

  console.log('[TELEGRAM RESULT]', JSON.stringify(output.telegram));

  console.log(
    `Finished in ${(output.stats.durationMs / 1000).toFixed(1)}s | ` +
    `scanned ${markets.length} | success ${success} | failed ${failed} | ` +
    `LONG ${longCount} | SHORT ${shortCount}`
  );

  return output;
}

export async function scanGateMarkets() {
  if (runningScan) return runningScan;

  runningScan = runScan();

  try {
    return await runningScan;
  } finally {
    runningScan = null;
  }
}

// Preserve the original import-to-run behavior used by src/index.js.
try {
  const result = await scanGateMarkets();

  console.log(
    '[SCANNER RESULT]',
    JSON.stringify(
      {
        success: result.success,
        active: result.stats.active,
        liquid: result.stats.liquid,
        scanned: result.stats.scanned,
        successful: result.stats.success,
        failed: result.stats.failed,
        candidates: result.stats.candidates,
        longCandidates: result.stats.longCandidates,
        shortCandidates: result.stats.shortCandidates,
        durationMs: result.stats.durationMs,
        filterStats: result.filterStats,
        nearMisses: result.nearMisses,
        telegramSent: result.telegram?.sent ?? false,
      },
      null,
      2
    )
  );

  if (!result.success) process.exitCode = 1;
} catch (error) {
  console.error('[SCANNER FATAL ERROR]', error?.stack || error);
  process.exitCode = 1;
}
```
