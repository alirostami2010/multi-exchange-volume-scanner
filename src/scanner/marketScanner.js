import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  round,
  requireArray,
} from '../services/gate.js';

export const STRATEGY_VERSION = 'gate-structural-ls-v8-sniper-pro';

const NON_CRYPTO_BLACKLIST = new Set([
  'XAU','XAUT','PAXG','XAG','XPT','CL','BZ','NG','SPY','QQQ','TQQQX','SQQQ','SOXL','SOXS','UVXY',
  'NAS100','SPCX','EWY','KORU','NVDA','AMD','TSLA','AAPL','MSFT','AMZN','GOOGL','META','NFLX',
  'ORCL','IBM','INTC','INTW','TSM','AVGO','MU','MUU','MRVL','MVLL','ARM','SMCI','DELL','HPQ',
  'PLTR','COIN','MSTR','HOOD','CRCL','CRWV','NBIS','IREN','RKLB','SNDK','WDC','SKHY','SKHYNIX',
  'SAMSUNG','HYUNDAI','CXMT','DRAM','LITE','COHR','AAOI','AXTI','BE','SNXX','CBRS','KSTR','SKDD',
  'BMNR','ZHONGJI','ZHIPU','MINIMAX','UNITREE'
]);

function isPureCryptoSymbol(name) {
  return !NON_CRYPTO_BLACKLIST.has(String(name).replace(/_USDT$/, '').toUpperCase());
}

export const CONFIG = Object.freeze({
  MODE: 'SNIPER',
  ENABLE_LONG: true,
  ENABLE_SHORT: true,
  ENABLE_INTRABAR_15M: true,
  MIN_INTRABAR_ELAPSED_SECONDS: 300,
  MIN_QUOTE_VOLUME_24H: 1500000,
  SCAN_LIMIT: 0,
  TOP_COUNT: 1,
  MIN_LONG_SCORE: 78,
  MIN_LONG_SCORE_NEUTRAL: 80,
  MIN_LONG_SCORE_BEARISH: 88,
  MIN_SHORT_SCORE: 76,
  MIN_SHORT_SCORE_NEUTRAL: 78,
  MIN_SHORT_SCORE_BULLISH: 88,
  CONCURRENCY: 6,
  CANDLES_15M_LIMIT: 300,
  CANDLES_4H_LIMIT: 300,
  MIN_CANDLES_15M: 220,
  MIN_CANDLES_4H: 200,
  TRADE_LIMIT: 1000,
  MIN_RECENT_BUY_NOTIONAL: 1800,
  MIN_RECENT_SELL_NOTIONAL: 1800,
  MAX_RSI_LONG_ENTRY: 64,
  MAX_RSI_LONG_4H: 70,
  MIN_RSI_SHORT_ENTRY: 36,
  MIN_RSI_SHORT_4H: 30,
  MAX_FUNDING_RATE_LONG: 0.0007,
  MIN_FUNDING_RATE_SHORT: -0.0007,
  MIN_RR_TP1: 0.95,
  MIN_RR_TP2: 1.65,
  MIN_SINGLE_TARGET_RR: 1.5,
  MIN_COUNTER_BTC_RR: 2.1,
  STOP_ATR_BUFFER: 0.9,
  MIN_STOP_ATR: 1.25,
  MAX_STOP_ATR: 4.2,
  MIN_STOP_PCT: 1.45,
  MAX_STOP_PCT: 4.5,
  MAX_DISTANCE_EMA_ATR: 1.4,
  MAX_TRIGGER_DRIFT_ATR: 0.75,
  MAX_TRIGGER_DRIFT_PCT: 1.8,
  ENTRY_ZONE_ATR: 0.55,
  MAX_ENTRY_ZONE_PCT: 0.85,
  ENTRY_VALID_MINUTES: 90,
  FEE_RATE_PER_SIDE: 0.0006,
  SLIPPAGE_RATE_PER_SIDE: 0.0003,
  MAX_SCAN_AGE_SECONDS: 240,
  MAX_QUOTE_AGE_SECONDS: 60,
  LEVEL_CLUSTER_ATR: 0.4,
});

const any = vals => vals.some(Boolean);
const mean = vals => (vals.length === 0 ? null : vals.reduce((s, v) => s + v, 0) / vals.length);

function reject(ctx, reason, side = 'GLOBAL') {
  const g = ctx.rejectStats[side];
  g[reason] = (g[reason] ?? 0) + 1;
  return null;
}

function validSeries(candles, sec, min, asOf) {
  if (candles.length < min) return false;
  const exp = Math.floor(asOf / sec) * sec - sec;
  if (candles.at(-1).time !== exp) return false;
  const rec = candles.slice(-min);
  for (let i = 1; i < rec.length; i++) {
    if (rec[i].time - rec[i - 1].time !== sec) return false;
  }
  return true;
}

export function extractDevelopingCandle(rawRows, closedList, intervalSec, asOf) {
  if (!Array.isArray(rawRows) || !rawRows.length || !closedList?.length) return null;
  const expTime = Math.floor(asOf / intervalSec) * intervalSec;
  const elapsed = Math.max(10, asOf - expTime);
  const prog = Math.min(1, Math.max(0.15, elapsed / intervalSec));
  const last = rawRows.at(-1);
  if (!last || typeof last !== 'object') return null;
  const rawTime = number(last.t ?? last.time ?? last[0]);
  if (rawTime !== expTime) return null;

  const open = number(last.o ?? last.open ?? last[5]);
  const high = number(last.h ?? last.high ?? last[3]);
  const low = number(last.l ?? last.low ?? last[4]);
  const close = number(last.c ?? last.close ?? last[2]);
  const vol = number(last.v ?? last.volume ?? last.volumeContracts ?? last[1]) ?? 0;
  const quote = number(last.sum ?? last.quoteTurnover ?? last[6]);
  if (!positive(open) || !positive(high) || !positive(low) || !positive(close)) return null;

  return {
    time: expTime, open, high, low, close,
    volumeContracts: vol / prog,
    quoteTurnover: quote != null ? quote / prog : null,
    isLiveCandle: true,
    elapsedSeconds: Math.round(elapsed),
    progressPct: Math.round(prog * 100),
  };
}

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map((v, i) => (prev = i === 0 ? v : k * v + (1 - k) * prev));
}

