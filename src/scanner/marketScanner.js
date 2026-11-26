import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  round,
  requireArray,
} from '../services/gate.js';

export const STRATEGY_VERSION = 'gate-structural-ls-v3-pro';

export const CONFIG = Object.freeze({
  MODE: 'BALANCED',
  ENABLE_LONG: true,
  ENABLE_SHORT: true,

  MIN_QUOTE_VOLUME_24H: 1000000,
  SCAN_LIMIT: 0,
  TOP_COUNT: 5,

  // امتیازهای بهینه‌شده برای شکار موقعیت‌های اول حرکت
  MIN_LONG_SCORE: 65,
  MIN_LONG_SCORE_NEUTRAL: 70,
  MIN_LONG_SCORE_BEARISH: 78,

  MIN_SHORT_SCORE: 65,
  MIN_SHORT_SCORE_NEUTRAL: 70,
  MIN_SHORT_SCORE_BULLISH: 78,

  CONCURRENCY: 6,

  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,
  MIN_CANDLES_15M: 220,
  MIN_CANDLES_4H: 200,

  TRADE_LIMIT: 1000,
  MIN_RECENT_BUY_NOTIONAL: 1200,
  MIN_RECENT_SELL_NOTIONAL: 1200,

  MAX_RSI_LONG_ENTRY: 68,
  MAX_RSI_LONG_4H: 74,
  MIN_RSI_SHORT_ENTRY: 32,
  MIN_RSI_SHORT_4H: 26,

  MAX_FUNDING_RATE_LONG: 0.001,
  MIN_FUNDING_RATE_SHORT: -0.001,

  MIN_RR_TP1: 1.0,
  MIN_RR_TP2: 1.7,
  MIN_SINGLE_TARGET_RR: 1.6,
  MIN_COUNTER_BTC_RR: 2.0,

  STOP_ATR_BUFFER: 0.45,
  MIN_STOP_ATR: 0.7,
  MAX_STOP_ATR: 4.5,
  MAX_STOP_PCT: 5.5,

  // جلوگیری از ورود دیرهنگام در سقف قیمت
  MAX_DISTANCE_EMA_ATR: 1.6,
  MAX_TRIGGER_DRIFT_ATR: 0.85,
  MAX_TRIGGER_DRIFT_PCT: 2.2,

  // محدوده ورود استاندارد برای جلوگیری از سوختن سیگنال در لحظه آخر
  ENTRY_ZONE_ATR: 0.45,
  MAX_ENTRY_ZONE_PCT: 0.8,
  ENTRY_VALID_MINUTES: 30,

  FEE_RATE_PER_SIDE: 0.0006,
  SLIPPAGE_RATE_PER_SIDE: 0.0003,

  MAX_SCAN_AGE_SECONDS: 240,
  MAX_QUOTE_AGE_SECONDS: 60,
  LEVEL_CLUSTER_ATR: 0.25,
});

const any = values => values.some(Boolean);

const mean = values => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

function reject(context, reason, side = 'GLOBAL') {
  const group = context.rejectStats[side];
  group[reason] = (group[reason] ?? 0) + 1;
  return null;
}

// ==================== Candle validation ====================

function validSeries(candles, seconds, minimum, asOf) {
  if (candles.length < minimum) return false;

  const expected = Math.floor(asOf / seconds) * seconds - seconds;
  if (candles.at(-1).time !== expected) return false;

  const recent = candles.slice(-minimum);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].time - recent[i - 1].time !== seconds) {
      return false;
    }
  }
  return true;
}

// ==================== Indicators ====================

function ema(values, period) {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  let previous = values[0];

  return values.map((value, index) => {
    if (index === 0) {
      previous = value;
    } else {
      previous = alpha * value + (1 - alpha) * previous;
    }
    return previous;
  });
}

function wilder(values, period = 14) {
  const output = new Array(values.length).fill(null);
  if (values.length < period) return output;

  let previous = mean(values.slice(0, period));
  output[period - 1] = previous;

  for (let i = period; i < values.length; i++) {
    previous = (previous * (period - 1) + values[i]) / period;
    output[i] = previous;
  }
  return output;
}

function rsi(closes, period = 14) {
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

  function currentValue() {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  output[period] = currentValue();

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    output[i] = currentValue();
  }

  return output;
}

