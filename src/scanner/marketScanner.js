import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  round,
  requireArray,
} from '../services/gate.js';

export const STRATEGY_VERSION = 'gate-structural-ls-v7-forensic-pro';

const NON_CRYPTO_BLACKLIST = new Set([
  'XAU', 'XAUT', 'PAXG', 'XAG', 'XPT', 'CL', 'BZ', 'NG',
  'SPY', 'QQQ', 'TQQQX', 'SQQQ', 'SOXL', 'SOXS', 'UVXY', 'NAS100', 'SPCX', 'EWY', 'KORU',
  'NVDA', 'AMD', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'ORCL', 'IBM',
  'INTC', 'INTW', 'TSM', 'AVGO', 'MU', 'MUU', 'MRVL', 'MVLL', 'ARM', 'SMCI', 'DELL', 'HPQ',
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'CRCL', 'CRWV', 'NBIS', 'IREN', 'RKLB', 'SNDK', 'WDC',
  'SKHY', 'SKHYNIX', 'SAMSUNG', 'HYUNDAI', 'CXMT', 'DRAM', 'LITE', 'COHR', 'AAOI', 'AXTI',
  'BE', 'SNXX', 'CBRS', 'KSTR', 'SKDD', 'BMNR', 'ZHONGJI', 'ZHIPU', 'MINIMAX', 'UNITREE'
]);

function isPureCryptoSymbol(contractName) {
  const base = String(contractName).replace(/_USDT$/, '').toUpperCase();
  return !NON_CRYPTO_BLACKLIST.has(base);
}

export const CONFIG = Object.freeze({
  MODE: 'BALANCED',
  ENABLE_LONG: true,
  ENABLE_SHORT: true,
  ENABLE_INTRABAR_15M: true,
  MIN_INTRABAR_ELAPSED_SECONDS: 240,
  MIN_QUOTE_VOLUME_24H: 1200000,
  SCAN_LIMIT: 0,
  TOP_COUNT: 3,
  MIN_LONG_SCORE: 72,
  MIN_LONG_SCORE_NEUTRAL: 76,
  MIN_LONG_SCORE_BEARISH: 84,
  MIN_SHORT_SCORE: 70,
  MIN_SHORT_SCORE_NEUTRAL: 74,
  MIN_SHORT_SCORE_BULLISH: 82,
  CONCURRENCY: 6,
  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,
  MIN_CANDLES_15M: 220,
  MIN_CANDLES_4H: 200,
  TRADE_LIMIT: 1000,
  MIN_RECENT_BUY_NOTIONAL: 1500,
  MIN_RECENT_SELL_NOTIONAL: 1500,
  MAX_RSI_LONG_ENTRY: 66,
  MAX_RSI_LONG_4H: 72,
  MIN_RSI_SHORT_ENTRY: 34,
  MIN_RSI_SHORT_4H: 28,
  MAX_FUNDING_RATE_LONG: 0.0008,
  MIN_FUNDING_RATE_SHORT: -0.0008,
  MIN_RR_TP1: 1.0,
  MIN_RR_TP2: 1.75,
  MIN_SINGLE_TARGET_RR: 1.6,
  MIN_COUNTER_BTC_RR: 2.0,
  STOP_ATR_BUFFER: 0.85,
  MIN_STOP_ATR: 1.15,
  MAX_STOP_ATR: 4.5,
  MIN_STOP_PCT: 1.35,
  MAX_STOP_PCT: 4.8,
  MAX_DISTANCE_EMA_ATR: 1.5,
  MAX_TRIGGER_DRIFT_ATR: 0.8,
  MAX_TRIGGER_DRIFT_PCT: 2.0,
  ENTRY_ZONE_ATR: 0.55,
  MAX_ENTRY_ZONE_PCT: 0.9,
  ENTRY_VALID_MINUTES: 90,
  FEE_RATE_PER_SIDE: 0.0006,
  SLIPPAGE_RATE_PER_SIDE: 0.0003,
  MAX_SCAN_AGE_SECONDS: 240,
  MAX_QUOTE_AGE_SECONDS: 60,
  LEVEL_CLUSTER_ATR: 0.4,
});

const any = values => values.some(Boolean);
const mean = values => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);

function reject(context, reason, side = 'GLOBAL') {
  const group = context.rejectStats[side];
  group[reason] = (group[reason] ?? 0) + 1;
  return null;
}

function validSeries(candles, seconds, minimum, asOf) {
  if (candles.length < minimum) return false;
  const expected = Math.floor(asOf / seconds) * seconds - seconds;
  if (candles.at(-1).time !== expected) return false;
  const recent = candles.slice(-minimum);
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].time - recent[i - 1].time !== seconds) return false;
  }
  return true;
}

export function extractDevelopingCandle(rawRows, closedList, intervalSeconds, asOf) {
  if (!Array.isArray(rawRows) || rawRows.length === 0 || !closedList?.length) return null;
  const expectedLiveTime = Math.floor(asOf / intervalSeconds) * intervalSeconds;
  const elapsedSeconds = Math.max(10, asOf - expectedLiveTime);
  const progress = Math.min(1, Math.max(0.15, elapsedSeconds / intervalSeconds));
  const lastRaw = rawRows.at(-1);
  if (!lastRaw || typeof lastRaw !== 'object') return null;

  const rawTime = number(lastRaw.t ?? lastRaw.time ?? lastRaw[0]);
  if (rawTime !== expectedLiveTime) return null;

  const open = number(lastRaw.o ?? lastRaw.open ?? lastRaw[5]);
  const high = number(lastRaw.h ?? lastRaw.high ?? lastRaw[3]);
  const low = number(lastRaw.l ?? lastRaw.low ?? lastRaw[4]);
  const close = number(lastRaw.c ?? lastRaw.close ?? lastRaw[2]);
  const volContracts = number(lastRaw.v ?? lastRaw.volume ?? lastRaw.volumeContracts ?? lastRaw[1]) ?? 0;
  const quoteTurn = number(lastRaw.sum ?? lastRaw.quoteTurnover ?? lastRaw[6]);

  if (!positive(open) || !positive(high) || !positive(low) || !positive(close)) return null;

  return {
    time: expectedLiveTime,
    open,
    high,
    low,
    close,
    volumeContracts: volContracts / progress,
    quoteTurnover: quoteTurn != null ? quoteTurn / progress : null,
    isLiveCandle: true,
    elapsedSeconds: Math.round(elapsedSeconds),
    progressPct: Math.round(progress * 100),
  };
}