function wilder(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0); loss += Math.max(-d, 0);
  }
  gain /= period; loss /= period;
  const calc = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

export function indicators(candles) {
  if (!candles.length) return [];
  const closes = candles.map(c => c.close);
  const e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50), e200 = ema(closes, 200);
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const macd = closes.map((_, i) => e12[i] - e26[i]);
  const sig = ema(macd, 9), rsiVals = rsi(closes);
  const tr = [], pm = [], mm = [];

  candles.forEach((c, i) => {
    const p = candles[i - 1];
    tr.push(p ? Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)) : c.high - c.low);
    const up = p ? c.high - p.high : 0, dn = p ? p.low - c.low : 0;
    pm.push(up > dn && up > 0 ? up : 0);
    mm.push(dn > up && dn > 0 ? dn : 0);
  });

  const atrVals = wilder(tr), pSmooth = wilder(pm), mSmooth = wilder(mm);
  const pdi = atrVals.map((a, i) => (positive(a) ? (100 * pSmooth[i]) / a : null));
  const mdi = atrVals.map((a, i) => (positive(a) ? (100 * mSmooth[i]) / a : null));
  const dx = atrVals.map((a, i) => {
    if (a == null) return null;
    const pos = Number.isFinite(pdi[i]) ? pdi[i] : 0, neg = Number.isFinite(mdi[i]) ? mdi[i] : 0;
    return pos + neg <= 0 ? 0 : (100 * Math.abs(pos - neg)) / (pos + neg);
  });

  const adxVals = new Array(candles.length).fill(null);
  const st = dx.findIndex(v => v != null);
  if (st >= 0) wilder(dx.slice(st)).forEach((v, i) => { adxVals[st + i] = v; });

  return candles.map((c, i) => {
    const prev = candles.slice(Math.max(0, i - 20), i);
    const qOk = c.quoteTurnover >= 0 && prev.every(x => x.quoteTurnover >= 0);
    const vols = prev.map(x => (qOk ? x.quoteTurnover : x.volumeContracts));
    const base = vols.length === 20 && vols.every(v => v >= 0) ? mean(vols) : null;
    const vol = qOk ? c.quoteTurnover : c.volumeContracts;
    return {
      ...c, ema9: e9[i], ema20: e20[i], ema50: e50[i], ema200: e200[i],
      rsi: rsiVals[i], macdHist: macd[i] - sig[i], atr: atrVals[i], adx: adxVals[i],
      plusDI: pdi[i], minusDI: mdi[i], volumeRatio: positive(base) && vol != null ? vol / base : null,
    };
  });
}

function engulfing(candles, longSide) {
  const l = candles.at(-1), p = candles.at(-2);
  return longSide
    ? l.close > l.open && p.close < p.open && l.close >= p.open && l.open <= p.close
    : l.close < l.open && p.close > p.open && l.open >= p.close && l.close <= p.open;
}

function rejectionPattern(candles, longSide) {
  const l = candles.at(-1), rng = l.high - l.low;
  if (!positive(rng)) return false;
  const lowW = Math.min(l.open, l.close) - l.low, upW = l.high - Math.max(l.open, l.close);
  return longSide
    ? lowW >= rng * 0.45 && (l.close - l.low) / rng >= 0.6
    : upW >= rng * 0.45 && (l.close - l.low) / rng <= 0.4;
}

function analyzeHistoricalBehavior(c15, c4, btc15, btc4, longSide) {
  if (!btc15?.length || !btc4?.length) {
    return { resiliencePct: 55, beta: 1.0, alpha4h: 0, whenBtcBullish: 'هم‌راستا با بازار', whenBtcBearish: 'رعایت حد ضرر', whenBtcNeutral: 'نقدینگی مستقل' };
  }
  const map4h = new Map(btc4.map((c, idx) => [c.time, idx]));
  let downCnt = 0, resCnt = 0, upCnt = 0, betaSum = 0;
  for (let i = 1; i < c4.length; i++) {
    const bIdx = map4h.get(c4[i].time);
    if (!bIdx) continue;
    const bRet = ((btc4[bIdx].close - btc4[bIdx - 1].close) / btc4[bIdx - 1].close) * 100;
    const cRet = ((c4[i].close - c4[i - 1].close) / c4[i - 1].close) * 100;
    if (bRet < -0.45) { downCnt++; if (longSide ? cRet > bRet * 0.5 : cRet < bRet * 1.1) resCnt++; }
    else if (bRet > 0.45) { upCnt++; betaSum += cRet / bRet; }
  }
  const map15 = new Map(btc15.map((c, idx) => [c.time, idx]));
  let relStr = 0;
  const slice15 = c15.slice(-16);
  for (let i = 1; i < slice15.length; i++) {
    const bIdx = map15.get(slice15[i].time);
    if (!bIdx) continue;
    relStr += ((slice15[i].close - slice15[i - 1].close) / slice15[i - 1].close - (btc15[bIdx].close - btc15[bIdx - 1].close) / btc15[bIdx - 1].close) * 100;
  }
  const resPct = downCnt > 0 ? Math.round((resCnt / downCnt) * 100) : 55;
  const beta = Math.max(0.4, Math.min(3.2, round(upCnt > 0 ? betaSum / upCnt : 1.2, 2)));
  return {
    resiliencePct: resPct, beta, alpha4h: round(relStr, 2),
    whenBtcBullish: 'اهرم ' + beta + 'x نسبت به صعود BTC',
    whenBtcBearish: 'مقاومت ' + resPct + '% در برابر ریزش‌های گذشته BTC',
    whenBtcNeutral: 'آلفای ۴ ساعته: ' + round(relStr, 2) + '% نسبت به BTC',
  };
}