function indicators(candles) {
  if (candles.length === 0) return [];

  const closes = candles.map(candle => candle.close);

  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);

  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);

  const macd = closes.map((value, index) => e12[index] - e26[index]);
  const signal = ema(macd, 9);
  const rsiValues = rsi(closes);

  const trueRanges = [];
  const plusMoves = [];
  const minusMoves = [];

  candles.forEach((candle, index) => {
    const previous = candles[index - 1];

    if (previous) {
      trueRanges.push(
        Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previous.close),
          Math.abs(candle.low - previous.close)
        )
      );
    } else {
      trueRanges.push(candle.high - candle.low);
    }

    const up = previous ? candle.high - previous.high : 0;
    const down = previous ? previous.low - candle.low : 0;

    plusMoves.push(up > down && up > 0 ? up : 0);
    minusMoves.push(down > up && down > 0 ? down : 0);
  });

  const atrValues = wilder(trueRanges);
  const plusSmoothed = wilder(plusMoves);
  const minusSmoothed = wilder(minusMoves);

  const pdi = atrValues.map((atr, index) =>
    positive(atr) ? (100 * plusSmoothed[index]) / atr : null
  );

  const mdi = atrValues.map((atr, index) =>
    positive(atr) ? (100 * minusSmoothed[index]) / atr : null
  );

  const dx = atrValues.map((atr, index) => {
    if (atr == null) return null;
    const positiveDI = Number.isFinite(pdi[index]) ? pdi[index] : 0;
    const negativeDI = Number.isFinite(mdi[index]) ? mdi[index] : 0;
    const totalDI = positiveDI + negativeDI;
    if (totalDI <= 0) return 0;
    return (100 * Math.abs(positiveDI - negativeDI)) / totalDI;
  });

  const adxValues = new Array(candles.length).fill(null);
  const start = dx.findIndex(value => value != null);

  if (start >= 0) {
    const smoothedDX = wilder(dx.slice(start));
    smoothedDX.forEach((value, index) => {
      adxValues[start + index] = value;
    });
  }

  return candles.map((candle, index) => {
    const previous = candles.slice(Math.max(0, index - 20), index);

    const quoteAvailable =
      candle.quoteTurnover != null &&
      candle.quoteTurnover >= 0 &&
      previous.every(item => item.quoteTurnover != null && item.quoteTurnover >= 0);

    const volumes = previous.map(item =>
      quoteAvailable ? item.quoteTurnover : item.volumeContracts
    );

    const baseline =
      volumes.length === 20 && volumes.every(value => value != null && value >= 0)
        ? mean(volumes)
        : null;

    const volume = quoteAvailable ? candle.quoteTurnover : candle.volumeContracts;

    const volumeRatio =
      positive(baseline) && volume != null ? volume / baseline : null;

    return {
      ...candle,
      ema9: e9[index],
      ema20: e20[index],
      ema50: e50[index],
      ema200: e200[index],
      rsi: rsiValues[index],
      macdHist: macd[index] - signal[index],
      atr: atrValues[index],
      adx: adxValues[index],
      plusDI: pdi[index],
      minusDI: mdi[index],
      volumeRatio,
    };
  });
}

// ==================== Candle patterns ====================

function engulfing(candles, longSide) {
  const last = candles.at(-1);
  const previous = candles.at(-2);

  if (longSide) {
    return (
      last.close > last.open &&
      previous.close < previous.open &&
      last.close >= previous.open &&
      last.open <= previous.close
    );
  }

  return (
    last.close < last.open &&
    previous.close > previous.open &&
    last.open >= previous.close &&
    last.close <= previous.open
  );
}

function rejectionPattern(candles, longSide) {
  const last = candles.at(-1);
  const range = last.high - last.low;

  if (!positive(range)) return false;

  const lower = Math.min(last.open, last.close) - last.low;
  const upper = last.high - Math.max(last.open, last.close);

  if (longSide) {
    return (
      lower >= range * 0.45 &&
      (last.close - last.low) / range >= 0.6
    );
  }

  return (
    upper >= range * 0.45 &&
    (last.close - last.low) / range <= 0.4
  );
}

// ==================== Historical target zones ====================

