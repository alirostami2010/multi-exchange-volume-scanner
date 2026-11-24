
import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  round,
  requireArray,
} from '../services/gate.js';

export const STRATEGY_VERSION = 'gate-structural-ls-v1';

export const CONFIG = Object.freeze({
  MODE: 'BALANCED',
  ENABLE_LONG: true,
  ENABLE_SHORT: true,

  MIN_QUOTE_VOLUME_24H: 1000000,
  SCAN_LIMIT: 0,
  TOP_COUNT: 5,

  MIN_LONG_SCORE: 70,
  MIN_LONG_SCORE_NEUTRAL: 75,
  MIN_LONG_SCORE_BEARISH: 82,
  MIN_SHORT_SCORE: 70,
  MIN_SHORT_SCORE_NEUTRAL: 75,
  MIN_SHORT_SCORE_BULLISH: 82,

  CONCURRENCY: 5,
  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,
  MIN_CANDLES_15M: 220,
  MIN_CANDLES_4H: 250,
  TRADE_LIMIT: 1000,

  MIN_RECENT_BUY_NOTIONAL: 1500,
  MIN_RECENT_SELL_NOTIONAL: 1500,

  MAX_RSI_LONG_ENTRY: 70,
  MAX_RSI_LONG_4H: 75,
  MIN_RSI_SHORT_ENTRY: 30,
  MIN_RSI_SHORT_4H: 25,

  MAX_FUNDING_RATE_LONG: 0.001,
  MIN_FUNDING_RATE_SHORT: -0.001,

  MIN_RR_TP1: 1,
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

const mean = values =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function reject(context, reason, side = 'GLOBAL') {
  const group = context.rejectStats[side];
  group[reason] = (group[reason] || 0) + 1;
  return null;
}

function validSeries(candles, seconds, minimum, asOf) {
  if (candles.length < minimum) return false;

  const expected = Math.floor(asOf / seconds) * seconds - seconds;
  if (candles.at(-1).time !== expected) return false;

  const recent = candles.slice(-minimum);

  return recent.every((c, i) =>
    i === 0 || c.time - recent[i - 1].time === seconds
  );
}

function ema(values, period) {
  const alpha = 2 / (period + 1);
  let previous = values[0];

  return values.map((value, i) => {
    previous = i === 0
      ? value
      : alpha * value + (1 - alpha) * previous;
    return previous;
  });
}

function wilder(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let previous = mean(values.slice(0, period));
  out[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous = (previous * (period - 1) + values[i]) / period;
    out[i] = previous;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }

  gain /= period;
  loss /= period;

  const value = () =>
    gain === 0 && loss === 0
      ? 50
      : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  out[period] = value();

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = value();
  }
  return out;
}

function indicators(candles) {
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(macd, 9);
  const rs = rsi(closes);

  const tr = [];
  const plus = [];
  const minus = [];

  candles.forEach((c, i) => {
    const p = candles[i - 1];

    tr.push(p
      ? Math.max(
          c.high - c.low,
          Math.abs(c.high - p.close),
          Math.abs(c.low - p.close)
        )
      : c.high - c.low
    );

    const up = p ? c.high - p.high : 0;
    const down = p ? p.low - c.low : 0;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  });

  const atr = wilder(tr);
  const ps = wilder(plus);
  const ms = wilder(minus);
  const pdi = atr.map((a, i) => positive(a) ? 100 * ps[i] / a : null);
  const mdi = atr.map((a, i) => positive(a) ? 100 * ms[i] / a : null);

  const dx = atr.map((a, i) => {
    if (a == null) return null;
    const sum = (pdi[i]  0) + (mdi[i]  0);
    return sum > 0 ? 100 * Math.abs(pdi[i] - mdi[i]) / sum : 0;
  });

  const adx = new Array(candles.length).fill(null);
  const start = dx.findIndex(x => x != null);

  if (start >= 0) {
    wilder(dx.slice(start)).forEach((x, i) => {
      adx[start + i] = x;
    });
  }

  return candles.map((c, i) => {
    const previous = candles.slice(Math.max(0, i - 20), i);
    const quote = c.quoteTurnover != null && c.quoteTurnover >= 0 &&
      previous.every(x => x.quoteTurnover != null && x.quoteTurnover >= 0);

    const volumes = previous.map(x =>
      quote ? x.quoteTurnover : x.volumeContracts
    );

    const baseline = volumes.length === 20 &&
      volumes.every(x => x != null && x >= 0)
        ? mean(volumes)
        : null;

    const volume = quote ? c.quoteTurnover : c.volumeContracts;

    return {
      ...c,
      ema9: e9[i],
      ema20: e20[i],
      ema50: e50[i],
      ema200: e200[i],
      rsi: rs[i],
      macdHist: macd[i] - signal[i],
      atr: atr[i],
      adx: adx[i],
      plusDI: pdi[i],
      minusDI: mdi[i],
      volumeRatio: positive(baseline) && volume != null
        ? volume / baseline : null,
    };
  });
}

function engulfing(candles, long) {
  const l = candles.at(-1);
  const p = candles.at(-2);

  return long
    ? l.close > l.open && p.close < p.open &&
      l.close >= p.open && l.open <= p.close
    : l.close < l.open && p.close > p.open &&
      l.open >= p.close && l.close <= p.open;
}

function rejectionPattern(candles, long) {
  const l = candles.at(-1);
  const body = Math.abs(l.close - l.open);
  const range = l.high - l.low;
  if (!positive(body) || !positive(range)) return false;

  const lower = Math.min(l.open, l.close) - l.low;
  const upper = l.high - Math.max(l.open, l.close);

  return long
    ? l.close > l.open && lower >= body * 2 && upper <= body &&
      (l.close - l.low) / range >= 0.65
    : l.close < l.open && upper >= body * 2 && lower <= body &&
      (l.close - l.low) / range <= 0.35;
}

function targetZones(c15, c4, entry, atr, long) {
  const points = [];

  for (const [timeframe, candles] of [['15m', c15], ['4h', c4]]) {
    for (let i = 2; i < candles.length - 2; i++) {
      const price = long ? candles[i].high : candles[i].low;

      const confirmed = long
        ? price > candles[i - 1].high &&
          price > candles[i - 2].high &&
          price >= candles[i + 1].high &&
          price >= candles[i + 2].high
        : price < candles[i - 1].low &&
          price < candles[i - 2].low &&
          price <= candles[i + 1].low &&
          price <= candles[i + 2].low;

      if (confirmed) points.push({ price, timeframe });
    }
  }

  points.sort((a, b) => a.price - b.price);
  const zones = [];

  for (const point of points) {
    const last = zones.at(-1);
    const tolerance = Math.min(
      atr * CONFIG.LEVEL_CLUSTER_ATR, point.price * 0.003
    );

if (last && point.price - last.low <= tolerance) {
      last.high = Math.max(last.high, point.price);
      last.touches++;
      last.timeframes = [...new Set([...last.timeframes, point.timeframe])];
    } else {
      zones.push({
        low: point.price,
        high: point.price,
        touches: 1,
        timeframes: [point.timeframe],
      });
    }
  }

  return long
    ? zones.filter(z => z.high >= entry).sort((a, b) => a.low - b.low)
    : zones.filter(z => z.low <= entry).sort((a, b) => b.high - a.high);
}

function rr(long, entry, stop, target) {
  const cost = CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE;
  const risk = (long ? entry - stop : stop - entry) + (entry + stop) * cost;
  const reward = (long ? target - entry : entry - target) -
    (entry + target) * cost;
  return risk > 0 ? reward / risk : null;
}

function analyze(market, c15, c4, context, side) {
  const long = side === 'LONG';
  const fail = reason => reject(context, reason, side);
  const opposite = long
    ? context.regime === 'BEARISH'
    : context.regime === 'BULLISH';

  if (CONFIG.MODE === 'STRICT' && opposite) return fail('BTC_OPPOSITE_STRICT');

  const l = c15.at(-1);
  const p = c15.at(-2);
  const t = c4.at(-1);
  const price = number(market.ticker.last);
  const atr = l.atr;

  if (
    !positive(price)  !positive(atr) 
    ![l.rsi, p.rsi, t.rsi, t.adx, t.plusDI, t.minusDI].every(Number.isFinite)
  ) return fail('BAD_PRICE_OR_INDICATOR');

  const trend = long
    ? t.close > t.ema50 && t.ema50 > t.ema200
    : t.close < t.ema50 && t.ema50 < t.ema200;

  if (!trend) return fail('COIN_4H_TREND');

  if (long && (
    l.rsi > CONFIG.MAX_RSI_LONG_ENTRY || t.rsi > CONFIG.MAX_RSI_LONG_4H
  )) return fail('RSI_OVERBOUGHT');

  if (!long && (
    l.rsi < CONFIG.MIN_RSI_SHORT_ENTRY || t.rsi < CONFIG.MIN_RSI_SHORT_4H
  )) return fail('RSI_OVERSOLD');

  const drift = Math.abs(price - l.close);

  if (
    drift > atr * CONFIG.MAX_TRIGGER_DRIFT_ATR ||
    drift / l.close * 100 > CONFIG.MAX_TRIGGER_DRIFT_PCT
  ) return fail('PRICE_MOVED_AWAY_FROM_TRIGGER');

  if (
    (long ? price - l.ema20 : l.ema20 - price) >
    atr * CONFIG.MAX_DISTANCE_EMA_ATR
  ) return fail('PRICE_CHASING');

  const funding = number(market.contract.funding_rate) ??
    number(market.ticker.funding_rate);

  if (funding == null) return fail('FUNDING_UNKNOWN');

  if (
    (long && funding > CONFIG.MAX_FUNDING_RATE_LONG) ||
    (!long && funding < CONFIG.MIN_FUNDING_RATE_SHORT)
  ) return fail('FUNDING_CROWDED');

  const previous = c15.slice(-41, -1);
  const structure = long
    ? Math.min(...previous.map(c => c.low))
    : Math.max(...previous.map(c => c.high));

  if (long
    ? price <= structure || l.close <= structure
    : price >= structure || l.close >= structure
  ) return fail(long ? 'SUPPORT_BROKEN' : 'RESISTANCE_BROKEN');

  const near = long
    ? Math.abs(l.low - structure) <= atr * 0.6 && l.close > structure
    : Math.abs(l.high - structure) <= atr * 0.6 && l.close < structure;

  const emaTouch = long
    ? l.low <= l.ema20 + atr * 0.25 &&
      l.high >= l.ema20 - atr * 0.25 && l.close >= l.ema20
    : l.high >= l.ema20 - atr * 0.25 &&
      l.low <= l.ema20 + atr * 0.25 && l.close <= l.ema20;

  const correction = c15.slice(-5, -1).some(c =>
    long ? c.close < c.ema20 || c.close < c.open
      : c.close > c.ema20 || c.close > c.open
  );

  const directionalCandle = long
    ? l.close > l.open && l.close > p.close
    : l.close < l.open && l.close < p.close;

  const pullback = correction && (near || emaTouch) && directionalCandle;
  const beforeBreak = c15.slice(-42, -2);

  const level = long
    ? Math.max(...beforeBreak.map(c => c.high))
    : Math.min(...beforeBreak.map(c => c.low));

  const retest = p.volumeRatio != null && p.volumeRatio >= 1.3 && (

long
      ? p.close > level && p.close - level <= atr &&
        l.low >= level - atr * 0.5 && l.low <= level + atr * 0.35 &&
        l.close > level && l.close > l.open &&
        price >= level && price - level <= atr
      : p.close < level && level - p.close <= atr &&
        l.high <= level + atr * 0.5 && l.high >= level - atr * 0.35 &&
        l.close < level && l.close < l.open &&
        price <= level && level - price <= atr
  );

  if (!pullback && !retest) return fail('NO_VALID_SETUP');

  const cross = long
    ? p.macdHist <= 0 && l.macdHist > 0
    : p.macdHist >= 0 && l.macdHist < 0;

  const rsiTurn = long
    ? l.rsi >= 35 && l.rsi <= 60 && l.rsi >= p.rsi + 2
    : l.rsi >= 40 && l.rsi <= 65 && l.rsi <= p.rsi - 2;

  const engulf = engulfing(c15, long);
  const rejection = rejectionPattern(c15, long);

  const emaTrigger = long
    ? p.close <= p.ema9 && l.close > l.ema9 && l.close > l.open
    : p.close >= p.ema9 && l.close < l.ema9 && l.close < l.open;

  if (!(cross  rsiTurn  engulf  rejection  emaTrigger || retest)) {
    return fail('NO_15M_TRIGGER');
  }

  let stopStructure;

  if (retest) {
    stopStructure = long ? Math.min(l.low, level) : Math.max(l.high, level);
  } else if (near) {
    stopStructure = long
      ? Math.min(structure, l.low)
      : Math.max(structure, l.high);
  } else {
    stopStructure = long
      ? Math.min(...c15.slice(-5).map(c => c.low))
      : Math.max(...c15.slice(-5).map(c => c.high));
  }

  const stop = stopStructure + (long ? -1 : 1) * atr * CONFIG.STOP_ATR_BUFFER;
  const width = Math.min(
    atr * CONFIG.ENTRY_ZONE_ATR,
    price * CONFIG.MAX_ENTRY_ZONE_PCT / 100
  );

  const entryLow = price - width;
  const entryHigh = price + width;
  const entry = long ? entryHigh : entryLow;
  const risk = long ? entry - stop : stop - entry;

  if (
    !positive(stop)  !positive(entryLow) 
    (long ? stop >= entryLow : stop <= entryHigh) ||
    risk < atr * CONFIG.MIN_STOP_ATR ||
    risk > atr * CONFIG.MAX_STOP_ATR ||
    risk / entry * 100 > CONFIG.MAX_STOP_PCT
  ) return fail('BAD_RISK');

  const zones = targetZones(c15, c4, entry, atr, long);
  if (!zones.length) return fail('NO_HISTORICAL_TARGET');

  if (long ? zones[0].low <= entry : zones[0].high >= entry) {
    return fail(long ? 'ENTRY_INSIDE_RESISTANCE' : 'ENTRY_INSIDE_SUPPORT');
  }

  const targets = zones.slice(0, 3).map((z, i) => {
    const target = long ? z.low : z.high;
    return {
      level: i + 1,
      price: target,
      zoneLow: z.low,
      zoneHigh: z.high,
      source: long ? 'HISTORICAL_PIVOT_RESISTANCE' : 'HISTORICAL_PIVOT_SUPPORT',
      timeframes: z.timeframes,
      touches: z.touches,
      pct: round((long ? target - entry : entry - target) / entry * 100),
      rrNet: round(rr(long, entry, stop, target)),
    };
  });

  const rr1 = rr(long, entry, stop, targets[0].price);
  const rr2 = targets[1] ? rr(long, entry, stop, targets[1].price) : null;

  if (
    !Number.isFinite(rr1)  rr1 < CONFIG.MIN_RR_TP1 
    (rr2 != null && rr2 < CONFIG.MIN_RR_TP2) ||
    (rr2 == null && rr1 < CONFIG.MIN_SINGLE_TARGET_RR)
  ) return fail('LOW_RR_AT_NEAREST_LEVEL');

  const strength = long ? t.plusDI > t.minusDI : t.minusDI > t.plusDI;

  if (
    opposite &&
    (t.adx < 25  !strength  (rr2 ?? rr1) < CONFIG.MIN_COUNTER_BTC_RR)
  ) return fail('COUNTER_BTC_WEAK_SETUP');

  const trendScore = 10 +
    ((long ? t.ema20 > t.ema50 : t.ema20 < t.ema50) ? 10 : 0) +
    (t.adx >= 20 && strength ? 10 : 0);

  const setupScore = retest ? 25 : 15 + (near && emaTouch ? 10 : 0);

  const triggerScore = Math.min(
    25,
    (cross ? 10 : 0) + (rsiTurn ? 8 : 0) + (engulf ? 7 : 0) +
    (rejection ? 5 : 0) + (emaTrigger ? 5 : 0) + (retest ? 8 : 0)
  );

  const volumeScore = l.volumeRatio >= 1.5 ? 10 : l.volumeRatio >= 1 ? 5 : 0;
  const rrScore = rr1 >= 2 ? 5 : rr1 >= 1.5 ? 3 : 0;

const required = long
    ? opposite ? CONFIG.MIN_LONG_SCORE_BEARISH
      : context.regime === 'NEUTRAL' ? CONFIG.MIN_LONG_SCORE_NEUTRAL
        : CONFIG.MIN_LONG_SCORE
    : opposite ? CONFIG.MIN_SHORT_SCORE_BULLISH
      : context.regime === 'NEUTRAL' ? CONFIG.MIN_SHORT_SCORE_NEUTRAL
        : CONFIG.MIN_SHORT_SCORE;

  const setup = retest
    ? long ? 'BreakoutRetest' : 'BreakdownRetest'
    : 'Pullback';

  const direction = long ? 'صعودی' : 'نزولی';
  const triggerReasons = [
    cross ? 'کراس ' + direction + ' MACD' : null,
    rsiTurn ? 'چرخش ' + direction + ' RSI' : null,
    engulf ? 'پوشای ' + direction : null,
    rejection ? 'کندل برگشتی ' + direction : null,
    emaTrigger ? 'تأیید EMA9' : null,
  ].filter(Boolean);

  const score = trendScore + setupScore + triggerScore + volumeScore + rrScore;

  return {
    symbol: market.symbol,
    contract: market.symbol,
    side,
    setup,
    strategyVersion: STRATEGY_VERSION,
    status: side + '_ENTRY',
    statusLabel: side + ' ' + setup,
    price,
    entryLow,
    entryHigh,
    referenceEntry: entry,
    entry: { low: entryLow, high: entryHigh, price },
    stopLoss: stop,
    stopLossPct: round(-risk / entry * 100),
    tp1: targets[0]?.price ?? null,
    tp2: targets[1]?.price ?? null,
    tp3: targets[2]?.price ?? null,
    tp1Pct: targets[0]?.pct ?? null,
    tp2Pct: targets[1]?.pct ?? null,
    tp3Pct: targets[2]?.pct ?? null,
    takeProfits: targets,
    targetCount: targets.length,
    riskRewardToTp1: round(rr1),
    riskRewardToTp2: round(rr2),
    rr: round(rr2 ?? rr1),
    rsi15: round(l.rsi, 1),
    rsi4h: round(t.rsi, 1),
    fundingRate: funding,
    change24h: number(market.ticker.change_percentage),
    quoteVolume24h: number(market.ticker.volume_24h_quote),
    triggerCandleTime: new Date(l.time * 1000).toISOString(),
    analyzedAt: new Date(context.asOf * 1000).toISOString(),
    validUntil: new Date(
      (l.time + 900 + CONFIG.ENTRY_VALID_MINUTES * 60) * 1000
    ).toISOString(),
    riskNote: opposite ? 'جهت معامله خلاف رژیم BTC است؛ ریسک بیشتر.' : null,
    reasons: [
      retest
        ? long ? 'شکست مقاومت و بازآزمایی' : 'شکست حمایت و بازآزمایی'
        : long ? 'پولبک و برگشت از حمایت' : 'پولبک و برگشت از مقاومت',
      triggerReasons.slice(0, 2).join(' + ') || 'تأیید بازآزمایی',
      l.volumeRatio >= 1
        ? 'حجم ' + l.volumeRatio.toFixed(1) + ' برابر میانگین'
        : 'روند 4H ' + direction,
    ],
    score,
    rankScore: score,
    scoreBreakdown: {
      trend: trendScore,
      setup: setupScore,
      trigger: triggerScore,
      candleVolume: volumeScore,
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

async function flowConfirmation(market, context) {
  const end = Math.floor(context.asOf / 60) * 60;
  const from = Math.min(Math.floor(context.asOf / 3600) * 3600, end - 540);

  try {
    const rows = requireArray(await requestGate('trades', {
      contract: market.symbol,
      from,
      to: Math.floor(context.asOf),
      limit: CONFIG.TRADE_LIMIT,
    }), 'trades');

    let invalid = false;
    const seen = new Set();
    const trades = [];

    for (const raw of rows) {
      const ms = number(raw.create_time_ms);
      const time = positive(ms) ? ms / 1000 : number(raw.create_time);
      const size = number(raw.size);
      const price = number(raw.price);

      if (!positive(time)  size == null  !positive(price)) {
        invalid = true;
        continue;
      }

      if (raw.id != null) {
        const id = String(raw.id);
        if (seen.has(id)) continue;
        seen.add(id);
      }

      if (time < from || time > context.asOf) continue;

      trades.push({
        time,
        size,
        notional: Math.abs(size) *
          Number(market.contract.quanto_multiplier) * price,
      });
    }

const truncated = rows.length >= CONFIG.TRADE_LIMIT;
    const oldest = trades.length ? Math.min(...trades.map(x => x.time)) : null;

    const complete = !invalid &&
      (!truncated || (oldest != null && oldest <= end - 180));

    const recent = trades.filter(x => x.time >= end - 180 && x.time < end);
    const buy = recent.filter(x => x.size > 0).reduce((s, x) => s + x.notional, 0);
    const sell = recent.filter(x => x.size < 0).reduce((s, x) => s + x.notional, 0);
    const total = buy + sell;

    return {
      sampleComplete: complete,
      sampleTruncated: truncated,
      tradesObserved: trades.length,
      buyNotional: round(buy),
      sellNotional: round(sell),
      buySharePct: total > 0 ? 100 * buy / total : null,
      sellSharePct: total > 0 ? 100 * sell / total : null,
      netDelta: buy - sell,
      windowEnd: new Date(end * 1000).toISOString(),
    };
  } catch (error) {
    console.warn('[OPTIONAL FLOW]', market.symbol, error.message);
    return { sampleComplete: false, available: false };
  }
}

async function btcRegime(asOf) {
  try {
    const raw = await requestGate('candlesticks', {
      contract: 'BTC_USDT',
      interval: '4h',
      limit: CONFIG.CANDLES_4H_LIMIT,
    });

    const candles = closedCandles(raw, 14400, asOf);
    if (!validSeries(candles, 14400, CONFIG.MIN_CANDLES_4H, asOf)) {
      throw new Error('Invalid BTC candle series');
    }

    const l = indicators(candles).at(-1);
    if (l.close > l.ema50 && l.ema50 > l.ema200) return 'BULLISH';
    if (l.close < l.ema50 && l.ema50 < l.ema200) return 'BEARISH';
    return 'NEUTRAL';
  } catch (error) {
    console.error('[BTC]', error.message);
    return 'UNKNOWN';
  }
}

async function scanOne(market, context) {
  const [raw15, raw4] = await Promise.all([
    requestGate('candlesticks', {
      contract: market.symbol, interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT,
    }),
    requestGate('candlesticks', {
      contract: market.symbol, interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT,
    }),
  ]);

  const c15raw = closedCandles(raw15, 900, context.asOf);
  const c4raw = closedCandles(raw4, 14400, context.asOf);

  if (
    c15raw.length < CONFIG.MIN_CANDLES_15M ||
    c4raw.length < CONFIG.MIN_CANDLES_4H
  ) return reject(context, 'INSUFFICIENT_CANDLES');

  if (
    !validSeries(c15raw, 900, CONFIG.MIN_CANDLES_15M, context.asOf) ||
    !validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, context.asOf)
  ) return reject(context, 'STALE_OR_GAPPED_CANDLES');

  const c15 = indicators(c15raw);
  const c4 = indicators(c4raw);

  const long = CONFIG.ENABLE_LONG ? analyze(market, c15, c4, context, 'LONG') : null;
  const short = CONFIG.ENABLE_SHORT ? analyze(market, c15, c4, context, 'SHORT') : null;

  if (long && short) return reject(context, 'CONFLICTING_DIRECTIONS');

  const candidate = long || short;
  if (!candidate) return null;

  const flow = await flowConfirmation(market, context);
  const longSide = candidate.side === 'LONG';

  const confirmed = flow.sampleComplete && (
    longSide
      ? flow.buyNotional >= CONFIG.MIN_RECENT_BUY_NOTIONAL &&
        flow.buySharePct >= 56 && flow.netDelta > 0
      : flow.sellNotional >= CONFIG.MIN_RECENT_SELL_NOTIONAL &&
        flow.sellSharePct >= 56 && flow.netDelta < 0
  );

  candidate.score += confirmed ? 5 : 0;
  candidate.rankScore = candidate.score;
  candidate.scoreBreakdown.liveFlow = confirmed ? 5 : 0;

  if (candidate.score < candidate._required) {
    context.nearMisses.push({
      symbol: candidate.symbol,
      side: candidate.side,
      score: candidate.score,
      required: candidate._required,
      scoreBreakdown: candidate.scoreBreakdown,
    });
    return reject(context, 'SCORE_LOW', candidate.side);
  }

  candidate.grade = candidate.score >= 85 ? 'A+' : candidate.score >= 75 ? 'A' : 'B';
  candidate.recent3m = flow;
  candidate.volume = { recent3m: flow };
  candidate.dataQuality = { recent3mComplete: flow.sampleComplete };
  candidate.tradesObserved = flow.tradesObserved || 0;
  delete candidate._required;

  return candidate;
}

export async function scanGateMarkets() {
  const started = Date.now();

  const [contractsRaw, tickersRaw] = await Promise.all([
    requestGate('contracts'),
    requestGate('tickers'),
  ]);

  const contracts = requireArray(contractsRaw, 'contracts');
  const tickers = requireArray(tickersRaw, 'tickers');
  const tickerMap = new Map(tickers.map(t => [t.contract, t]));

  const active = contracts.filter(c =>
    typeof c.name === 'string' &&
    c.name.endsWith('_USDT') &&
    c.status === 'trading' &&
    c.in_delisting === false &&
    positive(number(c.quanto_multiplier))
  );

  const liquid = active.map(contract => {
    const ticker = tickerMap.get(contract.name);
    const volume = number(ticker?.volume_24h_quote);

    return positive(number(ticker?.last)) &&
      volume >= CONFIG.MIN_QUOTE_VOLUME_24H
      ? { symbol: contract.name, contract, ticker, volume }
      : null;
  }).filter(Boolean).sort((a, b) => b.volume - a.volume);

  const context = {
    asOf: Date.now() / 1000,
    regime: 'UNKNOWN',
    rejectStats: { LONG: {}, SHORT: {}, GLOBAL: {} },
    nearMisses: [],
  };

  context.regime = await btcRegime(context.asOf);

  const markets = context.regime === 'UNKNOWN'
    ? []
    : CONFIG.SCAN_LIMIT > 0 ? liquid.slice(0, CONFIG.SCAN_LIMIT) : liquid;

  console.log(
    '[SCAN] Active: ' + active.length + ' | Liquid: ' + liquid.length +
    ' | Scanning: ' + markets.length + ' | BTC: ' + context.regime
  );

  let completed = 0;

  const results = await mapPool(markets, CONFIG.CONCURRENCY, async market => {
    try {
      return await scanOne(market, context);
    } finally {
      completed++;
      if (completed % 25 === 0 || completed === markets.length) {
        console.log('[PROGRESS] ' + completed + '/' + markets.length);
      }
    }
  });

  const failed = results.filter(x => x?.__error).length;
  let candidates = results.filter(x => x && !x.__error);

  if (candidates.length) {
    if (Date.now() / 1000 - context.asOf > CONFIG.MAX_SCAN_AGE_SECONDS) {
      candidates.forEach(() => reject(context, 'SCAN_TOO_OLD'));
      candidates = [];
    } else {
      try {
        const fresh = requireArray(await requestGate('tickers'), 'fresh tickers');
        const map = new Map(fresh.map(t => [t.contract, t]));
        const checkedAt = new Date().toISOString();

        candidates = candidates.filter(c => {
          const price = number(map.get(c.symbol)?.last);

          if (Date.now() >= Date.parse(c.validUntil)) {
            reject(context, 'ENTRY_EXPIRED', c.side);
            return false;
          }

          if (!positive(price)  price < c.entryLow  price > c.entryHigh) {
            reject(context, 'PRICE_LEFT_ENTRY_ZONE', c.side);
            return false;
          }

          c.lastCheckedPrice = price;
          c.priceCheckedAt = checkedAt;
          return true;
        });
      } catch (error) {
        console.error('[REVALIDATION]', error.message);
        candidates = [];
      }
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score ||
    b.riskRewardToTp1 - a.riskRewardToTp1 ||
    b.quoteVolume24h - a.quoteVolume24h
  );

  candidates = candidates.map((c, i) => ({ ...c, rank: i + 1 }));

  const output = {
    success: context.regime !== 'UNKNOWN' &&
      (markets.length === 0 || failed < markets.length),
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategyVersion: STRATEGY_VERSION,
    strategyConfig: CONFIG,
    marketRegime: context.regime,
    scannedAt: new Date().toISOString(),
    candidates: candidates.slice(0, CONFIG.TOP_COUNT),
    rankedCandidates: candidates,
    filterStats: context.rejectStats,
    nearMisses: context.nearMisses.sort((a, b) => b.score - a.score).slice(0, 5),
    stats: {
      active: active.length,
      liquid: liquid.length,

scanned: markets.length,
      success: markets.length - failed,
      failed,
      candidates: candidates.length,
      longCandidates: candidates.filter(c => c.side === 'LONG').length,
      shortCandidates: candidates.filter(c => c.side === 'SHORT').length,
      durationMs: Date.now() - started,
    },
  };

  console.log('[FILTER STATS]', JSON.stringify(output.filterStats));
  console.log('[NEAR MISSES]', JSON.stringify(output.nearMisses));
  return output;
}