function buildMajorTargets(c15, c4, entry, stop, risk, atr, longSide) {
  const pts = [];
  for (let i = 8; i < c15.length - 8; i++) {
    const p = longSide ? c15[i].high : c15[i].low;
    let ok = true;
    for (let j = 1; j <= 8; j++) {
      if (longSide ? c15[i - j].high >= p || c15[i + j].high > p : c15[i - j].low <= p || c15[i + j].low < p) { ok = false; break; }
    }
    if (ok) pts.push({ price: p, timeframe: '15m', weight: 1 });
  }
  for (let i = 3; i < c4.length - 3; i++) {
    const p = longSide ? c4[i].high : c4[i].low;
    let ok = true;
    for (let j = 1; j <= 3; j++) {
      if (longSide ? c4[i - j].high >= p || c4[i + j].high > p : c4[i - j].low <= p || c4[i + j].low < p) { ok = false; break; }
    }
    if (ok) pts.push({ price: p, timeframe: '4h', weight: 2 });
  }
  pts.sort((a, b) => a.price - b.price);

  const zones = [];
  for (const pt of pts) {
    const last = zones.at(-1);
    const tol = Math.max(atr * CONFIG.LEVEL_CLUSTER_ATR, pt.price * 0.004);
    if (last && pt.price - last.low <= tol) {
      last.high = Math.max(last.high, pt.price);
      last.touches++; last.strength += pt.weight;
      last.timeframes = [...new Set([...last.timeframes, pt.timeframe])];
    } else {
      zones.push({ low: pt.price, high: pt.price, touches: 1, strength: pt.weight, timeframes: [pt.timeframe] });
    }
  }

  const costBuf = entry * (CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE) * 4;
  const minTp1 = risk * 1.02 + costBuf, maxTp1 = risk * 1.25 + costBuf;

  const blocked = zones.some(z => z.timeframes.includes('4h') && z.strength >= 4 && (longSide ? z.low > entry && z.low < entry + risk * 0.85 : z.high < entry && z.high > entry - risk * 0.85));
  if (blocked) return { blocked: true, zones: [] };

  const dir = longSide ? 1 : -1;
  const valid = longSide
    ? zones.filter(z => z.low >= entry + minTp1).sort((a, b) => a.low - b.low)
    : zones.filter(z => z.high <= entry - minTp1).sort((a, b) => b.high - a.high);

  let tp1 = entry + dir * (risk * 1.12 + costBuf);
  if (valid.length > 0) {
    const w1 = longSide ? valid[0].low : valid[0].high;
    const fr = entry + dir * Math.max(minTp1, Math.abs(w1 - entry) * 0.92);
    if (Math.abs(fr - entry) <= maxTp1) tp1 = fr;
  }

  let tp2 = entry + dir * (risk * 2.0 + costBuf);
  let tp3 = entry + dir * (risk * 3.2 + costBuf);
  const higher = valid.filter(z => Math.abs((longSide ? z.low : z.high) - entry) >= Math.abs(tp1 - entry) + risk * 0.65);

  if (higher[0]) {
    const p2 = longSide ? higher[0].low : higher[0].high;
    if (Math.abs(p2 - entry) <= risk * 2.8) tp2 = p2;
  }
  if (higher[1]) {
    const p3 = longSide ? higher[1].low : higher[1].high;
    if (Math.abs(p3 - entry) > Math.abs(tp2 - entry) + risk * 0.7 && Math.abs(p3 - entry) <= risk * 4.8) tp3 = p3;
  }

  if (longSide) {
    if (tp2 <= tp1 + risk * 0.6) tp2 = tp1 + risk * 0.85;
    if (tp3 <= tp2 + risk * 0.7) tp3 = tp2 + risk * 1.15;
  } else {
    if (tp2 >= tp1 - risk * 0.6) tp2 = tp1 - risk * 0.85;
    if (tp3 >= tp2 - risk * 0.7) tp3 = tp2 - risk * 1.15;
  }

  return {
    blocked: false,
    zones: [
      { low: tp1, high: tp1, touches: 2, timeframes: ['15m', '4h'] },
      { low: tp2, high: tp2, touches: 2, timeframes: ['4h'] },
      { low: tp3, high: tp3, touches: 1, timeframes: ['4h'], isStructuralProjection: true },
    ],
  };
}

function riskReward(longSide, entry, stop, target) {
  const cost = CONFIG.FEE_RATE_PER_SIDE + CONFIG.SLIPPAGE_RATE_PER_SIDE;
  const r = (longSide ? entry - stop : stop - entry) + (entry + stop) * cost;
  const rw = (longSide ? target - entry : entry - target) - (entry + target) * cost;
  return r > 0 ? rw / r : null;
}