function targetZones(c15, c4, entry, atr, longSide) {
  const points = [];

  for (const [timeframe, candles] of [
    ['15m', c15],
    ['4h', c4],
  ]) {
    for (let i = 2; i < candles.length - 2; i++) {
      const price = longSide ? candles[i].high : candles[i].low;

      const confirmed = longSide
        ? price > candles[i - 1].high &&
          price > candles[i - 2].high &&
          price >= candles[i + 1].high &&
          price >= candles[i + 2].high
        : price < candles[i - 1].low &&
          price < candles[i - 2].low &&
          price <= candles[i + 1].low &&
          price <= candles[i + 2].low;

      if (confirmed) {
        points.push({ price, timeframe });
      }
    }
  }

  points.sort((a, b) => a.price - b.price);

  const zones = [];

  for (const point of points) {
    const last = zones.at(-1);
    const tolerance = Math.min(
      atr * CONFIG.LEVEL_CLUSTER_ATR,
      point.price * 0.003
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

  const minDistance = atr * 0.8;

  if (longSide) {
    return zones
      .filter(zone => zone.low >= entry + minDistance)
      .sort((a, b) => a.low - b.low);
  }

  return zones
    .filter(zone => zone.high <= entry - minDistance)
    .sort((a, b) => b.high - a.high);
}

function riskReward(longSide, entry, stop, target) {
  const cost = CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE;
  const priceRisk = longSide ? entry - stop : stop - entry;
  const priceReward = longSide ? target - entry : entry - target;

  const risk = priceRisk + (entry + stop) * cost;
  const reward = priceReward - (entry + target) * cost;

  if (!(risk > 0)) return null;
  return reward / risk;
}

// ==================== Direction analysis (UPGRADED BRAIN V3) ====================

function analyze(market, c15, c4, context, side) {
  const longSide = side === 'LONG';
  const fail = reason => reject(context, reason, side);

  const oppositeBTC = longSide
    ? context.regime === 'BEARISH'
    : context.regime === 'BULLISH';

  if (CONFIG.MODE === 'STRICT' && oppositeBTC) {
    return fail('BTC_OPPOSITE_STRICT');
  }

  const last = c15.at(-1);
  const previous = c15.at(-2);
  const trend = c4.at(-1);
  const prevTrend = c4.at(-2);

  const price = number(market.ticker.last);
  const atr = last.atr;

  const validIndicators = [
    last.rsi,
    previous.rsi,
    trend.rsi,
    trend.adx,
    trend.plusDI,
    trend.minusDI,
  ].every(Number.isFinite);

  if (any([!positive(price), !positive(atr), !validIndicators])) {
    return fail('BAD_PRICE_OR_INDICATOR');
  }

  // ۱. تشخیص هوشمند روند ۴ ساعته (حذف شرط کندِ EMA200 که باعث ورود در سقف می‌شد)
  const macroAligned = longSide
    ? (trend.close > trend.ema50 && trend.ema20 >= trend.ema50 * 0.995) ||
      (trend.close > trend.ema20 && trend.rsi > prevTrend.rsi && trend.rsi < 65)
    : (trend.close < trend.ema50 && trend.ema20 <= trend.ema50 * 1.005) ||
      (trend.close < trend.ema20 && trend.rsi < prevTrend.rsi && trend.rsi > 35);

  if (!macroAligned) return fail('COIN_4H_TREND');

  if (
    longSide &&
    any([last.rsi > CONFIG.MAX_RSI_LONG_ENTRY, trend.rsi > CONFIG.MAX_RSI_LONG_4H])
  ) {
    return fail('RSI_OVERBOUGHT');
  }

  if (
    !longSide &&
    any([last.rsi < CONFIG.MIN_RSI_SHORT_ENTRY, trend.rsi < CONFIG.MIN_RSI_SHORT_4H])
  ) {
    return fail('RSI_OVERSOLD');
  }

  const drift = Math.abs(price - last.close);
  if (
    any([
      drift > atr * CONFIG.MAX_TRIGGER_DRIFT_ATR,
      (drift / last.close) * 100 > CONFIG.MAX_TRIGGER_DRIFT_PCT,
    ])
  ) {
    return fail('PRICE_MOVED_AWAY_FROM_TRIGGER');
  }

  const funding =
    number(market.contract.funding_rate) ?? number(market.ticker.funding_rate);

  if (funding == null) return fail('FUNDING_UNKNOWN');

  if (
    any([
      longSide && funding > CONFIG.MAX_FUNDING_RATE_LONG,
      !longSide && funding < CONFIG.MIN_FUNDING_RATE_SHORT,
    ])
  ) {
    return fail('FUNDING_CROWDED');
  }

  // ۲. تعریف ستاپ‌های ورود در کف و اول حرکت (Smart Money Setups)
  const swingWindow = c15.slice(-30, -1);
  const swingLow = Math.min(...swingWindow.map(c => c.low));
  const swingHigh = Math.max(...swingWindow.map(c => c.high));

  const recent12 = c15.slice(-13, -1);
  const minorLow = Math.min(...recent12.map(c => c.low));
  const minorHigh = Math.max(...recent12.map(c => c.high));

  const rejectCandle = rejectionPattern(c15, longSide);
  const engulfCandle = engulfing(c15, longSide);
  const hasVolume = last.volumeRatio != null && last.volumeRatio >= 1.25;

  // ستاپ ۱: شکار استاپ‌هانت و نقدینگی (Liquidity Sweep) - ورود در کف یا سقف مطلق!
  const liquiditySweep = longSide
    ? (last.low < minorLow || previous.low < minorLow) &&
      last.close > minorLow &&
      price >= minorLow &&
      (rejectCandle || engulfCandle || last.close > last.open) &&
      (hasVolume || previous.volumeRatio >= 1.3)
    : (last.high > minorHigh || previous.high > minorHigh) &&
      last.close < minorHigh &&
      price <= minorHigh &&
      (rejectCandle || engulfCandle || last.close < last.open) &&
      (hasVolume || previous.volumeRatio >= 1.3);

  const hardBreakdown = longSide
    ? last.close < swingLow - atr * 0.2
    : last.close > swingHigh + atr * 0.2;

  if (hardBreakdown && !liquiditySweep) {
    return fail(longSide ? 'SUPPORT_BROKEN' : 'RESISTANCE_BROKEN');
  }

  const distanceFromEma = longSide ? price - last.ema20 : last.ema20 - price;
  if (!liquiditySweep && distanceFromEma > atr * CONFIG.MAX_DISTANCE_EMA_ATR) {
    return fail('PRICE_CHASING');
  }

  // ستاپ ۲: پولبک دقیق به EMA20 یا ساختار (Smart Pullback)
  const nearStructure = longSide
    ? Math.abs(last.low - swingLow) <= atr * 0.65 && last.close > swingLow
    : Math.abs(last.high - swingHigh) <= atr * 0.65 && last.close < swingHigh;

  const emaTouch = longSide
    ? last.low <= last.ema20 + atr * 0.25 &&
      last.close >= last.ema20 &&
      last.ema20 > last.ema50
    : last.high >= last.ema20 - atr * 0.25 &&
      last.close <= last.ema20 &&
      last.ema20 < last.ema50;

  const correction = c15.slice(-5, -1).some(candle =>
    longSide
      ? candle.close < candle.ema9 || candle.close < candle.open
      : candle.close > candle.ema9 || candle.close > candle.open
  );

  const directionalCandle = longSide
    ? last.close > last.open && last.close >= previous.close
    : last.close < last.open && last.close <= previous.close;

  const pullback =
    correction && any([nearStructure, emaTouch]) && directionalCandle;

  // ستاپ ۳: شکست مقاومت/حمایت و پولبک (Breakout Retest)
  const beforeBreak = c15.slice(-25, -2);
  const breakLevel = longSide
    ? Math.max(...beforeBreak.map(candle => candle.high))
    : Math.min(...beforeBreak.map(candle => candle.low));

  const retest =
    (previous.volumeRatio >= 1.3 || last.volumeRatio >= 1.5) &&
    (longSide
      ? previous.close > breakLevel &&
        last.low <= breakLevel + atr * 0.4 &&
        last.close > breakLevel &&
        price - breakLevel <= atr * 1.1
      : previous.close < breakLevel &&
        last.high >= breakLevel - atr * 0.4 &&
        last.close < breakLevel &&
        breakLevel - price <= atr * 1.1);

  // ستاپ ۴: استارت پامپ از حالت فشرده (Squeeze Ignition - قبل از دور شدن قیمت)
  const boxRange = minorHigh - minorLow;
  const tightSqueeze = boxRange <= atr * 2.8;
  const earlyIgnition =
    tightSqueeze &&
    last.volumeRatio >= 1.8 &&
    (longSide
      ? last.close > minorHigh &&
        last.close - minorHigh <= atr * 0.8 &&
        last.close > last.ema50
      : last.close < minorLow &&
        minorLow - last.close <= atr * 0.8 &&
        last.close < last.ema50);

  if (!any([liquiditySweep, pullback, retest, earlyIgnition])) {
    return fail('NO_VALID_SETUP');
  }

  const cross = longSide
    ? previous.macdHist <= 0 && last.macdHist > 0
    : previous.macdHist >= 0 && last.macdHist < 0;

  const rsiTurn = longSide
    ? last.rsi >= 32 && last.rsi <= 62 && last.rsi >= previous.rsi + 1.5
    : last.rsi >= 38 && last.rsi <= 68 && last.rsi <= previous.rsi - 1.5;

  const emaTrigger = longSide
    ? previous.close <= previous.ema9 && last.close > last.ema9
    : previous.close >= previous.ema9 && last.close < last.ema9;

  if (
    !any([
      liquiditySweep,
      earlyIgnition,
      retest,
      cross,
      rsiTurn,
      engulfCandle,
      rejectCandle,
      emaTrigger,
    ])
  ) {
    return fail('NO_15M_TRIGGER');
  }

  // ۳. تعیین استاپ‌لاس و محدوده ورود (Entry Zone)
  let stopStructure;
  if (liquiditySweep) {
    stopStructure = longSide
      ? Math.min(last.low, previous.low)
      : Math.max(last.high, previous.high);
  } else if (retest || earlyIgnition) {
    stopStructure = longSide
      ? Math.min(last.low, breakLevel - atr * 0.3)
      : Math.max(last.high, breakLevel + atr * 0.3);
  } else {
    stopStructure = longSide
      ? Math.min(...c15.slice(-5).map(candle => candle.low))
      : Math.max(...c15.slice(-5).map(candle => candle.high));
  }

  const stop =
    stopStructure + (longSide ? -1 : 1) * atr * CONFIG.STOP_ATR_BUFFER;

  const zoneWidth = Math.min(
    atr * CONFIG.ENTRY_ZONE_ATR,
    (price * CONFIG.MAX_ENTRY_ZONE_PCT) / 100
  );

  const pullbackAnchor = longSide
    ? Math.min(price, Math.max(last.ema9, price - zoneWidth))
    : Math.max(price, Math.min(last.ema9, price + zoneWidth));

  const entryLow = longSide
    ? Math.min(pullbackAnchor, price - zoneWidth * 0.6)
    : price - zoneWidth * 0.35;

  const entryHigh = longSide
    ? price + zoneWidth * 0.35
    : Math.max(pullbackAnchor, price + zoneWidth * 0.6);

  const entry = price;
  const risk = longSide ? entry - stop : stop - entry;
  const invalidStop = longSide ? stop >= entryLow : stop <= entryHigh;

  if (
    any([
      !positive(stop),
      !positive(entryLow),
      invalidStop,
      risk < atr * CONFIG.MIN_STOP_ATR,
      risk > atr * CONFIG.MAX_STOP_ATR,
      (risk / entry) * 100 > CONFIG.MAX_STOP_PCT,
    ])
  ) {
    return fail('BAD_RISK');
  }

  let zones = targetZones(c15, c4, entry, atr, longSide);

  if (zones.length === 0) {
    const dir = longSide ? 1 : -1;
    zones = [
      {
        low: entry + dir * risk * 1.5,
        high: entry + dir * risk * 1.5,
        touches: 1,
        timeframes: ['15m'],
      },
      {
        low: entry + dir * risk * 2.5,
        high: entry + dir * risk * 2.5,
        touches: 1,
        timeframes: ['4h'],
      },
      {
        low: entry + dir * risk * 4.0,
        high: entry + dir * risk * 4.0,
        touches: 1,
        timeframes: ['4h'],
      },
    ];
  }

  const targets = zones.slice(0, 3).map((zone, index) => {
    const target = longSide ? zone.low : zone.high;
    const gain = longSide ? target - entry : entry - target;

    return {
      level: index + 1,
      price: target,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      source: longSide
        ? 'HISTORICAL_PIVOT_RESISTANCE'
        : 'HISTORICAL_PIVOT_SUPPORT',
      timeframes: zone.timeframes,
      touches: zone.touches,
      pct: round((gain / entry) * 100),
      rrNet: round(riskReward(longSide, entry, stop, target)),
    };
  });

  const rr1 = riskReward(longSide, entry, stop, targets[0].price);
  const rr2 = targets[1]
    ? riskReward(longSide, entry, stop, targets[1].price)
    : null;

  if (
    any([
      !Number.isFinite(rr1),
      rr1 < CONFIG.MIN_RR_TP1,
      rr2 != null && rr2 < CONFIG.MIN_RR_TP2,
      rr2 == null && rr1 < CONFIG.MIN_SINGLE_TARGET_RR,
    ])
  ) {
    return fail('LOW_RR_AT_NEAREST_LEVEL');
  }

  const strength = longSide
    ? trend.plusDI > trend.minusDI
    : trend.minusDI > trend.plusDI;

  if (
    oppositeBTC &&
    any([
      trend.adx < 22,
      !strength,
      (rr2 ?? rr1) < CONFIG.MIN_COUNTER_BTC_RR,
    ])
  ) {
    return fail('COUNTER_BTC_WEAK_SETUP');
  }

  // =========================================================================
  // ۴. امتیازدهی + موتور شکارچی پامپ‌های SSV (Short/Long Squeeze Detector)
  // =========================================================================
  const emaAligned = longSide
    ? trend.ema20 > trend.ema50
    : trend.ema20 < trend.ema50;

  const trendScore =
    12 + (emaAligned ? 10 : 5) + (trend.adx >= 18 && strength ? 8 : 0);

  let setupScore = 18;
  if (liquiditySweep) setupScore = 28;
  else if (earlyIgnition) setupScore = 26;
  else if (retest) setupScore = 24;
  else if (nearStructure && emaTouch) setupScore = 22;

  const triggerScore = Math.min(
    25,
    (liquiditySweep ? 12 : 0) +
      (earlyIgnition ? 10 : 0) +
      (cross ? 8 : 0) +
      (rsiTurn ? 7 : 0) +
      (engulfCandle ? 8 : 0) +
      (rejectCandle ? 8 : 0) +
      (emaTrigger ? 5 : 0) +
      (retest ? 7 : 0)
  );

  const volumeScore =
    last.volumeRatio >= 1.8 ? 12 : last.volumeRatio >= 1.2 ? 8 : 3;

  const rrScore = rr1 >= 1.8 ? 6 : rr1 >= 1.3 ? 4 : 2;

  // تشخیص تله بازارگردان (مشابه پامپ ۴۰ ساعته SSV):
  // اگر سیگنال خرید (LONG) است ولی مردم دارند Short می‌گیرند (فاندینگ منفی است) -> سوخت موشک!
  const isSqueezeFuel =
    (longSide && funding < -0.00005) || (!longSide && funding > 0.00025);
  const squeezeBonus = isSqueezeFuel ? 10 : 0;

  let required;
  if (longSide) {
    if (oppositeBTC) required = CONFIG.MIN_LONG_SCORE_BEARISH;
    else if (context.regime === 'NEUTRAL') required = CONFIG.MIN_LONG_SCORE_NEUTRAL;
    else required = CONFIG.MIN_LONG_SCORE;
  } else {
    if (oppositeBTC) required = CONFIG.MIN_SHORT_SCORE_BULLISH;
    else if (context.regime === 'NEUTRAL') required = CONFIG.MIN_SHORT_SCORE_NEUTRAL;
    else required = CONFIG.MIN_SHORT_SCORE;
  }

  let setup = 'Pullback';
  if (liquiditySweep) setup = 'LiquiditySweep';
  else if (earlyIgnition) setup = 'EarlyIgnition';
  else if (retest) setup = longSide ? 'BreakoutRetest' : 'BreakdownRetest';

  const direction = longSide ? 'صعودی' : 'نزولی';

  const triggerReasons = [
    isSqueezeFuel
      ? longSide
        ? '🔥 سوخت شورت‌اسکوییز (تله بازارگردان)'
        : '🔥 سوخت لانگ‌اسکوییز (لیکوییدیتی سنگین)'
      : null,
    liquiditySweep ? 'جمع‌آوری نقدینگی (Stop Hunt)' : null,
    earlyIgnition ? 'انفجار حجم از فشردگی' : null,
    rejectCandle ? 'شدو برگشتی قوی ' + direction : null,
    engulfCandle ? 'کندل پوشای ' + direction : null,
    cross ? 'کراس ' + direction + ' MACD' : null,
    rsiTurn ? 'چرخش ' + direction + ' RSI' : null,
  ].filter(Boolean);

  const triggerText =
    triggerReasons.length > 0
      ? triggerReasons.slice(0, 2).join(' + ')
      : 'تأیید ساختار قیمت';

  let setupReason = longSide
    ? 'پولبک هوشمند به حمایت'
    : 'پولبک هوشمند به مقاومت';

  if (liquiditySweep) {
    setupReason = longSide
      ? 'شکار استاپ‌ها در کف و ورود پول هوشمند'
      : 'شکار استاپ‌ها در سقف و توزیع نهنگ‌ها';
  } else if (earlyIgnition) {
    setupReason = longSide
      ? 'آغاز حرکت انفجاری (شکست فشردگی)'
      : 'آغاز ریزش سنگین (شکست فشردگی)';
  } else if (retest) {
    setupReason = longSide
      ? 'شکست مقاومت و پولبک تأییدی'
      : 'شکست حمایت و پولبک تأییدی';
  }

  const volumeReason =
    last.volumeRatio >= 1.1
      ? 'حجم ' + last.volumeRatio.toFixed(1) + ' برابر میانگین'
      : 'هم‌جهت با ساختار ۴ ساعته ' + direction;

  const score =
    trendScore +
    setupScore +
    triggerScore +
    volumeScore +
    rrScore +
    squeezeBonus;

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

    entry: {
      low: entryLow,
      high: entryHigh,
      price,
    },

    stopLoss: stop,
    stopLossPct: round((-risk / entry) * 100),

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

    rsi15: round(last.rsi, 1),
    rsi4h: round(trend.rsi, 1),
    fundingRate: funding,

    change24h: number(market.ticker.change_percentage),
    quoteVolume24h: number(market.ticker.volume_24h_quote),

    triggerCandleTime: new Date(last.time * 1000).toISOString(),
    analyzedAt: new Date(context.asOf * 1000).toISOString(),

    validUntil: new Date(
      (last.time + 900 + CONFIG.ENTRY_VALID_MINUTES * 60) * 1000
    ).toISOString(),

    riskNote: oppositeBTC
      ? 'جهت معامله خلاف رژیم BTC است؛ با مدیریت ریسک وارد شوید.'
      : null,

    reasons: [setupReason, triggerText, volumeReason],

    score,
    rankScore: score,

    scoreBreakdown: {
      trend: trendScore,
      setup: setupScore,
      trigger: triggerScore,
      candleVolume: volumeScore,
      liveFlow: 0,
      firstTargetRR: rrScore,
      squeezeBonus,
    },

    costAssumptions: {
      feeRatePerSide: CONFIG.FEE_RATE_PER_SIDE,
      slippageRatePerSide: CONFIG.SLIPPAGE_RATE_PER_SIDE,
      fundingIncludedInRR: false,
    },

    _required: required,
  };
}

// ==================== Optional live-flow confirmation ====================

async function flowConfirmation(market, context) {
  const end = Math.floor(context.asOf / 60) * 60;
  const from = Math.min(Math.floor(context.asOf / 3600) * 3600, end - 540);

  try {
    const rows = requireArray(
      await requestGate('trades', {
        contract: market.symbol,
        from,
        to: Math.floor(context.asOf),
        limit: CONFIG.TRADE_LIMIT,
      }),
      'trades'
    );

    let invalid = false;
    const seen = new Set();
    const trades = [];

    const multiplier = number(market.contract.quanto_multiplier);
    if (!positive(multiplier)) {
      throw new Error('Invalid contract multiplier');
    }

    for (const raw of rows) {
      const milliseconds = number(raw.create_time_ms);
      const time = positive(milliseconds)
        ? milliseconds / 1000
        : number(raw.create_time);

      const size = number(raw.size);
      const price = number(raw.price);

      if (any([!positive(time), size == null, !positive(price)])) {
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
        notional: Math.abs(size) * multiplier * price,
      });
    }

    const truncated = rows.length >= CONFIG.TRADE_LIMIT;
    const oldest =
      trades.length > 0 ? Math.min(...trades.map(trade => trade.time)) : null;

    const coveredRecent = truncated ? oldest != null && oldest <= end - 180 : true;
    const complete = !invalid && coveredRecent;

    const recent = trades.filter(
      trade => trade.time >= end - 180 && trade.time < end
    );

    const buy = recent
      .filter(trade => trade.size > 0)
      .reduce((sum, trade) => sum + trade.notional, 0);

    const sell = recent
      .filter(trade => trade.size < 0)
      .reduce((sum, trade) => sum + trade.notional, 0);

    const total = buy + sell;

    return {
      available: true,
      sampleComplete: complete,
      sampleTruncated: truncated,
      tradesObserved: trades.length,
      buyNotional: round(buy),
      sellNotional: round(sell),
      buySharePct: total > 0 ? (100 * buy) / total : null,
      sellSharePct: total > 0 ? (100 * sell) / total : null,
      netDelta: buy - sell,
      windowEnd: new Date(end * 1000).toISOString(),
    };
  } catch (error) {
    console.warn('[OPTIONAL FLOW]', market.symbol, error.message);
    return {
      sampleComplete: false,
      available: false,
      tradesObserved: 0,
    };
  }
}