function ema(values, period) {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : alpha * value + (1 - alpha) * previous;
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
  const calc = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  output[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(delta, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-delta, 0)) / period;
    output[i] = calc();
  }
  return output;
}

export function indicators(candles) {
  if (candles.length === 0) return [];
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(macd, 9);
  const rsiValues = rsi(closes);

  const trueRanges = [];
  const plusMoves = [];
  const minusMoves = [];

  candles.forEach((candle, index) => {
    const prev = candles[index - 1];
    trueRanges.push(
      prev
        ? Math.max(candle.high - candle.low, Math.abs(candle.high - prev.close), Math.abs(candle.low - prev.close))
        : candle.high - candle.low
    );
    const up = prev ? candle.high - prev.high : 0;
    const down = prev ? prev.low - candle.low : 0;
    plusMoves.push(up > down && up > 0 ? up : 0);
    minusMoves.push(down > up && down > 0 ? down : 0);
  });

  const atrValues = wilder(trueRanges);
  const plusSmoothed = wilder(plusMoves);
  const minusSmoothed = wilder(minusMoves);
  const pdi = atrValues.map((atr, i) => (positive(atr) ? (100 * plusSmoothed[i]) / atr : null));
  const mdi = atrValues.map((atr, i) => (positive(atr) ? (100 * minusSmoothed[i]) / atr : null));

  const dx = atrValues.map((atr, i) => {
    if (atr == null) return null;
    const pos = Number.isFinite(pdi[i]) ? pdi[i] : 0;
    const neg = Number.isFinite(mdi[i]) ? mdi[i] : 0;
    return pos + neg <= 0 ? 0 : (100 * Math.abs(pos - neg)) / (pos + neg);
  });

  const adxValues = new Array(candles.length).fill(null);
  const start = dx.findIndex(v => v != null);
  if (start >= 0) {
    wilder(dx.slice(start)).forEach((v, i) => {
      adxValues[start + i] = v;
    });
  }

  return candles.map((candle, index) => {
    const previous = candles.slice(Math.max(0, index - 20), index);
    const quoteAvailable =
      candle.quoteTurnover != null &&
      candle.quoteTurnover >= 0 &&
      previous.every(item => item.quoteTurnover != null && item.quoteTurnover >= 0);

    const volumes = previous.map(item => (quoteAvailable ? item.quoteTurnover : item.volumeContracts));
    const baseline =
      volumes.length === 20 && volumes.every(v => v != null && v >= 0) ? mean(volumes) : null;
    const volume = quoteAvailable ? candle.quoteTurnover : candle.volumeContracts;
    const volumeRatio = positive(baseline) && volume != null ? volume / baseline : null;

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

function engulfing(candles, longSide) {
  const last = candles.at(-1);
  const prev = candles.at(-2);
  return longSide
    ? last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close
    : last.close < last.open && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open;
}

function rejectionPattern(candles, longSide) {
  const last = candles.at(-1);
  const range = last.high - last.low;
  if (!positive(range)) return false;
  const lower = Math.min(last.open, last.close) - last.low;
  const upper = last.high - Math.max(last.open, last.close);
  return longSide
    ? lower >= range * 0.45 && (last.close - last.low) / range >= 0.6
    : upper >= range * 0.45 && (last.close - last.low) / range <= 0.4;
}

function analyzeHistoricalBehavior(c15, c4, btc15, btc4, longSide) {
  if (!btc15?.length || !btc4?.length) {
    return {
      resiliencePct: 50,
      beta: 1.0,
      whenBtcBullish: 'حرکت هم‌راستا با کلیت بازار',
      whenBtcBearish: 'نیازمند رعایت دقیق حد ضرر',
      whenBtcNeutral: 'حرکت بر اساس جریان نقدینگی مستقل',
    };
  }

  const map4h = new Map(btc4.map((c, idx) => [c.time, idx]));
  let btcDownCount = 0;
  let coinResilientOnDown = 0;
  let btcUpCount = 0;
  let betaSum = 0;

  for (let i = 1; i < c4.length; i++) {
    const bIdx = map4h.get(c4[i].time);
    if (bIdx == null || bIdx < 1) continue;
    const btcRet = ((btc4[bIdx].close - btc4[bIdx - 1].close) / btc4[bIdx - 1].close) * 100;
    const coinRet = ((c4[i].close - c4[i - 1].close) / c4[i - 1].close) * 100;
    if (btcRet < -0.45) {
      btcDownCount++;
      if (longSide ? coinRet > btcRet * 0.5 : coinRet < btcRet * 1.1) coinResilientOnDown++;
    } else if (btcRet > 0.45) {
      btcUpCount++;
      betaSum += coinRet / btcRet;
    }
  }

  const map15m = new Map(btc15.map((c, idx) => [c.time, idx]));
  let neutralOutperform = 0;
  let neutralTotal = 0;
  let recentRelStrength = 0;
  const recentSlice = c15.slice(-96);

  for (let i = 1; i < recentSlice.length; i++) {
    const bIdx = map15m.get(recentSlice[i].time);
    if (bIdx == null || bIdx < 1) continue;
    const btcRet = ((btc15[bIdx].close - btc15[bIdx - 1].close) / btc15[bIdx - 1].close) * 100;
    const coinRet = ((recentSlice[i].close - recentSlice[i - 1].close) / recentSlice[i - 1].close) * 100;
    recentRelStrength += coinRet - btcRet;
    if (Math.abs(btcRet) <= 0.15) {
      neutralTotal++;
      if (longSide ? coinRet > 0.15 : coinRet < -0.15) neutralOutperform++;
    }
  }

  const resiliencePct = btcDownCount > 0 ? Math.round((coinResilientOnDown / btcDownCount) * 100) : 55;
  const beta = Math.max(0.4, Math.min(3.2, round(btcUpCount > 0 ? betaSum / btcUpCount : 1.2, 2)));
  const independentScore = neutralTotal > 0 ? Math.round((neutralOutperform / neutralTotal) * 100) : 30;

  return {
    resiliencePct,
    beta,
    independentScore,
    recentRelStrength: round(recentRelStrength, 2),
    whenBtcBullish:
      beta >= 1.4
        ? 'شتاب‌گیرنده قوی (اهرم ' + beta + ' برابر نسبت به صعود BTC)'
        : 'هم‌سو و پایدار با رشد BTC (ضریب ' + beta + ')',
    whenBtcBearish:
      resiliencePct >= 62
        ? 'مقاوم و ضدریزش (در ' + resiliencePct + '٪ ریزش‌های گذشته BTC حمایت خود را حفظ کرده)'
        : 'حساس به ریزش BTC (در صورت سقوط شدید بیت‌کوین، سیو سود سریع الزامی است)',
    whenBtcNeutral:
      independentScore >= 32
        ? 'دارای پول هوشمند مستقل؛ وقتی BTC رِنج می‌شود این ارز تمایل به حرکت شارپ دارد'
        : 'در زمان خنثی بودن BTC، آرام حرکت می‌کند و انرژی جمع می‌کند',
  };
}

function buildMajorTargets(c15, c4, entry, stop, risk, atr, longSide) {
  const points = [];
  const lookback15 = 8;
  for (let i = lookback15; i < c15.length - lookback15; i++) {
    const price = longSide ? c15[i].high : c15[i].low;
    let isMajor = true;
    for (let j = 1; j <= lookback15; j++) {
      if (
        longSide
          ? c15[i - j].high >= price || c15[i + j].high > price
          : c15[i - j].low <= price || c15[i + j].low < price
      ) {
        isMajor = false;
        break;
      }
    }
    if (isMajor) points.push({ price, timeframe: '15m', weight: 1 });
  }

  const lookback4h = 3;
  for (let i = lookback4h; i < c4.length - lookback4h; i++) {
    const price = longSide ? c4[i].high : c4[i].low;
    let isMajor = true;
    for (let j = 1; j <= lookback4h; j++) {
      if (
        longSide
          ? c4[i - j].high >= price || c4[i + j].high > price
          : c4[i - j].low <= price || c4[i + j].low < price
      ) {
        isMajor = false;
        break;
      }
    }
    if (isMajor) points.push({ price, timeframe: '4h', weight: 2 });
  }

  points.sort((a, b) => a.price - b.price);
  const zones = [];
  for (const point of points) {
    const last = zones.at(-1);
    const tolerance = Math.max(atr * CONFIG.LEVEL_CLUSTER_ATR, point.price * 0.004);
    if (last && point.price - last.low <= tolerance) {
      last.high = Math.max(last.high, point.price);
      last.touches += 1;
      last.strength += point.weight;
      last.timeframes = [...new Set([...last.timeframes, point.timeframe])];
    } else {
      zones.push({
        low: point.price,
        high: point.price,
        touches: 1,
        strength: point.weight,
        timeframes: [point.timeframe],
      });
    }
  }

  const costBuffer = entry * (CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE) * 4;
  const minTp1Dist = risk * 1.08 + costBuffer;
  const maxTp1Dist = risk * 1.38 + costBuffer;

  const blockingMajorWall = zones.find(zone => {
    if (!(zone.timeframes.includes('4h') && zone.strength >= 4)) return false;
    return longSide
      ? zone.low > entry && zone.low < entry + risk * 0.8
      : zone.high < entry && zone.high > entry - risk * 0.8;
  });

  if (blockingMajorWall) return { blocked: true, zones: [] };

  const dir = longSide ? 1 : -1;
  const validZones = longSide
    ? zones.filter(z => z.low >= entry + minTp1Dist).sort((a, b) => a.low - b.low)
    : zones.filter(z => z.high <= entry - minTp1Dist).sort((a, b) => b.high - a.high);

  let tp1Price = entry + dir * (risk * 1.22 + costBuffer);
  if (validZones.length > 0) {
    const firstWall = longSide ? validZones[0].low : validZones[0].high;
    const distToWall = Math.abs(firstWall - entry);
    const frontRunPrice = entry + dir * Math.max(minTp1Dist, distToWall * 0.94);
    if (Math.abs(frontRunPrice - entry) <= maxTp1Dist) {
      tp1Price = frontRunPrice;
    }
  }

  let tp2Price = entry + dir * (risk * 2.15 + costBuffer);
  let tp3Price = entry + dir * (risk * 3.4 + costBuffer);

  const higherZones = validZones.filter(z => {
    const p = longSide ? z.low : z.high;
    return Math.abs(p - entry) >= Math.abs(tp1Price - entry) + risk * 0.65;
  });

  if (higherZones[0]) {
    const p2 = longSide ? higherZones[0].low : higherZones[0].high;
    if (Math.abs(p2 - entry) <= risk * 3.0) tp2Price = p2;
  }

  if (higherZones[1]) {
    const p3 = longSide ? higherZones[1].low : higherZones[1].high;
    if (Math.abs(p3 - entry) > Math.abs(tp2Price - entry) + risk * 0.7 && Math.abs(p3 - entry) <= risk * 5.0) {
      tp3Price = p3;
    }
  }

  if (longSide) {
    if (tp2Price <= tp1Price + risk * 0.6) tp2Price = tp1Price + risk * 0.85;
    if (tp3Price <= tp2Price + risk * 0.7) tp3Price = tp2Price + risk * 1.2;
  } else {
    if (tp2Price >= tp1Price - risk * 0.6) tp2Price = tp1Price - risk * 0.85;
    if (tp3Price >= tp2Price - risk * 0.7) tp3Price = tp2Price - risk * 1.2;
  }

  return {
    blocked: false,
    zones: [
      { low: tp1Price, high: tp1Price, touches: 2, timeframes: ['15m', '4h'] },
      { low: tp2Price, high: tp2Price, touches: 2, timeframes: ['4h'] },
      { low: tp3Price, high: tp3Price, touches: 1, timeframes: ['4h'], isStructuralProjection: true },
    ],
  };
}

function riskReward(longSide, entry, stop, target) {
  const cost = CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE;
  const priceRisk = longSide ? entry - stop : stop - entry;
  const priceReward = longSide ? target - entry : entry - target;
  const risk = priceRisk + (entry + stop) * cost;
  const reward = priceReward - (entry + target) * cost;
  return risk > 0 ? reward / risk : null;
}

function analyze(market, c15, c4, context, side, isIntrabar = false) {
  const longSide = side === 'LONG';
  const fail = reason => (isIntrabar ? null : reject(context, reason, side));

  const oppositeBTC = longSide ? context.regime === 'BEARISH' : context.regime === 'BULLISH';
  if (CONFIG.MODE === 'STRICT' && oppositeBTC) return fail('BTC_OPPOSITE_STRICT');

  const last = c15.at(-1);
  const previous = c15.at(-2);
  const trend = c4.at(-1);
  const prevTrend = c4.at(-2);
  const price = number(market.ticker.last);
  const atr = last.atr;

  const validIndicators = [last.rsi, previous.rsi, trend.rsi, trend.adx, trend.plusDI, trend.minusDI].every(
    Number.isFinite
  );
  if (any([!positive(price), !positive(atr), !validIndicators])) return fail('BAD_PRICE_OR_INDICATOR');

  if (isIntrabar && (!last.volumeRatio || last.volumeRatio < 1.4)) return null;

  const macroAligned = longSide
    ? (trend.close > trend.ema50 && trend.ema20 >= trend.ema50 * 0.995) ||
      (trend.close > trend.ema20 && trend.rsi > prevTrend.rsi && trend.rsi < 65)
    : (trend.close < trend.ema50 && trend.ema20 <= trend.ema50 * 1.005) ||
      (trend.close < trend.ema20 && trend.rsi < prevTrend.rsi && trend.rsi > 35);

  if (!macroAligned) return fail('COIN_4H_TREND');

  if (longSide && any([last.rsi > CONFIG.MAX_RSI_LONG_ENTRY, trend.rsi > CONFIG.MAX_RSI_LONG_4H])) {
    return fail('RSI_OVERBOUGHT');
  }
  if (!longSide && any([last.rsi < CONFIG.MIN_RSI_SHORT_ENTRY, trend.rsi < CONFIG.MIN_RSI_SHORT_4H])) {
    return fail('RSI_OVERSOLD');
  }

  const drift = Math.abs(price - last.close);
  if (any([drift > atr * CONFIG.MAX_TRIGGER_DRIFT_ATR, (drift / last.close) * 100 > CONFIG.MAX_TRIGGER_DRIFT_PCT])) {
    return fail('PRICE_MOVED_AWAY_FROM_TRIGGER');
  }

  const funding = number(market.contract.funding_rate) ?? number(market.ticker.funding_rate);
  if (funding == null) return fail('FUNDING_UNKNOWN');
  if (any([longSide && funding > CONFIG.MAX_FUNDING_RATE_LONG, !longSide && funding < CONFIG.MIN_FUNDING_RATE_SHORT])) {
    return fail('FUNDING_CROWDED');
  }

  const swingWindow = c15.slice(-30, -1);
  const swingLow = Math.min(...swingWindow.map(c => c.low));
  const swingHigh = Math.max(...swingWindow.map(c => c.high));

  const recent12 = c15.slice(-13, -1);
  const minorLow = Math.min(...recent12.map(c => c.low));
  const minorHigh = Math.max(...recent12.map(c => c.high));

  const rejectCandle = rejectionPattern(c15, longSide);
  const engulfCandle = engulfing(c15, longSide);
  const hasVolume = last.volumeRatio != null && last.volumeRatio >= 1.3;

  const liquiditySweep = longSide
    ? (last.low < minorLow || previous.low < minorLow) &&
      last.close > minorLow &&
      price >= minorLow &&
      (rejectCandle || engulfCandle || last.close > last.open) &&
      (hasVolume || previous.volumeRatio >= 1.35)
    : (last.high > minorHigh || previous.high > minorHigh) &&
      last.close < minorHigh &&
      price <= minorHigh &&
      (rejectCandle || engulfCandle || last.close < last.open) &&
      (hasVolume || previous.volumeRatio >= 1.35);

  const hardBreakdown = longSide ? last.close < swingLow - atr * 0.2 : last.close > swingHigh + atr * 0.2;
  if (hardBreakdown && !liquiditySweep) return fail(longSide ? 'SUPPORT_BROKEN' : 'RESISTANCE_BROKEN');

  const distanceFromEma = longSide ? price - last.ema20 : last.ema20 - price;
  if (!liquiditySweep && distanceFromEma > atr * CONFIG.MAX_DISTANCE_EMA_ATR) return fail('PRICE_CHASING');

  const nearStructure = longSide
    ? Math.abs(last.low - swingLow) <= atr * 0.65 && last.close > swingLow
    : Math.abs(last.high - swingHigh) <= atr * 0.65 && last.close < swingHigh;

  const emaTouch = longSide
    ? last.low <= last.ema20 + atr * 0.25 && last.close >= last.ema20 && last.ema20 > last.ema50
    : last.high >= last.ema20 - atr * 0.25 && last.close <= last.ema20 && last.ema20 < last.ema50;

  const correction = c15.slice(-5, -1).some(c =>
    longSide ? c.close < c.ema9 || c.close < c.open : c.close > c.ema9 || c.close > c.open
  );

  const directionalCandle = longSide
    ? last.close > last.open && last.close >= previous.close
    : last.close < last.open && last.close <= previous.close;

  const pullback =
    correction &&
    any([nearStructure, emaTouch]) &&
    directionalCandle &&
    (rejectCandle || engulfCandle || hasVolume);

  const beforeBreak = c15.slice(-25, -2);
  const breakLevel = longSide
    ? Math.max(...beforeBreak.map(c => c.high))
    : Math.min(...beforeBreak.map(c => c.low));

  const retest =
    (previous.volumeRatio >= 1.35 || last.volumeRatio >= 1.5) &&
    (longSide
      ? previous.close > breakLevel &&
        last.low <= breakLevel + atr * 0.4 &&
        last.close > breakLevel &&
        price - breakLevel <= atr * 1.1
      : previous.close < breakLevel &&
        last.high >= breakLevel - atr * 0.4 &&
        last.close < breakLevel &&
        breakLevel - price <= atr * 1.1);

  const tightSqueeze = minorHigh - minorLow <= atr * 2.8;
  const earlyIgnition =
    tightSqueeze &&
    last.volumeRatio >= 1.85 &&
    (longSide
      ? last.close > minorHigh && last.close - minorHigh <= atr * 0.8 && last.close > last.ema50
      : last.close < minorLow && minorLow - last.close <= atr * 0.8 && last.close < last.ema50);

  if (isIntrabar && !any([liquiditySweep, earlyIgnition, retest])) return null;
  if (!any([liquiditySweep, pullback, retest, earlyIgnition])) return fail('NO_VALID_SETUP');

  const cross = longSide
    ? previous.macdHist <= 0 && last.macdHist > 0
    : previous.macdHist >= 0 && last.macdHist < 0;

  const rsiTurn = longSide
    ? last.rsi >= 32 && last.rsi <= 62 && last.rsi >= previous.rsi + 1.5
    : last.rsi >= 38 && last.rsi <= 68 && last.rsi <= previous.rsi - 1.5;

  const emaTrigger = longSide
    ? previous.close <= previous.ema9 && last.close > last.ema9
    : previous.close >= previous.ema9 && last.close < last.ema9;

  if (!any([liquiditySweep, earlyIgnition, retest, cross, rsiTurn, engulfCandle, rejectCandle, emaTrigger])) {
    return fail('NO_15M_TRIGGER');
  }

  let stopStructure;
  if (liquiditySweep) {
    stopStructure = longSide ? Math.min(last.low, previous.low, minorLow) : Math.max(last.high, previous.high, minorHigh);
  } else if (retest || earlyIgnition) {
    stopStructure = longSide
      ? Math.min(last.low, previous.low, breakLevel - atr * 0.4)
      : Math.max(last.high, previous.high, breakLevel + atr * 0.4);
  } else {
    stopStructure = longSide
      ? Math.min(...c15.slice(-12).map(c => c.low))
      : Math.max(...c15.slice(-12).map(c => c.high));
  }

  const rawStop = stopStructure + (longSide ? -1 : 1) * atr * CONFIG.STOP_ATR_BUFFER;
  const minSafeDist = Math.max(atr * CONFIG.MIN_STOP_ATR, price * (CONFIG.MIN_STOP_PCT / 100));
  const stop = longSide ? Math.min(rawStop, price - minSafeDist) : Math.max(rawStop, price + minSafeDist);

  const zoneWidth = Math.min(atr * CONFIG.ENTRY_ZONE_ATR, (price * CONFIG.MAX_ENTRY_ZONE_PCT) / 100);
  const pullbackAnchor = longSide
    ? Math.min(price, Math.max(last.ema9, price - zoneWidth))
    : Math.max(price, Math.min(last.ema9, price + zoneWidth));

  const entryLow = longSide ? Math.min(pullbackAnchor, price - zoneWidth * 0.7) : price - zoneWidth * 0.15;
  const entryHigh = longSide ? price + zoneWidth * 0.15 : Math.max(pullbackAnchor, price + zoneWidth * 0.7);

  const entry = price;
  const risk = longSide ? entry - stop : stop - entry;
  const invalidStop = longSide ? stop >= entryLow : stop <= entryHigh;

  if (
    any([
      !positive(stop),
      !positive(entryLow),
      invalidStop,
      risk > atr * CONFIG.MAX_STOP_ATR,
      (risk / entry) * 100 > CONFIG.MAX_STOP_PCT,
    ])
  ) {
    return fail('BAD_RISK');
  }

  const majorResult = buildMajorTargets(c15, c4, entry, stop, risk, atr, longSide);
  if (majorResult.blocked) {
    return fail(longSide ? 'BLOCKED_BY_MAJOR_4H_RESISTANCE' : 'BLOCKED_BY_MAJOR_4H_SUPPORT');
  }

  const targets = majorResult.zones.map((zone, index) => {
    const target = longSide ? zone.low : zone.high;
    const gain = longSide ? target - entry : entry - target;
    return {
      level: index + 1,
      price: target,
      zoneLow: zone.low,
      zoneHigh: zone.high,
      source: zone.isStructuralProjection
        ? 'STRUCTURAL_R_EXTENSION'
        : longSide
        ? 'MAJOR_PIVOT_RESISTANCE'
        : 'MAJOR_PIVOT_SUPPORT',
      timeframes: zone.timeframes,
      touches: zone.touches,
      pct: round((gain / entry) * 100),
      rrNet: round(riskReward(longSide, entry, stop, target)),
    };
  });

  const rr1 = riskReward(longSide, entry, stop, targets[0].price);
  const rr2 = targets[1] ? riskReward(longSide, entry, stop, targets[1].price) : null;

  if (any([!Number.isFinite(rr1), rr1 < CONFIG.MIN_RR_TP1, rr2 != null && rr2 < CONFIG.MIN_RR_TP2])) {
    return fail('LOW_RR_AT_NEAREST_LEVEL');
  }

  const strength = longSide ? trend.plusDI > trend.minusDI : trend.minusDI > trend.plusDI;
  if (oppositeBTC && any([trend.adx < 22, !strength, (rr2 ?? rr1) < CONFIG.MIN_COUNTER_BTC_RR])) {
    return fail('COUNTER_BTC_WEAK_SETUP');
  }

  const emaAligned = longSide ? trend.ema20 > trend.ema50 : trend.ema20 < trend.ema50;
  const trendScore = 12 + (emaAligned ? 10 : 5) + (trend.adx >= 18 && strength ? 8 : 0);

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

  const volumeScore = last.volumeRatio >= 1.8 ? 12 : last.volumeRatio >= 1.2 ? 8 : 3;
  const rrScore = rr1 >= 1.4 ? 6 : rr1 >= 1.1 ? 4 : 2;
  const isSqueezeFuel = (longSide && funding < -0.00005) || (!longSide && funding > 0.00025);
  const squeezeBonus = isSqueezeFuel ? 10 : 0;

  let required = longSide
    ? oppositeBTC
      ? CONFIG.MIN_LONG_SCORE_BEARISH
      : context.regime === 'NEUTRAL'
      ? CONFIG.MIN_LONG_SCORE_NEUTRAL
      : CONFIG.MIN_LONG_SCORE
    : oppositeBTC
    ? CONFIG.MIN_SHORT_SCORE_BULLISH
    : context.regime === 'NEUTRAL'
    ? CONFIG.MIN_SHORT_SCORE_NEUTRAL
    : CONFIG.MIN_SHORT_SCORE;

  if (isIntrabar) required += 3;

  let setup = 'Pullback';
  if (liquiditySweep) setup = 'LiquiditySweep';
  else if (earlyIgnition) setup = 'EarlyIgnition';
  else if (retest) setup = longSide ? 'BreakoutRetest' : 'BreakdownRetest';

  const direction = longSide ? 'صعودی' : 'نزولی';
  const triggerReasons = [
    isIntrabar ? '⚡ شکار زنده در کندل جاری ۱۵ دقیقه' : null,
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

  const triggerText = triggerReasons.length > 0 ? triggerReasons.slice(0, 2).join(' + ') : 'تأیید ساختار قیمت';

  let setupReason = longSide ? 'پولبک هوشمند به حمایت بزرگ' : 'پولبک هوشمند به مقاومت بزرگ';
  if (liquiditySweep) {
    setupReason = longSide
      ? 'شکار استاپ‌ها در کف ماژور و ورود پول هوشمند'
      : 'شکار استاپ‌ها در سقف ماژور و توزیع نهنگ‌ها';
  } else if (earlyIgnition) {
    setupReason = longSide ? 'آغاز حرکت انفجاری (شکست فشردگی)' : 'آغاز ریزش سنگین (شکست فشردگی)';
  } else if (retest) {
    setupReason = longSide ? 'شکست مقاومت اصلی و پولبک تأییدی' : 'شکست حمایت اصلی و پولبک تأییدی';
  }

  const volumeReason =
    last.volumeRatio >= 1.1
      ? 'شتاب حجم ' + last.volumeRatio.toFixed(1) + ' برابر میانگین'
      : 'هم‌جهت با ساختار ۴ ساعته ' + direction;

  const score = trendScore + setupScore + triggerScore + volumeScore + rrScore + squeezeBonus;
  const historyBehavior = analyzeHistoricalBehavior(c15, c4, context.btc15, context.btc4, longSide);

  return {
    symbol: market.symbol,
    contract: market.symbol,
    side,
    setup,
    isIntrabar,
    intrabarProgressPct: last.progressPct ?? 100,
    strategyVersion: STRATEGY_VERSION,
    status: side + '_ENTRY',
    statusLabel: side + ' ' + setup,
    price,
    entryLow,
    entryHigh,
    referenceEntry: entry,
    entry: { low: entryLow, high: entryHigh, price },
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
    adx4h: round(trend.adx, 1),
    volumeRatio15m: round(last.volumeRatio ?? 1, 2),
    fundingRate: funding,
    isSqueezeFuel,
    change24h: number(market.ticker.change_percentage),
    quoteVolume24h: number(market.ticker.volume_24h_quote),
    triggerCandleTime: new Date(last.time * 1000).toISOString(),
    analyzedAt: new Date(context.asOf * 1000).toISOString(),
    validUntil: new Date((last.time + 900 + CONFIG.ENTRY_VALID_MINUTES * 60) * 1000).toISOString(),
    riskNote: oppositeBTC ? 'جهت معامله خلاف رژیم BTC است؛ با مدیریت ریسک وارد شوید.' : null,
    reasons: [setupReason, triggerText, volumeReason],
    historyBehavior,
    btcIntel: context.btcIntel,
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

function buildLiveSignalIntelligence(candidate, flow) {
  const longSide = candidate.side === 'LONG';
  const setup = candidate.setup;
  const timingTag = candidate.isIntrabar
    ? '⚡ [شکار لحظه‌ای در کندل جاری - دقیقه ' + Math.round((candidate.intrabarProgressPct * 15) / 100) + ' از ۱۵] '
    : '🔒 [تأییدشده با کلوز کندل ۱۵ دقیقه] ';

  let manipulationStatus = '';
  let movePhase = '';
  let entryInstruction = '';

  if (setup === 'LiquiditySweep') {
    manipulationStatus = '✅ کلک بازارگردان (Stop Hunt) انجام شده؛ حد ضرر پشت ساختار امن قرار گرفت.';
    movePhase = timingTag + '🔋 در حال جمع کردن انرژی در کف/سقف برای پرتاب حرکت اصلی';
  } else if (setup === 'EarlyIgnition') {
    manipulationStatus = '🛡️ احتمال کلک پایین است؛ شکست فشردگی با ورود مستقیم حجم انجام شده است.';
    movePhase = timingTag + '🚀 حرکت اصلی (Impulse) رسماً آغاز شده است';
  } else if (setup === 'BreakoutRetest') {
    manipulationStatus = '✅ تست مجدد سطح شکسته شده با موفقیت انجام شد؛ تله فیک‌اوت خنثی شده است.';
    movePhase = timingTag + '⚡ آماده شروع موج دوم حرکت پس از تثبیت';
  } else {
    manipulationStatus = '🔍 پولبک به حمایت/مقاومت بزرگ؛ حد ضرر با فاصله امن از شدوها تنظیم شد.';
    movePhase = timingTag + '⏳ در حال ساختن کف/سقف محلی و جذب سفارشات';
  }

  const flowAligned = flow?.sampleComplete && (longSide ? flow.buySharePct >= 54 : flow.sellSharePct >= 54);
  const flowOpposite = flow?.sampleComplete && (longSide ? flow.sellSharePct >= 62 : flow.buySharePct >= 62);

  if (flowOpposite) {
    entryInstruction = '⚠️ احتیاط در ورود لحظه‌ای: در ۳ دقیقه اخیر فشار سفارشات خلاف جهت است؛ پله‌ای وارد شوید.';
  } else if (flowAligned) {
    entryInstruction = '🟢 دستور ورود: جریان سفارشات زنده کاملاً هم‌جهت با سیگنال است؛ ورود با اطمینان بالا مجاز است.';
  } else {
    entryInstruction = '🎯 دستور ورود: در محدوده ورود وارد شوید و در TP1 حتماً معامله را ریسک‌فری کنید.';
  }

  const targetProjection =
    candidate.isSqueezeFuel || (candidate.adx4h >= 25 && candidate.volumeRatio15m >= 1.6)
      ? '🔥 ظرفیت بالای ادامه حرکت: پس از سیو سود در TP1، پتانسیل حرکت تا TP3 و فراتر از آن وجود دارد.'
      : '📊 هدف اول (TP1) برای قفل سود سریع بهینه‌سازی شده است؛ پس از TP1 حد ضرر به نقطه ورود منتقل می‌شود.';

  const confidencePct = Math.min(96, Math.max(70, Math.round(candidate.score * 0.95)));
  return { confidencePct, manipulationStatus, movePhase, entryInstruction, targetProjection };
}

export function formatInitialAiReport(candidate) {
  const ai = candidate.liveInsight;
  const hb = candidate.historyBehavior;
  const btc = candidate.btcIntel;
  if (!ai) return '';

  return [
    '🧠 رادار هوش مصنوعی و تحلیل لحظه‌ای سیگنال',
    '🎯 اطمینان و پایداری حرکت: ' + ai.confidencePct + '% (' + candidate.grade + ')',
    '🔄 فاز فعلی حرکت: ' + ai.movePhase,
    '🪤 بررسی کلک بازارگردان: ' + ai.manipulationStatus,
    '📌 فرمان لحظه‌ای: ' + ai.entryInstruction,
    '🚀 ظرفیت اهداف: ' + ai.targetProjection,
    '━━━━━━━━━━━━━━━━━━',
    '₿ تحلیل عمیق بیت‌کوین (فعلی و حرکت بعدی):',
    '• وضعیت فعلی: ' + (btc?.regimeFa ?? 'نامشخص') + ' (RSI 4H: ' + (btc?.rsi4h ?? '—') + ')',
    '• پیش‌بینی حرکت بعدی BTC: ' + (btc?.nextMoveForecast ?? 'در حال رصد'),
    '━━━━━━━━━━━━━━━━━━',
    '📜 رفتار تاریخی این ارز نسبت به بیت‌کوین (گذشته دور و نزدیک):',
    '• در صورت صعود BTC: ' + (hb?.whenBtcBullish ?? '—'),
    '• در صورت ریزش BTC: ' + (hb?.whenBtcBearish ?? '—'),
    '• در صورت خنثی شدن BTC: ' + (hb?.whenBtcNeutral ?? '—'),
  ].join('\n');
}

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
    if (!positive(multiplier)) throw new Error('Invalid contract multiplier');

    for (const raw of rows) {
      const ms = number(raw.create_time_ms);
      const time = positive(ms) ? ms / 1000 : number(raw.create_time);
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
      trades.push({ time, size, notional: Math.abs(size) * multiplier * price });
    }

    const truncated = rows.length >= CONFIG.TRADE_LIMIT;
    const oldest = trades.length > 0 ? Math.min(...trades.map(t => t.time)) : null;
    const coveredRecent = truncated ? oldest != null && oldest <= end - 180 : true;
    const complete = !invalid && coveredRecent;
    const recent = trades.filter(t => t.time >= end - 180 && t.time < end);

    const buy = recent.filter(t => t.size > 0).reduce((s, t) => s + t.notional, 0);
    const sell = recent.filter(t => t.size < 0).reduce((s, t) => s + t.notional, 0);
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
    return { sampleComplete: false, available: false, tradesObserved: 0 };
  }
}

export async function analyzeBtcDeep(asOf) {
  try {
    const [raw4h, raw15m] = await Promise.all([
      requestGate('candlesticks', { contract: 'BTC_USDT', interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT }),
      requestGate('candlesticks', { contract: 'BTC_USDT', interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT }),
    ]);

    const c4raw = closedCandles(raw4h, 14400, asOf);
    const c15raw = closedCandles(raw15m, 900, asOf);
    if (!validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, asOf)) throw new Error('Invalid BTC 4h series');

    const live15 = extractDevelopingCandle(raw15m, c15raw, 900, asOf);
    const full15 = live15 ? [...c15raw, live15] : c15raw;

    const c4 = indicators(c4raw);
    const c15 = full15.length >= 60 ? indicators(full15) : [];
    const last4 = c4.at(-1);
    const prev4 = c4.at(-2);
    const last15 = c15.at(-1) ?? last4;

    let regime = 'NEUTRAL';
    let regimeFa = 'خنثی / رِنج';
    if (last4.close > last4.ema50 && last4.ema20 >= last4.ema50) {
      regime = 'BULLISH';
      regimeFa = 'صعودی (Bullish)';
    } else if (last4.close < last4.ema50 && last4.ema20 <= last4.ema50) {
      regime = 'BEARISH';
      regimeFa = 'نزولی (Bearish)';
    }

    let nextMoveForecast = '';
    const macdRising4h = last4.macdHist > prev4.macdHist;
    const shortTermBullish = last15.close > last15.ema20 && last15.rsi > 52;
    const shortTermBearish = last15.close < last15.ema20 && last15.rsi < 48;

    if (regime === 'BEARISH') {
      if (last4.rsi < 34 || (macdRising4h && shortTermBullish)) {
        nextMoveForecast = '🔄 فروشندگان در حال خسته شدن هستند؛ احتمال توقف ریزش، خنثی شدن و چرخش صعودی کوتاه‌مدت بالاست.';
      } else if (last4.adx >= 25 && !macdRising4h && shortTermBearish) {
        nextMoveForecast = '📉 فشار فروش همچنان بالاست و بیت‌کوین تمایل به ادامه حرکت نزولی دارد (در معاملات Long محتاط باشید).';
      } else {
        nextMoveForecast = '⚖️ روند کلی نزولی است اما شتاب ریزش کم شده و احتمال ورود به فاز نوسان خنثی (رِنج) وجود دارد.';
      }
    } else if (regime === 'BULLISH') {
      if (last4.rsi > 70 || (!macdRising4h && shortTermBearish)) {
        nextMoveForecast = '⚠️ اشباع خرید در کوتاه‌مدت؛ احتمال استراحت قیمت، خنثی شدن یا اصلاح جزئی قبل از ادامه صعود.';
      } else if (last4.adx >= 24 && macdRising4h && shortTermBullish) {
        nextMoveForecast = '🚀 خریداران مسلط هستند و بیت‌کوین پتانسیل ادامه حرکت صعودی پرقدرت را دارد.';
      } else {
        nextMoveForecast = '📈 ساختار صعودی پایدار است اما فعلاً با شیب ملایم و نوسان رو به بالا حرکت می‌کند.';
      }
    } else {
      if (shortTermBullish && macdRising4h) {
        nextMoveForecast = '🌱 بیت‌کوین در حال خروج از فاز خنثی و جمع کردن انرژی برای تبدیل شدن به روند صعودی است.';
      } else if (shortTermBearish && !macdRising4h) {
        nextMoveForecast = '🌧️ ضعف در سقف رِنج؛ احتمال چرخش بیت‌کوین از حالت خنثی به نزولی وجود دارد.';
      } else {
        nextMoveForecast = '⏸️ بیت‌کوین کاملاً در فاز خنثی (رِنج) قرار دارد؛ بهترین زمان برای حرکت مستقل آلت‌کوین‌هاست.';
      }
    }

    return {
      regime,
      regimeFa,
      rsi4h: round(last4.rsi, 1),
      rsi15m: round(last15.rsi, 1),
      adx4h: round(last4.adx, 1),
      nextMoveForecast,
      c4,
      c15: indicators(c15raw),
    };
  } catch (error) {
    console.error('[BTC]', error.message);
    return { regime: 'UNKNOWN', regimeFa: 'نامشخص', nextMoveForecast: 'عدم دسترسی موقت به دیتای BTC', c4: [], c15: [] };
  }
}

async function scanOne(market, context) {
  const [raw15, raw4] = await Promise.all([
    requestGate('candlesticks', { contract: market.symbol, interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT }),
    requestGate('candlesticks', { contract: market.symbol, interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT }),
  ]);

  const c15raw = closedCandles(raw15, 900, context.asOf);
  const c4raw = closedCandles(raw4, 14400, context.asOf);

  if (any([c15raw.length < CONFIG.MIN_CANDLES_15M, c4raw.length < CONFIG.MIN_CANDLES_4H])) {
    return reject(context, 'INSUFFICIENT_CANDLES');
  }

  const valid15 = validSeries(c15raw, 900, CONFIG.MIN_CANDLES_15M, context.asOf);
  const valid4 = validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, context.asOf);
  if (!valid15 || !valid4) return reject(context, 'STALE_OR_GAPPED_CANDLES');

  const c15Closed = indicators(c15raw);
  const c4 = indicators(c4raw);

  let longCandidate = CONFIG.ENABLE_LONG ? analyze(market, c15Closed, c4, context, 'LONG', false) : null;
  let shortCandidate = CONFIG.ENABLE_SHORT ? analyze(market, c15Closed, c4, context, 'SHORT', false) : null;

  if (!longCandidate && !shortCandidate && CONFIG.ENABLE_INTRABAR_15M) {
    const liveCandle = extractDevelopingCandle(raw15, c15raw, 900, context.asOf);
    if (liveCandle && liveCandle.elapsedSeconds >= CONFIG.MIN_INTRABAR_ELAPSED_SECONDS) {
      const c15Live = indicators([...c15raw, liveCandle]);
      longCandidate = CONFIG.ENABLE_LONG ? analyze(market, c15Live, c4, context, 'LONG', true) : null;
      shortCandidate = CONFIG.ENABLE_SHORT ? analyze(market, c15Live, c4, context, 'SHORT', true) : null;
    }
  }

  if (longCandidate && shortCandidate) return reject(context, 'CONFLICTING_DIRECTIONS');
  const candidate = longCandidate ?? shortCandidate;
  if (!candidate) return null;

  const flow = await flowConfirmation(market, context);
  const longSide = candidate.side === 'LONG';

  const confirmed =
    flow.sampleComplete &&
    (longSide
      ? flow.buyNotional >= CONFIG.MIN_RECENT_BUY_NOTIONAL && flow.buySharePct >= 54 && flow.netDelta > 0
      : flow.sellNotional >= CONFIG.MIN_RECENT_SELL_NOTIONAL && flow.sellSharePct >= 54 && flow.netDelta < 0);

  if (candidate.isIntrabar && flow.sampleComplete) {
    const oppositeFlow = longSide ? flow.sellSharePct >= 55 : flow.buySharePct >= 55;
    if (oppositeFlow) return reject(context, 'INTRABAR_FLOW_REJECTED', candidate.side);
  }

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

  candidate.grade = candidate.score >= 82 ? 'A+' : candidate.score >= 74 ? 'A' : 'B';
  candidate.recent3m = flow;
  candidate.volume = { recent3m: flow };
  candidate.dataQuality = { recent3mComplete: flow.sampleComplete };
  candidate.tradesObserved = flow.tradesObserved ?? 0;
  candidate.liveInsight = buildLiveSignalIntelligence(candidate, flow);

  delete candidate._required;
  return candidate;
}

export async function scanGateMarkets() {
  const started = Date.now();
  const [contractsRaw, tickersRaw] = await Promise.all([requestGate('contracts'), requestGate('tickers')]);
  const contracts = requireArray(contractsRaw, 'contracts');
  const tickers = requireArray(tickersRaw, 'tickers');
  const tickerMap = new Map(tickers.map(t => [t.contract, t]));

  const active = contracts.filter(
    c =>
      typeof c.name === 'string' &&
      c.name.endsWith('_USDT') &&
      isPureCryptoSymbol(c.name) &&
      c.status === 'trading' &&
      c.in_delisting === false &&
      positive(number(c.quanto_multiplier))
  );

  const liquid = active
    .map(contract => {
      const ticker = tickerMap.get(contract.name);
      const volume = number(ticker?.volume_24h_quote);
      const price = number(ticker?.last);
      if (!positive(price) || volume == null || volume < CONFIG.MIN_QUOTE_VOLUME_24H) return null;
      return { symbol: contract.name, contract, ticker, volume };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume - a.volume);

  const asOf = Date.now() / 1000;
  const btcDeep = await analyzeBtcDeep(asOf);

  const context = {
    asOf,
    regime: btcDeep.regime,
    btcIntel: {
      regime: btcDeep.regime,
      regimeFa: btcDeep.regimeFa,
      rsi4h: btcDeep.rsi4h,
      rsi15m: btcDeep.rsi15m,
      adx4h: btcDeep.adx4h,
      nextMoveForecast: btcDeep.nextMoveForecast,
    },
    btc4: btcDeep.c4,
    btc15: btcDeep.c15,
    rejectStats: { LONG: {}, SHORT: {}, GLOBAL: {} },
    nearMisses: [],
  };

  let markets = [];
  if (context.regime === 'UNKNOWN') {
    context.rejectStats.GLOBAL.BTC_DATA_UNKNOWN_SKIPPED = liquid.length;
  } else if (CONFIG.SCAN_LIMIT > 0) {
    markets = liquid.slice(0, CONFIG.SCAN_LIMIT);
  } else {
    markets = liquid;
  }

  console.log(
    '[SCAN] Pure Crypto Active: ' +
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
        const freshMap = new Map(fresh.map(t => [t.contract, t]));
        const checkedAt = new Date().toISOString();

        candidates = candidates.filter(candidate => {
          const price = number(freshMap.get(candidate.symbol)?.last);
          if (Date.now() >= Date.parse(candidate.validUntil)) {
            reject(context, 'ENTRY_EXPIRED', candidate.side);
            return false;
          }
          if (any([!positive(price), price < candidate.entryLow, price > candidate.entryHigh])) {
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
    if (b.score !== a.score) return b.score - a.score;
    if (b.riskRewardToTp1 !== a.riskRewardToTp1) return b.riskRewardToTp1 - a.riskRewardToTp1;
    return b.quoteVolume24h - a.quoteVolume24h;
  });

  candidates = candidates.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const usableScan = markets.length === 0 ? true : failed < markets.length;

  const output = {
    success: context.regime !== 'UNKNOWN' && usableScan,
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategyVersion: STRATEGY_VERSION,
    strategyConfig: CONFIG,
    marketRegime: context.regime,
    btcIntel: context.btcIntel,
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