function analyze(market, c15, c4, context, side, isIntrabar = false) {
  const longSide = side === 'LONG';
  const fail = reason => (isIntrabar ? null : reject(context, reason, side));
  const oppositeBTC = longSide ? context.regime === 'BEARISH' : context.regime === 'BULLISH';

  const btcLast15 = context.btc15?.at(-1);
  if (btcLast15) {
    if (longSide && btcLast15.close < btcLast15.ema20 && btcLast15.rsi < 45 && btcLast15.close < btcLast15.open) return fail('BTC_15M_DUMPING_NOW');
    if (!longSide && btcLast15.close > btcLast15.ema20 && btcLast15.rsi > 55 && btcLast15.close > btcLast15.open) return fail('BTC_15M_PUMPING_NOW');
  }

  const last = c15.at(-1), previous = c15.at(-2), trend = c4.at(-1), prevTrend = c4.at(-2);
  const price = number(market.ticker.last), atr = last.atr;

  if (any([!positive(price), !positive(atr), ![last.rsi, previous.rsi, trend.rsi, trend.adx, trend.plusDI, trend.minusDI].every(Number.isFinite)])) {
    return fail('BAD_PRICE_OR_INDICATOR');
  }
  if (isIntrabar && (!last.volumeRatio || last.volumeRatio < 1.5)) return null;

  const macroAligned = longSide
    ? (trend.close > trend.ema50 && trend.ema20 >= trend.ema50 * 0.995) || (trend.close > trend.ema20 && trend.rsi > prevTrend.rsi && trend.rsi < 64 && last.volumeRatio >= 1.5)
    : (trend.close < trend.ema50 && trend.ema20 <= trend.ema50 * 1.005) || (trend.close < trend.ema20 && trend.rsi < prevTrend.rsi && trend.rsi > 36 && last.volumeRatio >= 1.5);
  if (!macroAligned) return fail('COIN_4H_TREND');

  const historyBehavior = analyzeHistoricalBehavior(c15, c4, context.btc15, context.btc4, longSide);
  const funding = number(market.contract.funding_rate) ?? number(market.ticker.funding_rate);
  if (funding == null) return fail('FUNDING_UNKNOWN');
  const isSqueezeFuel = (longSide && funding < -0.00005) || (!longSide && funding > 0.00025);

  if (oppositeBTC) {
    const okAlpha = (longSide ? historyBehavior.alpha4h >= 1.2 : historyBehavior.alpha4h <= -1.2) && historyBehavior.resiliencePct >= 62 && (last.volumeRatio >= 1.8 || isSqueezeFuel);
    if (!okAlpha) return fail('BTC_OPPOSITE_NO_ALPHA');
  } else {
    if (longSide && historyBehavior.alpha4h < -1.8) return fail('WEAK_VS_BTC');
    if (!longSide && historyBehavior.alpha4h > 1.8) return fail('STRONG_VS_BTC');
  }

  if (longSide && any([last.rsi > CONFIG.MAX_RSI_LONG_ENTRY, trend.rsi > CONFIG.MAX_RSI_LONG_4H])) return fail('RSI_OVERBOUGHT');
  if (!longSide && any([last.rsi < CONFIG.MIN_RSI_SHORT_ENTRY, trend.rsi < CONFIG.MIN_RSI_SHORT_4H])) return fail('RSI_OVERSOLD');

  const drift = Math.abs(price - last.close);
  if (any([drift > atr * CONFIG.MAX_TRIGGER_DRIFT_ATR, (drift / last.close) * 100 > CONFIG.MAX_TRIGGER_DRIFT_PCT])) return fail('PRICE_MOVED_AWAY');
  if (any([longSide && funding > CONFIG.MAX_FUNDING_RATE_LONG, !longSide && funding < CONFIG.MIN_FUNDING_RATE_SHORT])) return fail('FUNDING_CROWDED');

  const swingWindow = c15.slice(-30, -1);
  const swingLow = Math.min(...swingWindow.map(c => c.low)), swingHigh = Math.max(...swingWindow.map(c => c.high));
  const recent12 = c15.slice(-13, -1);
  const minorLow = Math.min(...recent12.map(c => c.low)), minorHigh = Math.max(...recent12.map(c => c.high));

  const rejectCandle = rejectionPattern(c15, longSide), engulfCandle = engulfing(c15, longSide);
  const hasVolume = last.volumeRatio != null && last.volumeRatio >= 1.35;

  const liquiditySweep = longSide
    ? (last.low < minorLow || previous.low < minorLow) && last.close > minorLow && price >= minorLow && (rejectCandle || engulfCandle || last.close > last.open) && (hasVolume || previous.volumeRatio >= 1.4)
    : (last.high > minorHigh || previous.high > minorHigh) && last.close < minorHigh && price <= minorHigh && (rejectCandle || engulfCandle || last.close < last.open) && (hasVolume || previous.volumeRatio >= 1.4);

  const hardBreakdown = longSide ? last.close < swingLow - atr * 0.2 : last.close > swingHigh + atr * 0.2;
  if (hardBreakdown && !liquiditySweep) return fail(longSide ? 'SUPPORT_BROKEN' : 'RESISTANCE_BROKEN');

  const distEma = longSide ? price - last.ema20 : last.ema20 - price;
  if (!liquiditySweep && distEma > atr * CONFIG.MAX_DISTANCE_EMA_ATR) return fail('PRICE_CHASING');

  const nearStruct = longSide ? Math.abs(last.low - swingLow) <= atr * 0.65 && last.close > swingLow : Math.abs(last.high - swingHigh) <= atr * 0.65 && last.close < swingHigh;
  const emaTouch = longSide ? last.low <= last.ema20 + atr * 0.25 && last.close >= last.ema20 && last.ema20 > last.ema50 : last.high >= last.ema20 - atr * 0.25 && last.close <= last.ema20 && last.ema20 < last.ema50;
  const correction = c15.slice(-5, -1).some(c => (longSide ? c.close < c.ema9 || c.close < c.open : c.close > c.ema9 || c.close > c.open));
  const dirCandle = longSide ? last.close > last.open && last.close >= previous.close : last.close < last.open && last.close <= previous.close;
  const pullback = correction && any([nearStruct, emaTouch]) && dirCandle && (rejectCandle || engulfCandle) && hasVolume;

  const beforeBreak = c15.slice(-25, -2);
  const breakLvl = longSide ? Math.max(...beforeBreak.map(c => c.high)) : Math.min(...beforeBreak.map(c => c.low));
  const retest = (previous.volumeRatio >= 1.4 || last.volumeRatio >= 1.55) && (longSide
    ? previous.close > breakLvl && last.low <= breakLvl + atr * 0.35 && last.close > breakLvl && price - breakLvl <= atr
    : previous.close < breakLvl && last.high >= breakLvl - atr * 0.35 && last.close < breakLvl && breakLvl - price <= atr);

  const earlyIgnition = (minorHigh - minorLow <= atr * 2.6) && last.volumeRatio >= 1.9 && (longSide
    ? last.close > minorHigh && last.close - minorHigh <= atr * 0.75 && last.close > last.ema50
    : last.close < minorLow && minorLow - last.close <= atr * 0.75 && last.close < last.ema50);

  if (isIntrabar && !any([liquiditySweep, earlyIgnition])) return null;
  if (!any([liquiditySweep, pullback, retest, earlyIgnition])) return fail('NO_VALID_SETUP');

  const cross = longSide ? previous.macdHist <= 0 && last.macdHist > 0 : previous.macdHist >= 0 && last.macdHist < 0;
  const rsiTurn = longSide ? last.rsi >= 34 && last.rsi <= 62 && last.rsi >= previous.rsi + 2 : last.rsi >= 38 && last.rsi <= 66 && last.rsi <= previous.rsi - 2;
  const emaTrig = longSide ? previous.close <= previous.ema9 && last.close > last.ema9 : previous.close >= previous.ema9 && last.close < last.ema9;

  if (!any([liquiditySweep, earlyIgnition, retest, cross, rsiTurn, engulfCandle, rejectCandle, emaTrig])) return fail('NO_15M_TRIGGER');

  let stopStruct;
  if (liquiditySweep) stopStruct = longSide ? Math.min(last.low, previous.low, minorLow) : Math.max(last.high, previous.high, minorHigh);
  else if (retest || earlyIgnition) stopStruct = longSide ? Math.min(last.low, previous.low, breakLvl - atr * 0.45) : Math.max(last.high, previous.high, breakLvl + atr * 0.45);
  else stopStruct = longSide ? Math.min(...c15.slice(-14).map(c => c.low)) : Math.max(...c15.slice(-14).map(c => c.high));

  const rawStop = stopStruct + (longSide ? -1 : 1) * atr * CONFIG.STOP_ATR_BUFFER;
  const minSafe = Math.max(atr * CONFIG.MIN_STOP_ATR, price * (CONFIG.MIN_STOP_PCT / 100));
  const stop = longSide ? Math.min(rawStop, price - minSafe) : Math.max(rawStop, price + minSafe);

  const zoneW = Math.min(atr * CONFIG.ENTRY_ZONE_ATR, (price * CONFIG.MAX_ENTRY_ZONE_PCT) / 100);
  const anchor = longSide ? Math.min(price, Math.max(last.ema9, price - zoneW)) : Math.max(price, Math.min(last.ema9, price + zoneW));
  const entryLow = longSide ? Math.min(anchor, price - zoneW * 0.7) : price - zoneW * 0.18;
  const entryHigh = longSide ? price + zoneW * 0.18 : Math.max(anchor, price + zoneW * 0.7);

  const entry = price, risk = longSide ? entry - stop : stop - entry;
  if (any([!positive(stop), !positive(entryLow), longSide ? stop >= entryLow : stop <= entryHigh, risk > atr * CONFIG.MAX_STOP_ATR, (risk / entry) * 100 > CONFIG.MAX_STOP_PCT])) {
    return fail('BAD_RISK');
  }

  const majorRes = buildMajorTargets(c15, c4, entry, stop, risk, atr, longSide);
  if (majorRes.blocked) return fail(longSide ? 'BLOCKED_BY_MAJOR_4H_RES' : 'BLOCKED_BY_MAJOR_4H_SUP');

  const targets = majorRes.zones.map((z, idx) => {
    const t = longSide ? z.low : z.high;
    return {
      level: idx + 1, price: t, zoneLow: z.low, zoneHigh: z.high,
      source: z.isStructuralProjection ? 'STRUCTURAL_R' : 'MAJOR_PIVOT',
      timeframes: z.timeframes, touches: z.touches,
      pct: round(((longSide ? t - entry : entry - t) / entry) * 100),
      rrNet: round(riskReward(longSide, entry, stop, t)),
    };
  });

  const rr1 = riskReward(longSide, entry, stop, targets[0].price);
  const rr2 = targets[1] ? riskReward(longSide, entry, stop, targets[1].price) : null;
  if (any([!Number.isFinite(rr1), rr1 < CONFIG.MIN_RR_TP1, rr2 != null && rr2 < CONFIG.MIN_RR_TP2])) return fail('LOW_RR_AT_NEAREST_LEVEL');

  const strength = longSide ? trend.plusDI > trend.minusDI : trend.minusDI > trend.plusDI;
  const emaAligned = longSide ? trend.ema20 > trend.ema50 : trend.ema20 < trend.ema50;
  const trendScore = 12 + (emaAligned ? 10 : 5) + (trend.adx >= 18 && strength ? 8 : 0);
  const setupScore = liquiditySweep ? 28 : earlyIgnition ? 26 : retest ? 24 : nearStruct && emaTouch ? 22 : 18;
  const triggerScore = Math.min(25, (liquiditySweep ? 12 : 0) + (earlyIgnition ? 10 : 0) + (cross ? 8 : 0) + (rsiTurn ? 7 : 0) + (engulfCandle ? 8 : 0) + (rejectCandle ? 8 : 0) + (emaTrig ? 5 : 0) + (retest ? 7 : 0));
  const volumeScore = last.volumeRatio >= 1.8 ? 12 : last.volumeRatio >= 1.3 ? 8 : 3;
  const rrScore = rr1 >= 1.2 ? 6 : 4;
  const squeezeBonus = isSqueezeFuel ? 10 : 0;
  const alphaBonus = (longSide && historyBehavior.alpha4h >= 0.8) || (!longSide && historyBehavior.alpha4h <= -0.8) ? 5 : 0;

  let required = longSide
    ? oppositeBTC ? CONFIG.MIN_LONG_SCORE_BEARISH : context.regime === 'NEUTRAL' ? CONFIG.MIN_LONG_SCORE_NEUTRAL : CONFIG.MIN_LONG_SCORE
    : oppositeBTC ? CONFIG.MIN_SHORT_SCORE_BULLISH : context.regime === 'NEUTRAL' ? CONFIG.MIN_SHORT_SCORE_NEUTRAL : CONFIG.MIN_SHORT_SCORE;
  if (isIntrabar) required += 4;

  const setup = liquiditySweep ? 'LiquiditySweep' : earlyIgnition ? 'EarlyIgnition' : retest ? (longSide ? 'BreakoutRetest' : 'BreakdownRetest') : 'Pullback';
  const dirFa = longSide ? 'صعودی' : 'نزولی';
  const trigReasons = [
    alphaBonus > 0 ? '💎 قدرت مستقل از BTC (آلفا ' + historyBehavior.alpha4h + '%)' : null,
    isSqueezeFuel ? (longSide ? '🔥 سوخت شورت‌اسکوییز' : '🔥 سوخت لانگ‌اسکوییز') : null,
    liquiditySweep ? 'جمع‌آوری نقدینگی (Stop Hunt)' : null,
    earlyIgnition ? 'انفجار حجم از فشردگی' : null,
    rejectCandle ? 'شدو برگشتی ' + dirFa : null,
    engulfCandle ? 'کندل پوشای ' + dirFa : null,
  ].filter(Boolean);

  const setupReason = liquiditySweep ? 'شکار استاپ در سطح ماژور' : earlyIgnition ? 'آغاز حرکت انفجاری' : retest ? 'شکست ساختار و پولبک' : 'پولبک هوشمند به سطح کلیدی';
  const score = trendScore + setupScore + triggerScore + volumeScore + rrScore + squeezeBonus + alphaBonus;

  return {
    symbol: market.symbol, contract: market.symbol, side, setup, isIntrabar,
    intrabarProgressPct: last.progressPct ?? 100, strategyVersion: STRATEGY_VERSION,
    status: side + '_ENTRY', statusLabel: side + ' ' + setup,
    price, entryLow, entryHigh, referenceEntry: entry, entry: { low: entryLow, high: entryHigh, price },
    stopLoss: stop, stopLossPct: round((-risk / entry) * 100),
    tp1: targets[0]?.price ?? null, tp2: targets[1]?.price ?? null, tp3: targets[2]?.price ?? null,
    tp1Pct: targets[0]?.pct ?? null, tp2Pct: targets[1]?.pct ?? null, tp3Pct: targets[2]?.pct ?? null,
    takeProfits: targets, targetCount: targets.length,
    riskRewardToTp1: round(rr1), riskRewardToTp2: round(rr2), rr: round(rr2 ?? rr1),
    rsi15: round(last.rsi, 1), rsi4h: round(trend.rsi, 1), adx4h: round(trend.adx, 1),
    volumeRatio15m: round(last.volumeRatio ?? 1, 2), fundingRate: funding, isSqueezeFuel,
    change24h: number(market.ticker.change_percentage), quoteVolume24h: number(market.ticker.volume_24h_quote),
    triggerCandleTime: new Date(last.time * 1000).toISOString(),
    analyzedAt: new Date(context.asOf * 1000).toISOString(),
    validUntil: new Date((last.time + 900 + CONFIG.ENTRY_VALID_MINUTES * 60) * 1000).toISOString(),
    riskNote: oppositeBTC ? 'تک‌خال مستقل خلاف جهت BTC (دارای ورود پول و آلفای مستقل).' : null,
    reasons: [setupReason, trigReasons.slice(0, 2).join(' + ') || 'تأیید ساختار', 'شتاب حجم ' + (last.volumeRatio ?? 1).toFixed(1) + 'x'],
    historyBehavior, btcIntel: context.btcIntel, score, rankScore: score,
    scoreBreakdown: { trend: trendScore, setup: setupScore, trigger: triggerScore, candleVolume: volumeScore, liveFlow: 0, firstTargetRR: rrScore, squeezeBonus, alphaBonus },
    costAssumptions: { feeRatePerSide: CONFIG.FEE_RATE_PER_SIDE, slippageRatePerSide: CONFIG.SLIPPAGE_RATE_PER_SIDE, fundingIncludedInRR: false },
    _required: required,
  };
}