// ==================== BTC regime ====================

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

    const last = indicators(candles).at(-1);

    if (last.close > last.ema50 && last.ema20 >= last.ema50) {
      return 'BULLISH';
    }

    if (last.close < last.ema50 && last.ema20 <= last.ema50) {
      return 'BEARISH';
    }

    return 'NEUTRAL';
  } catch (error) {
    console.error('[BTC]', error.message);
    return 'UNKNOWN';
  }
}

// ==================== Scan one market ====================

async function scanOne(market, context) {
  const [raw15, raw4] = await Promise.all([
    requestGate('candlesticks', {
      contract: market.symbol,
      interval: '15m',
      limit: CONFIG.CANDLES_15M_LIMIT,
    }),
    requestGate('candlesticks', {
      contract: market.symbol,
      interval: '4h',
      limit: CONFIG.CANDLES_4H_LIMIT,
    }),
  ]);

  const c15raw = closedCandles(raw15, 900, context.asOf);
  const c4raw = closedCandles(raw4, 14400, context.asOf);

  if (
    any([
      c15raw.length < CONFIG.MIN_CANDLES_15M,
      c4raw.length < CONFIG.MIN_CANDLES_4H,
    ])
  ) {
    return reject(context, 'INSUFFICIENT_CANDLES');
  }

  const valid15 = validSeries(c15raw, 900, CONFIG.MIN_CANDLES_15M, context.asOf);
  const valid4 = validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, context.asOf);

  if (!valid15 || !valid4) {
    return reject(context, 'STALE_OR_GAPPED_CANDLES');
  }

  const c15 = indicators(c15raw);
  const c4 = indicators(c4raw);

  const longCandidate = CONFIG.ENABLE_LONG
    ? analyze(market, c15, c4, context, 'LONG')
    : null;

  const shortCandidate = CONFIG.ENABLE_SHORT
    ? analyze(market, c15, c4, context, 'SHORT')
    : null;

  if (longCandidate && shortCandidate) {
    return reject(context, 'CONFLICTING_DIRECTIONS');
  }

  const candidate = longCandidate ?? shortCandidate;
  if (!candidate) return null;

  const flow = await flowConfirmation(market, context);
  const longSide = candidate.side === 'LONG';

  const confirmed =
    flow.sampleComplete &&
    (longSide
      ? flow.buyNotional >= CONFIG.MIN_RECENT_BUY_NOTIONAL &&
        flow.buySharePct >= 54 &&
        flow.netDelta > 0
      : flow.sellNotional >= CONFIG.MIN_RECENT_SELL_NOTIONAL &&
        flow.sellSharePct >= 54 &&
        flow.netDelta < 0);

  const liveScore = confirmed ? 6 : 0;

  candidate.score += liveScore;
  candidate.rankScore = candidate.score;
  candidate.scoreBreakdown.liveFlow = liveScore;

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

  candidate.grade =
    candidate.score >= 82 ? 'A+' : candidate.score >= 72 ? 'A' : 'B';

  candidate.recent3m = flow;
  candidate.volume = { recent3m: flow };
  candidate.dataQuality = { recent3mComplete: flow.sampleComplete };
  candidate.tradesObserved = flow.tradesObserved ?? 0;

  delete candidate._required;

  return candidate;
}