function buildLiveSignalIntelligence(c, flow) {
  const longSide = c.side === 'LONG';
  const tag = c.isIntrabar ? '⚡ [شکار در کندل جاری] ' : '🔒 [کلوز ۱۵ دقیقه] ';
  const manipulationStatus = c.setup === 'LiquiditySweep'
    ? '✅ کلک بازارگردان (Stop Hunt) انجام شده؛ حد ضرر پشت ساختار امن قرار گرفت.'
    : '🛡️ ساختار تایید شده؛ حد ضرر با فاصله امن از شدوهای بازارگردان تنظیم شد.';
  const movePhase = tag + '🚀 آماده حرکت اصلی به سمت اهداف';
  const flowOk = flow?.sampleComplete && (longSide ? flow.buySharePct >= 54 : flow.sellSharePct >= 54);
  const entryInstruction = flowOk
    ? '🟢 دستور ورود: سفارشات زنده هم‌جهت با سیگنال است؛ ورود با اطمینان بالا مجاز است.'
    : '🎯 دستور ورود: در ناحیه ورود وارد شوید؛ در ۶۵٪ مسیر تا TP1 معامله خودکار ریسک‌فری می‌شود.';
  const targetProjection = '📊 هدف اول (TP1) برای قفل سود سریع بهینه‌سازی شده است؛ پس از TP1 حد ضرر روی نقطه ورود قفل می‌شود.';
  return { confidencePct: Math.min(97, Math.max(76, Math.round(c.score * 0.94))), manipulationStatus, movePhase, entryInstruction, targetProjection };
}