// ==================== Main exported scanner ====================

export async function scanGateMarkets() {
  const started = Date.now();

  const [contractsRaw, tickersRaw] = await Promise.all([
    requestGate('contracts'),
    requestGate('tickers'),
  ]);

  const contracts = requireArray(contractsRaw, 'contracts');
  const tickers = requireArray(tickersRaw, 'tickers');

  const tickerMap = new Map(tickers.map(ticker => [ticker.contract, ticker]));

  const active = contracts.filter(
    contract =>
      typeof contract.name === 'string' &&
      contract.name.endsWith('_USDT') &&
      contract.status === 'trading' &&
      contract.in_delisting === false &&
      positive(number(contract.quanto_multiplier))
  );

  const liquid = active
    .map(contract => {
      const ticker = tickerMap.get(contract.name);
      const volume = number(ticker?.volume_24h_quote);
      const price = number(ticker?.last);

      if (!positive(price) || volume == null) return null;
      if (volume < CONFIG.MIN_QUOTE_VOLUME_24H) return null;

      return {
        symbol: contract.name,
        contract,
        ticker,
        volume,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume - a.volume);

  const context = {
    asOf: Date.now() / 1000,
    regime: 'UNKNOWN',
    rejectStats: { LONG: {}, SHORT: {}, GLOBAL: {} },
    nearMisses: [],
  };

  context.regime = await btcRegime(context.asOf);

  let markets;
  if (context.regime === 'UNKNOWN') {
    markets = [];
    context.rejectStats.GLOBAL.BTC_DATA_UNKNOWN_SKIPPED = liquid.length;
  } else if (CONFIG.SCAN_LIMIT > 0) {
    markets = liquid.slice(0, CONFIG.SCAN_LIMIT);
  } else {
    markets = liquid;
  }

  console.log(
    '[SCAN] Active: ' +
      active.length +
      ' | Liquid: ' +
      liquid.length +
      ' | Scanning: ' +
      markets.length +
      ' | BTC: ' +
      context.regime +
      ' | Mode: ' +
      CONFIG.MODE
  );

  let completed = 0;

  const results = await mapPool(markets, CONFIG.CONCURRENCY, async market => {
    try {
      return await scanOne(market, context);
    } finally {
      completed++;
      if (any([completed % 25 === 0, completed === markets.length])) {
        console.log('[PROGRESS] ' + completed + '/' + markets.length);
      }
    }
  });

  const failed = results.filter(item => item?.__error).length;
  let candidates = results.filter(item => item != null && !item.__error);

  if (candidates.length > 0) {
    const scanAge = Date.now() / 1000 - context.asOf;

    if (scanAge > CONFIG.MAX_SCAN_AGE_SECONDS) {
      candidates.forEach(() => reject(context, 'SCAN_TOO_OLD'));
      candidates = [];
    } else {
      try {
        const fresh = requireArray(await requestGate('tickers'), 'fresh tickers');
        const freshMap = new Map(fresh.map(ticker => [ticker.contract, ticker]));
        const checkedAt = new Date().toISOString();

        candidates = candidates.filter(candidate => {
          const price = number(freshMap.get(candidate.symbol)?.last);

          if (Date.now() >= Date.parse(candidate.validUntil)) {
            reject(context, 'ENTRY_EXPIRED', candidate.side);
            return false;
          }

          if (
            any([
              !positive(price),
              price < candidate.entryLow,
              price > candidate.entryHigh,
            ])
          ) {
            reject(context, 'PRICE_LEFT_ENTRY_ZONE', candidate.side);
            return false;
          }

          candidate.lastCheckedPrice = price;
          candidate.priceCheckedAt = checkedAt;
          return true;
        });
      } catch (error) {
        console.error('[REVALIDATION]', error.message);
        candidates.forEach(() => reject(context, 'PRICE_RECHECK_FAILED'));
        candidates = [];
      }
    }
  }

  candidates.sort((a, b) => {
    const scoreDifference = b.score - a.score;
    if (scoreDifference !== 0) return scoreDifference;

    const rrDifference = b.riskRewardToTp1 - a.riskRewardToTp1;
    if (rrDifference !== 0) return rrDifference;

    return b.quoteVolume24h - a.quoteVolume24h;
  });

  candidates = candidates.map((candidate, index) => ({
    ...candidate,
    rank: index + 1,
  }));

  const usableScan = markets.length === 0 ? true : failed < markets.length;

  const output = {
    success: context.regime !== 'UNKNOWN' && usableScan,
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategyVersion: STRATEGY_VERSION,
    strategyConfig: CONFIG,
    marketRegime: context.regime,
    scannedAt: new Date().toISOString(),
    candidates: candidates.slice(0, CONFIG.TOP_COUNT),
    rankedCandidates: candidates,
    filterStats: context.rejectStats,
    nearMisses: context.nearMisses
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
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