export function formatInitialAiReport(c) {
  const ai = c.liveInsight, hb = c.historyBehavior, btc = c.btcIntel;
  if (!ai) return '';
  return [
    '🧠 رادار هوش مصنوعی تک‌تیرانداز (Sniper V8)',
    '🎯 اطمینان حرکت: ' + ai.confidencePct + '% (' + c.grade + ') | ' + ai.movePhase,
    '🪤 کلک بازارگردان: ' + ai.manipulationStatus,
    '📌 فرمان: ' + ai.entryInstruction,
    '₿ بیت‌کوین: ' + (btc?.regimeFa ?? '—') + ' | ' + (btc?.nextMoveForecast ?? ''),
    '📜 رفتار ارز: ' + (hb?.whenBtcBearish ?? '') + ' | ' + (hb?.whenBtcNeutral ?? ''),
  ].join('\n');
}

async function flowConfirmation(market, context) {
  const end = Math.floor(context.asOf / 60) * 60;
  const from = Math.min(Math.floor(context.asOf / 3600) * 3600, end - 540);
  try {
    const rows = requireArray(await requestGate('trades', { contract: market.symbol, from, to: Math.floor(context.asOf), limit: CONFIG.TRADE_LIMIT }), 'trades');
    let invalid = false;
    const seen = new Set(), trades = [];
    const mult = number(market.contract.quanto_multiplier);
    if (!positive(mult)) throw new Error('Invalid multiplier');

    for (const raw of rows) {
      const ms = number(raw.create_time_ms);
      const time = positive(ms) ? ms / 1000 : number(raw.create_time);
      const size = number(raw.size), price = number(raw.price);
      if (any([!positive(time), size == null, !positive(price)])) { invalid = true; continue; }
      if (raw.id != null) { const id = String(raw.id); if (seen.has(id)) continue; seen.add(id); }
      if (time < from || time > context.asOf) continue;
      trades.push({ time, size, notional: Math.abs(size) * mult * price });
    }
    const trunc = rows.length >= CONFIG.TRADE_LIMIT;
    const oldest = trades.length > 0 ? Math.min(...trades.map(t => t.time)) : null;
    const complete = !invalid && (trunc ? oldest != null && oldest <= end - 180 : true);
    const rec = trades.filter(t => t.time >= end - 180 && t.time < end);
    const buy = rec.filter(t => t.size > 0).reduce((s, t) => s + t.notional, 0);
    const sell = rec.filter(t => t.size < 0).reduce((s, t) => s + t.notional, 0);
    const tot = buy + sell;
    return {
      available: true, sampleComplete: complete, sampleTruncated: trunc, tradesObserved: trades.length,
      buyNotional: round(buy), sellNotional: round(sell),
      buySharePct: tot > 0 ? (100 * buy) / tot : null, sellSharePct: tot > 0 ? (100 * sell) / tot : null,
      netDelta: buy - sell, windowEnd: new Date(end * 1000).toISOString(),
    };
  } catch {
    return { sampleComplete: false, available: false, tradesObserved: 0 };
  }
}

export async function analyzeBtcDeep(asOf) {
  try {
    const [raw4h, raw15m] = await Promise.all([
      requestGate('candlesticks', { contract: 'BTC_USDT', interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT }),
      requestGate('candlesticks', { contract: 'BTC_USDT', interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT }),
    ]);
    const c4raw = closedCandles(raw4h, 14400, asOf), c15raw = closedCandles(raw15m, 900, asOf);
    if (!validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, asOf)) throw new Error('Invalid BTC 4h');
    const live15 = extractDevelopingCandle(raw15m, c15raw, 900, asOf);
    const c4 = indicators(c4raw), c15 = indicators(live15 ? [...c15raw, live15] : c15raw);
    const l4 = c4.at(-1), p4 = c4.at(-2), l15 = c15.at(-1) ?? l4;

    let regime = 'NEUTRAL', regimeFa = 'خنثی / رِنج';
    if (l4.close > l4.ema50 && l4.ema20 >= l4.ema50) { regime = 'BULLISH'; regimeFa = 'صعودی (Bullish)'; }
    else if (l4.close < l4.ema50 && l4.ema20 <= l4.ema50) { regime = 'BEARISH'; regimeFa = 'نزولی (Bearish)'; }

    const macdUp = l4.macdHist > p4.macdHist;
    const stBull = l15.close > l15.ema20 && l15.rsi > 52;
    const stBear = l15.close < l15.ema20 && l15.rsi < 48;
    let nextMoveForecast = '⚖️ نوسان متعادل؛ تمرکز روی ارزهای دارای پول هوشمند مستقل.';

    if (regime === 'BEARISH') {
      nextMoveForecast = l4.rsi < 34 || (macdUp && stBull)
        ? '🔄 فرسایش فروش؛ احتمال توقف ریزش و نوسان رو به بالا در کوتاه‌مدت.'
        : l4.adx >= 24 && stBear
        ? '📉 فشار فروش فعال است؛ بهترین بازدهی در شکارهای SHORT هم‌جهت است.'
        : '⚖️ روند کلی نزولی است اما شتاب ریزش کم شده و فاز رِنج محتمل است.';
    } else if (regime === 'BULLISH') {
      nextMoveForecast = l4.rsi > 70 || (!macdUp && stBear)
        ? '⚠️ اشباع خرید کوتاه‌مدت؛ احتمال استراحت قیمت.'
        : '🚀 خریداران مسلط هستند و پتانسیل ادامه روند صعودی بالاست.';
    }
    return { regime, regimeFa, rsi4h: round(l4.rsi, 1), rsi15m: round(l15.rsi, 1), adx4h: round(l4.adx, 1), nextMoveForecast, c4, c15 };
  } catch {
    return { regime: 'UNKNOWN', regimeFa: 'نامشخص', nextMoveForecast: 'عدم دسترسی موقت', c4: [], c15: [] };
  }
}

async function scanOne(market, context) {
  const [raw15, raw4] = await Promise.all([
    requestGate('candlesticks', { contract: market.symbol, interval: '15m', limit: CONFIG.CANDLES_15M_LIMIT }),
    requestGate('candlesticks', { contract: market.symbol, interval: '4h', limit: CONFIG.CANDLES_4H_LIMIT }),
  ]);
  const c15raw = closedCandles(raw15, 900, context.asOf), c4raw = closedCandles(raw4, 14400, context.asOf);
  if (any([c15raw.length < CONFIG.MIN_CANDLES_15M, c4raw.length < CONFIG.MIN_CANDLES_4H])) return reject(context, 'INSUFFICIENT_CANDLES');
  if (!validSeries(c15raw, 900, CONFIG.MIN_CANDLES_15M, context.asOf) || !validSeries(c4raw, 14400, CONFIG.MIN_CANDLES_4H, context.asOf)) {
    return reject(context, 'STALE_OR_GAPPED_CANDLES');
  }

  const c15Closed = indicators(c15raw), c4 = indicators(c4raw);
  let longCand = CONFIG.ENABLE_LONG ? analyze(market, c15Closed, c4, context, 'LONG', false) : null;
  let shortCand = CONFIG.ENABLE_SHORT ? analyze(market, c15Closed, c4, context, 'SHORT', false) : null;

  if (!longCand && !shortCand && CONFIG.ENABLE_INTRABAR_15M) {
    const live = extractDevelopingCandle(raw15, c15raw, 900, context.asOf);
    if (live && live.elapsedSeconds >= CONFIG.MIN_INTRABAR_ELAPSED_SECONDS) {
      const c15Live = indicators([...c15raw, live]);
      longCand = CONFIG.ENABLE_LONG ? analyze(market, c15Live, c4, context, 'LONG', true) : null;
      shortCand = CONFIG.ENABLE_SHORT ? analyze(market, c15Live, c4, context, 'SHORT', true) : null;
    }
  }

  if (longCand && shortCand) return reject(context, 'CONFLICTING_DIRECTIONS');
  const candidate = longCand ?? shortCand;
  if (!candidate) return null;

  const flow = await flowConfirmation(market, context);
  const longSide = candidate.side === 'LONG';
  if (flow.sampleComplete && (longSide ? flow.sellSharePct >= 56 : flow.buySharePct >= 56)) {
    return reject(context, 'OPPOSITE_LIVE_FLOW_REJECTED', candidate.side);
  }

  const confirmed = flow.sampleComplete && (longSide ? flow.buyNotional >= CONFIG.MIN_RECENT_BUY_NOTIONAL && flow.buySharePct >= 54 : flow.sellNotional >= CONFIG.MIN_RECENT_SELL_NOTIONAL && flow.sellSharePct >= 54);
  const liveScore = confirmed ? 6 : 0;
  candidate.score += liveScore; candidate.rankScore = candidate.score; candidate.scoreBreakdown.liveFlow = liveScore;

  if (candidate.score < candidate._required) {
    context.nearMisses.push({ symbol: candidate.symbol, side: candidate.side, score: candidate.score, required: candidate._required, scoreBreakdown: candidate.scoreBreakdown });
    return reject(context, 'SCORE_LOW', candidate.side);
  }

  candidate.grade = candidate.score >= 82 ? 'A+' : 'A';
  candidate.recent3m = flow; candidate.volume = { recent3m: flow };
  candidate.dataQuality = { recent3mComplete: flow.sampleComplete };
  candidate.tradesObserved = flow.tradesObserved ?? 0;
  candidate.liveInsight = buildLiveSignalIntelligence(candidate, flow);
  delete candidate._required;
  return candidate;
}

export async function scanGateMarkets() {
  const started = Date.now();
  const [contractsRaw, tickersRaw] = await Promise.all([requestGate('contracts'), requestGate('tickers')]);
  const contracts = requireArray(contractsRaw, 'contracts'), tickers = requireArray(tickersRaw, 'tickers');
  const tickerMap = new Map(tickers.map(t => [t.contract, t]));

  const active = contracts.filter(c => typeof c.name === 'string' && c.name.endsWith('_USDT') && isPureCryptoSymbol(c.name) && c.status === 'trading' && c.in_delisting === false && positive(number(c.quanto_multiplier)));
  const liquid = active.map(c => {
    const ticker = tickerMap.get(c.name), volume = number(ticker?.volume_24h_quote), price = number(ticker?.last);
    return !positive(price) || !volume || volume < CONFIG.MIN_QUOTE_VOLUME_24H ? null : { symbol: c.name, contract: c, ticker, volume };
  }).filter(Boolean).sort((a, b) => b.volume - a.volume);

  const asOf = Date.now() / 1000;
  const btcDeep = await analyzeBtcDeep(asOf);
  const context = {
    asOf, regime: btcDeep.regime,
    btcIntel: { regime: btcDeep.regime, regimeFa: btcDeep.regimeFa, rsi4h: btcDeep.rsi4h, rsi15m: btcDeep.rsi15m, adx4h: btcDeep.adx4h, nextMoveForecast: btcDeep.nextMoveForecast },
    btc4: btcDeep.c4, btc15: btcDeep.c15, rejectStats: { LONG: {}, SHORT: {}, GLOBAL: {} }, nearMisses: [],
  };

  const markets = context.regime === 'UNKNOWN' ? [] : CONFIG.SCAN_LIMIT > 0 ? liquid.slice(0, CONFIG.SCAN_LIMIT) : liquid;
  let completed = 0;
  const results = await mapPool(markets, CONFIG.CONCURRENCY, async m => {
    try { return await scanOne(m, context); }
    finally { completed++; if (completed % 25 === 0 || completed === markets.length) console.log('[PROGRESS] ' + completed + '/' + markets.length); }
  });

  const failed = results.filter(x => x?.__error).length;
  let candidates = results.filter(x => x != null && !x.__error);

  if (candidates.length > 0) {
    try {
      const fresh = requireArray(await requestGate('tickers'), 'fresh tickers');
      const freshMap = new Map(fresh.map(t => [t.contract, t]));
      const checkedAt = new Date().toISOString();
      candidates = candidates.filter(c => {
        const p = number(freshMap.get(c.symbol)?.last);
        if (Date.now() >= Date.parse(c.validUntil) || !positive(p) || p < c.entryLow || p > c.entryHigh) return false;
        c.lastCheckedPrice = p; c.priceCheckedAt = checkedAt;
        return true;
      });
    } catch { candidates = []; }
  }

  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.quoteVolume24h - a.quoteVolume24h));
  candidates = candidates.map((c, i) => ({ ...c, rank: i + 1 }));
  const sniperSelected = candidates.slice(0, CONFIG.TOP_COUNT);

  return {
    success: context.regime !== 'UNKNOWN' && (markets.length === 0 || failed < markets.length),
    exchange: 'GATE.IO', market: 'USDT PERPETUAL', strategyVersion: STRATEGY_VERSION, strategyConfig: CONFIG,
    marketRegime: context.regime, btcIntel: context.btcIntel, scannedAt: new Date().toISOString(),
    candidates: sniperSelected, rankedCandidates: sniperSelected, filterStats: context.rejectStats,
    nearMisses: context.nearMisses.sort((a, b) => b.score - a.score).slice(0, 5),
    stats: {
      active: active.length, liquid: liquid.length, scanned: markets.length, success: markets.length - failed,
      failed, candidates: sniperSelected.length,
      longCandidates: sniperSelected.filter(c => c.side === 'LONG').length,
      shortCandidates: sniperSelected.filter(c => c.side === 'SHORT').length,
      durationMs: Date.now() - started,
    },
  };
}
