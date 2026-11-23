/**
 * GATE.IO USDT PERPETUAL — ONE-HOUR LONG OPPORTUNITY RADAR
 * ------------------------------------------------------
 * File: src/scanner/marketScanner.js
 * Node.js 20+ | Public Gate.io endpoints | No order execution
 *
 * Design:
 * - Scans every active USDT perpetual with a live ticker.
 * - 1h is the decision timeframe; 15m refines timing; 4h supplies context.
 * - Uses completed candles for structure and live ticker only for current price.
 * - Ranks setups by trend/structure, pullback quality, buyer response,
 *   volume participation, relative strength, entry proximity and risk.
 * - Does not force a long when no convincing setup exists.
 * - Stores the full ranked candidate set through existing marketStorage.
 */

import { readFileSync } from 'node:fs';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

function loadEnvFile() {
  try {
    const content = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] in process.env) continue;
      let value = match[2].trim();
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
loadEnvFile();

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',
  BTC: 'BTC_USDT',
  INTERVALS: { fast: '15m', main: '1h', context: '4h', macro: '1d' },
  LIMITS: { fast: 100, main: 240, context: 100, macro: 100 },
  MIN_QUOTE_VOLUME_24H: Number.isFinite(Number(process.env.MIN_QUOTE_VOLUME_24H)) && Number(process.env.MIN_QUOTE_VOLUME_24H) > 0
    ? Number(process.env.MIN_QUOTE_VOLUME_24H) : 75000,
  CONCURRENCY: 5,
  REQUEST_SPACING_MS: 130,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 4,
  TELEGRAM_MAX_LENGTH: 3800,
  ORDERBOOK_SHORTLIST: 12,
  ORDERBOOK_LEVELS: 20,
  MIN_SCORE_TO_REPORT: 48,
  MIN_READY_SCORE: 70,
  MIN_READY_RR: 1.5,
  MAX_READY_RISK_PCT: 4.5,
  MAX_SPREAD_PCT: 0.45,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const n = value => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = xs => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (a, b) => b > 0 ? (a / b - 1) * 100 : 0;
const round = (x, d = 2) => Number.isFinite(x) ? Number(x.toFixed(d)) : null;
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const positive = x => Number.isFinite(x) && x > 0;

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const slot = requestQueue.then(async () => {
    const delay = CONFIG.REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (delay > 0) await sleep(delay);
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
      if (response.ok) return await response.json();
      const body = await response.text().catch(() => '');
      const error = new Error(`Gate ${response.status} ${path}: ${body.slice(0, 160)}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === CONFIG.RETRIES || (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 425 && error.status !== 429)) break;
    }
    const backoff = lastError?.status === 429 && lastError.retryAfter > 0
      ? Math.min(lastError.retryAfter * 1000, 30000)
      : Math.min(700 * (2 ** attempt), 12000);
    await sleep(backoff);
  }
  throw lastError || new Error(`Gate request failed: ${path}`);
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (error) { out[i] = { __error: error?.message || String(error) }; }
    }
  }));
  return out;
}

export function normalizeCandles(raw, interval) {
  const seconds = interval === '15m' ? 900 : interval === '1h' ? 3600 : 14400;
  const now = Math.floor(Date.now() / 1000);
  if (!Array.isArray(raw)) return [];
  return raw.map(row => {
    if (Array.isArray(row)) {
      // Gate futures candle array order: t, v, c, h, l, o, sum.
      return { t: n(row[0]), v: n(row[1]) ?? 0, c: n(row[2]), h: n(row[3]), l: n(row[4]), o: n(row[5]), q: n(row[6]) };
    }
    return { t: n(row.t), v: n(row.v) ?? 0, c: n(row.c), h: n(row.h), l: n(row.l), o: n(row.o), q: n(row.sum) };
  }).filter(c => c.t != null && positive(c.o) && positive(c.c) && positive(c.h) && positive(c.l) && c.h >= c.l)
    .sort((a, b) => a.t - b.t)
    .filter(c => c.t + seconds <= now - 1);
}

async function getCandles(symbol, interval, limit) {
  const raw = await requestGate(`/futures/${CONFIG.SETTLE}/candlesticks`, { contract: symbol, interval, limit });
  return normalizeCandles(raw, interval);
}

function turnover(c) {
  if (positive(c.q)) return c.q;
  return Math.max(0, c.v) * c.c;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  return mean(trs.slice(-period));
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function regressionSlope(values) {
  const len = values.length;
  if (len < 3) return 0;
  const xMean = (len - 1) / 2;
  const yMean = mean(values);
  let nume = 0, den = 0;
  for (let i = 0; i < len; i++) {
    nume += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? nume / den : 0;
}

function swingPoints(candles, left = 2, right = 2) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) hi = false;
      if (candles[j].l <= candles[i].l) lo = false;
    }
    if (hi) highs.push({ i, p: candles[i].h });
    if (lo) lows.push({ i, p: candles[i].l });
  }
  return { highs, lows };
}

function candlePressure(c) {
  const range = Math.max(c.h - c.l, c.c * 1e-8);
  const closeLocation = clamp((c.c - c.l) / range, 0, 1);
  const body = (c.c - c.o) / range;
  const upperWick = (c.h - Math.max(c.o, c.c)) / range;
  const lowerWick = (Math.min(c.o, c.c) - c.l) / range;
  return { closeLocation, body, upperWick, lowerWick };
}

export function analyzeFrame(candles, frame) {
  if (candles.length < (frame === '1h' ? 80 : 35)) return null;
  const closes = candles.map(c => c.c);
  const last = candles.at(-1);
  const prev = candles.at(-2);
  const e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const a14 = atr(candles, 14);
  const rsi14 = rsi(closes, 14);
  const ret1 = pct(last.c, prev.c);
  const ret3 = pct(last.c, candles.at(-4).c);
  const ret6 = pct(last.c, candles.at(-7).c);
  const ret12 = pct(last.c, candles.at(-13).c);
  const ret24 = pct(last.c, candles.at(-25).c);
  const recent = candles.slice(-6);
  const prior = candles.slice(-18, -6);
  const recentTurn = recent.map(turnover);
  const baseTurn = candles.slice(-31, -6).map(turnover).filter(x => x > 0);
  const volumeRatio = median(recentTurn) / Math.max(median(baseTurn), 1e-12);
  const upTurn = recent.filter(c => c.c > c.o).reduce((s, c) => s + turnover(c), 0);
  const downTurn = recent.filter(c => c.c < c.o).reduce((s, c) => s + turnover(c), 0);
  const upDownTurnRatio = upTurn / Math.max(downTurn, 1e-12);
  const pressure = mean(recent.map(c => candlePressure(c).closeLocation * 0.65 + (c.c > c.o ? 0.35 : 0)));
  const priorHigh = Math.max(...prior.map(c => c.h));
  const priorLow = Math.min(...prior.map(c => c.l));
  const recentHigh = Math.max(...recent.map(c => c.h));
  const recentLow = Math.min(...recent.map(c => c.l));
  const range = Math.max(recentHigh - recentLow, last.c * 1e-9);
  const pullbackFromHigh = pct(last.c, Math.max(...candles.slice(-18).map(c => c.h)));
  const atrPct = a14 && last.c ? a14 / last.c * 100 : 0;
  const slope = regressionSlope(closes.slice(-20)) / Math.max(last.c, 1e-12) * 100;
  const swingData = swingPoints(candles.slice(-80));
  const { highs, lows } = swingData;
  const lastTwoHighs = highs.slice(-2), lastTwoLows = lows.slice(-2);
  const higherHighs = lastTwoHighs.length === 2 && lastTwoHighs[1].p > lastTwoHighs[0].p;
  const higherLows = lastTwoLows.length === 2 && lastTwoLows[1].p > lastTwoLows[0].p;
  const lowerLows = lastTwoLows.length === 2 && lastTwoLows[1].p < lastTwoLows[0].p;
  const structureFloor = lastTwoLows.at(-1)?.p ?? priorLow;
  const distanceE20Atr = e20 && a14 ? (last.c - e20) / a14 : 0;
  const distFromRecentHighAtr = a14 ? (Math.max(...candles.slice(-12).map(c => c.h)) - last.c) / a14 : 0;
  const closeLoc = candlePressure(last).closeLocation;
  const bullishCount = recent.filter(c => c.c > c.o).length;
  const bearishAvgBody = mean(recent.filter(c => c.c < c.o).map(c => Math.abs(pct(c.c, c.o))));
  const bullishAvgBody = mean(recent.filter(c => c.c > c.o).map(c => Math.abs(pct(c.c, c.o))));
  const sellingWeakening = bearishAvgBody <= bullishAvgBody * 0.9 || downTurn <= upTurn * 0.9;

  return {
    frame, last, e9, e20, e50, atr: a14, atrPct, rsi: rsi14,
    ret1, ret3, ret6, ret12, ret24, volumeRatio, upDownTurnRatio,
    pressure, closeLoc, bullishCount, priorHigh, priorLow, recentHigh,
    recentLow, pullbackFromHigh, slope, higherHighs, higherLows,
    lowerLows, structureFloor, swingHighs: highs.map(x => x.p), swingLows: lows.map(x => x.p), distanceE20Atr, distFromRecentHighAtr,
    sellingWeakening, rangePct: range / last.c * 100,
  };
}

function scoreTrend(h1, h4) {
  let s = 0;
  if (h1.last.c > h1.e20) s += 12;
  if (h1.e20 > h1.e50) s += 10;
  if (h1.slope > 0) s += clamp(h1.slope * 8, 0, 8);
  if (h1.higherLows) s += 8;
  if (h1.higherHighs) s += 5;
  if (h4.last.c > h4.e20) s += 7;
  if (h4.e20 > h4.e50) s += 5;
  if (h4.higherLows) s += 5;
  if (h1.lowerLows) s -= 8;
  if (h4.lowerLows) s -= 8;
  return clamp(s, 0, 60);
}

function scorePullback(h1, m15) {
  let s = 0;
  const depth = Math.abs(Math.min(0, h1.pullbackFromHigh));
  if (depth >= 0.6 && depth <= 5.5) s += 15;
  else if (depth < 0.6) s += 7;
  else if (depth <= 9) s += 8;
  else s -= 8;
  if (h1.sellingWeakening) s += 10;
  if (h1.last.c >= h1.structureFloor) s += 8;
  if (h1.distanceE20Atr >= -0.8 && h1.distanceE20Atr <= 1.2) s += 8;
  if (m15.last.c > m15.e9 && m15.ret3 > 0) s += 8;
  if (m15.closeLoc >= 0.62) s += 5;
  return clamp(s, 0, 54);
}

function scoreBuyerResponse(h1, m15) {
  let s = 0;
  s += clamp((m15.pressure - 0.45) * 70, 0, 14);
  s += clamp((h1.pressure - 0.45) * 45, 0, 10);
  s += clamp((m15.upDownTurnRatio - 0.8) * 8, 0, 10);
  if (m15.last.c > m15.last.o && m15.closeLoc > 0.65) s += 6;
  if (m15.ret3 > 0 && m15.ret6 > 0) s += 5;
  return clamp(s, 0, 45);
}

function scoreVolume(h1, m15) {
  let s = 0;
  s += clamp((h1.volumeRatio - 0.8) * 12, 0, 12);
  s += clamp((m15.volumeRatio - 0.8) * 10, 0, 10);
  if (m15.upDownTurnRatio > 1.15) s += 5;
  return clamp(s, 0, 27);
}

function scoreRelative(h1, h4, btc1, btc4) {
  const rs1 = h1.ret6 - btc1.ret6;
  const rs4 = h4.ret6 - btc4.ret6;
  let s = 0;
  s += clamp(10 + rs1 * 2.2, 0, 15);
  s += clamp(8 + rs4 * 1.2, 0, 12);
  return { score: clamp(s, 0, 27), rs1: round(rs1), rs4: round(rs4) };
}

export function riskAndEntry(h1, m15, h4, livePrice) {
  const atr1 = h1.atr || livePrice * 0.01;
  const supports = [...h1.swingLows, ...h4.swingLows, h1.recentLow, h1.priorLow]
    .filter(x => positive(x) && x < livePrice)
    .sort((a, b) => b - a);
  const support = supports[0] ?? Math.min(h1.structureFloor, h1.recentLow);
  const invalidation = support - atr1 * 0.22;
  let riskPct = pct(invalidation, livePrice) * -1;

  const resistances = [...h1.swingHighs, ...h4.swingHighs, h1.priorHigh, h4.priorHigh]
    .filter(x => positive(x) && x > livePrice * 1.002)
    .sort((a, b) => a - b);
  const resistance1 = resistances[0] ?? null;
  const resistance2 = resistances.find(x => resistance1 && x > resistance1 * 1.012) ?? null;

  const extension = h1.atr > 0 ? (livePrice - h1.e20) / h1.atr : 0;
  const entryLow = Math.max(h1.e20 - atr1 * 0.45, support + atr1 * 0.18);
  const entryHigh = Math.min(h1.e20 + atr1 * 0.18, livePrice + atr1 * 0.05);
  const zoneLow = Math.min(entryLow, entryHigh);
  const zoneHigh = Math.max(entryLow, entryHigh);
  const entryReference = clamp(livePrice, zoneLow, zoneHigh);
  riskPct = pct(invalidation, entryReference) * -1;
  const riskPerUnit = Math.max(entryReference - invalidation, atr1 * 0.35);
  const atrTarget1 = entryReference + Math.max(atr1 * 1.6, riskPerUnit * 1.35);
  const atrTarget2 = entryReference + Math.max(atr1 * 2.8, riskPerUnit * 2.1);
  const target1 = resistance1 && resistance1 < atrTarget1 * 1.15 ? resistance1 * 0.995 : atrTarget1;
  const target2 = resistance2 && resistance2 > target1 * 1.01
    ? Math.min(resistance2 * 0.995, atrTarget2 * 1.25)
    : Math.max(atrTarget2, target1 + atr1 * 0.8);
  const rewardPct = pct(target1, entryReference);
  const rr = riskPerUnit > 0 ? (target1 - entryReference) / riskPerUnit : 0;
  let score = 0;
  if (riskPct > 0 && riskPct <= 2.5) score += 12;
  else if (riskPct <= CONFIG.MAX_READY_RISK_PCT) score += 7;
  else score -= 10;
  if (rr >= 2.2) score += 14;
  else if (rr >= CONFIG.MIN_READY_RR) score += 9;
  else if (rr < 1) score -= 14;
  if (extension >= -0.6 && extension <= 0.9) score += 9;
  else if (extension <= 1.5) score += 4;
  else score -= Math.min(18, (extension - 1.5) * 8);
  const entryDistance = Math.abs(livePrice - entryReference) / atr1;
  if (entryDistance <= 0.45) score += 5;
  else if (entryDistance <= 0.9) score += 2;
  else score -= 5;

  return {
    score: clamp(score, 0, 40), support, invalidation, riskPct,
    resistance1, resistance2, rewardPct, rr, extension,
    entryLow: zoneLow, entryHigh: zoneHigh, entryReference,
    target1, target2, riskPerUnit,
  };
}

export function classifySetup(h1, m15, h4, risk, btcRegime, spreadPct, livePrice) {
  const structureOk = h1.last.c >= h1.structureFloor && !h1.lowerLows && !h4.lowerLows;
  const contextOk = h4.last.c > h4.e50 || h4.higherLows;
  const trendContinuation = h1.last.c > h1.e20 && h1.e20 > h1.e50 && h1.higherLows;
  const reversalAttempt = h1.higherLows && h1.last.c > h1.e9 && h1.ret3 > 0 && h1.sellingWeakening;
  const inEntryZone = risk.entryLow <= risk.entryHigh &&
    livePrice >= risk.entryLow && livePrice <= risk.entryHigh;
  const trigger = m15.last.c > m15.last.o && m15.last.c > m15.e9 &&
    m15.closeLoc >= 0.64 && m15.pressure >= 0.57 &&
    m15.upDownTurnRatio >= 1.05 && m15.ret3 > 0;
  const relative1 = h1.ret6 - (btcRegime.ret1h6 ?? 0);
  const relative4 = h4.ret6 - (btcRegime.ret4h6 ?? 0);
  const independentStrength = relative1 >= 1.5 && relative4 >= 2.0 && h1.ret6 > -0.8 && h4.ret6 > -1.5;
  const marketAllowed = btcRegime.label !== 'BEARISH' || independentStrength;
  const spreadAllowed = spreadPct == null || spreadPct <= CONFIG.MAX_SPREAD_PCT;
  const rrAllowed = risk.rr >= CONFIG.MIN_READY_RR && risk.riskPct > 0 && risk.riskPct <= CONFIG.MAX_READY_RISK_PCT;
  const quality = structureOk && contextOk && (trendContinuation || reversalAttempt);

  if (!quality) return { status: 'WAITING', label: 'ساختار صعودی هنوز به‌اندازه کافی تأیید نشده', eligible: false, trigger: false };
  if (btcRegime.label === 'BEARISH' && !independentStrength) return { status: 'WAITING', label: 'روند BTC نزولی است و قدرت مستقل کافی برای استثنا دیده نمی‌شود', eligible: true, trigger: false };
  if (!marketAllowed || !spreadAllowed || !rrAllowed) {
    const why = !spreadAllowed ? 'اسپرد بازار نامناسب است' : !rrAllowed ? 'نسبت سود به زیان یا ریسک ورود مناسب نیست' : 'شرایط بازار مناسب نیست';
    return { status: 'WAITING', label: why, eligible: true, trigger: false };
  }
  if (inEntryZone && trigger && risk.extension <= 1.5) {
    return { status: 'READY', label: 'قیمت در محدوده ورود و محرک ۱۵دقیقه‌ای تأیید شده', eligible: true, trigger: true };
  }
  if (!inEntryZone) return { status: 'WAITING', label: 'ساختار مناسب است؛ قیمت هنوز در محدوده ورود نیست', eligible: true, trigger: false };
  if (!trigger) return { status: 'WAITING', label: 'قیمت نزدیک محدوده ورود است؛ منتظر تأیید خریداران در ۱۵ دقیقه', eligible: true, trigger: false };
  return { status: 'WAITING', label: 'قیمت بیش از حد از ناحیه ارزش فاصله گرفته؛ تعقیب نکن', eligible: true, trigger: false };
}

export function analyzeBtcRegime(h1, h4, d1) {
  const score = (h1.last.c > h1.e20 ? 1 : -1) + (h4.last.c > h4.e20 ? 1 : -1) +
    (d1.last.c > d1.e20 ? 1 : -1) + (h1.higherLows ? 0.5 : -0.5) +
    (h4.higherLows ? 0.5 : -0.5) + (d1.higherLows ? 0.5 : -0.5);
  const hardBreakdown = h1.ret6 < -1.8 && h4.ret6 < -2.8;
  const label = hardBreakdown || score <= -2 ? 'BEARISH' : score >= 2 ? 'BULLISH' : 'NEUTRAL';
  return {
    label, score: round(score, 1),
    ret1h6: round(h1.ret6), ret4h6: round(h4.ret6), ret1d6: round(d1.ret6),
    belowEma20: { '1h': h1.last.c < h1.e20, '4h': h4.last.c < h4.e20, '1d': d1.last.c < d1.e20 },
    hardBreakdown,
  };
}

function analyzeCoin(symbol, ticker, frames, btc, marketBreadth) {
  const h1 = analyzeFrame(frames.h1, '1h');
  const m15 = analyzeFrame(frames.m15, '15m');
  const h4 = analyzeFrame(frames.h4, '4h');
  if (!h1 || !m15 || !h4) return null;
  const livePrice = n(ticker.last);
  if (!positive(livePrice)) return null;
  const spreadPct = (() => {
    const bid = n(ticker.highest_bid), ask = n(ticker.lowest_ask);
    return positive(bid) && positive(ask) && ask >= bid ? (ask / bid - 1) * 100 : null;
  })();
  const risk = riskAndEntry(h1, m15, h4, livePrice);
  const setup = classifySetup(h1, m15, h4, risk, btc.regime, spreadPct, livePrice);
  if (!setup.eligible) return null;
  const trend = scoreTrend(h1, h4);
  const pullback = scorePullback(h1, m15);
  const buyers = scoreBuyerResponse(h1, m15);
  const volume = scoreVolume(h1, m15);
  const relative = scoreRelative(h1, h4, btc.h1, btc.h4);
  const funding = n(ticker.funding_rate);
  const change24h = n(ticker.change_percentage) ?? 0;
  const turnover24h = n(ticker.volume_24h_quote) ?? 0;
  const liquidityScore = clamp((Math.log10(Math.max(turnover24h, 1)) - 4) * 9, 0, 18);
  const fundingPenalty = funding != null && funding > 0.003 ? 10 : funding != null && funding > 0.0015 ? 5 : 0;
  const dailyHeatPenalty = change24h > 25 ? Math.min(12, (change24h - 25) * 0.35) : 0;
  const independentAgainstBtc = relative.rs1 >= 1.5 && relative.rs4 >= 2.0 && h1.ret6 > -0.8 && h4.ret6 > -1.5;
  const marketTrendPenalty = btc.regime.label === 'BEARISH' ? (independentAgainstBtc ? 8 : 18) : btc.regime.label === 'NEUTRAL' ? 5 : 0;
  const breadthPenalty = marketBreadth.ratio < 0.25 ? 8 : marketBreadth.ratio < 0.4 ? 4 : 0;
  const spreadPenalty = spreadPct != null && spreadPct > CONFIG.MAX_SPREAD_PCT ? 12 : 0;
  const rawScore = (trend / 60) * 25 + (pullback / 54) * 20 + (buyers / 45) * 15 + (volume / 27) * 10 + (relative.score / 27) * 10 + (risk.score / 40) * 15 + (liquidityScore / 18) * 5;
  const score = clamp(rawScore - fundingPenalty - dailyHeatPenalty - marketTrendPenalty - breadthPenalty - spreadPenalty, 0, 100);
  if (score < CONFIG.MIN_SCORE_TO_REPORT) return null;

  const candleAgeMinutes = Math.max(0, (Date.now() / 1000 - (h1.last.t + 3600)) / 60);
  const freshnessPenalty = candleAgeMinutes > 50 ? 4 : candleAgeMinutes > 35 ? 2 : 0;
  const finalScore = clamp(score - freshnessPenalty, 0, 100);
  const finalStatus = setup.status === 'READY' && finalScore < CONFIG.MIN_READY_SCORE ? 'WAITING' : setup.status;
  const finalSetupLabel = setup.status === 'READY' && finalStatus !== 'READY'
    ? 'امتیاز نهایی به حد کیفیت لازم برای آماده‌بودن ورود نرسیده' : setup.label;

  return {
    symbol,
    contract: symbol,
    score: round(finalScore, 1),
    rankScore: round(finalScore, 1),
    persistenceScore: round((trend + pullback) / 2, 1),
    opportunityType: 'SHORT-TERM',
    tradeStatus: finalStatus,
    entryReadiness: finalStatus === 'READY' ? 'READY' : 'WAIT',
    entryTriggerConfirmed: setup.trigger,
    btcRegime: btc.regime.label,
    setupLabel: finalSetupLabel,
    price: livePrice,
    livePrice,
    change24h: round(change24h),
    quoteVolume24h: round(turnover24h, 0),
    fundingRate: funding,
    volume: { '15m': round(m15.volumeRatio, 2), '1h': round(h1.volumeRatio, 2) },
    volumeRatio15m: round(m15.volumeRatio, 2),
    volumeRatio1h: round(h1.volumeRatio, 2),
    buyerPressure15m: round(m15.pressure * 100, 1),
    buyerPressure1h: round(h1.pressure * 100, 1),
    upDownTurnover15m: round(m15.upDownTurnRatio, 2),
    rsi1h: round(h1.rsi, 1),
    atrPct1h: round(h1.atrPct, 2),
    trendScore: round(trend, 1),
    pullbackScore: round(pullback, 1),
    buyerScore: round(buyers, 1),
    volumeScore: round(volume, 1),
    relativeScore: round(relative.score, 1),
    relativeStrength: { excess6h1h: relative.rs1, excess24h4h: relative.rs4 },
    structure: { higherHighs: h1.higherHighs, higherLows: h1.higherLows, floor: h1.structureFloor },
    entryZone: { low: risk.entryLow, high: risk.entryHigh, reference: risk.entryReference },
    invalidation: risk.invalidation,
    target1: risk.target1,
    target2: risk.target2,
    resistance1: risk.resistance1,
    resistance2: risk.resistance2,
    spreadPct: round(spreadPct, 3),
    rrToTarget1: round(risk.rr, 2),
    riskPercent: round(risk.riskPct, 2),
    rewardToTarget1Percent: round(risk.rewardPct, 2),
    extensionAtr: round(risk.extension, 2),
    moveStatus: finalStatus === 'READY' ? 'ENTRY_CONFIRMED' : 'WAIT_FOR_CONFIRMATION',
    stage: finalStatus === 'READY' ? 'READY' : 'FORMING',
    reasons: [
      h1.higherLows ? 'کف‌های بالاتر در یک‌ساعته' : null,
      h1.e20 > h1.e50 ? 'چیدمان مثبت EMA20/EMA50' : null,
      h1.sellingWeakening ? 'ضعیف‌شدن فشار فروش در اصلاح' : null,
      m15.pressure >= 0.56 ? 'واکنش مثبت خریداران در ۱۵ دقیقه' : null,
      m15.upDownTurnRatio > 1.15 ? 'گردش مالی کندل‌های صعودی بیشتر از نزولی' : null,
      relative.rs1 > 0 ? 'عملکرد بهتر از BTC در ۶ ساعت اخیر' : null,
      btc.regime.label === 'BULLISH' ? 'زمینه بیت‌کوین همسو با لانگ' : btc.regime.label === 'NEUTRAL' ? 'زمینه بیت‌کوین خنثی' : 'هشدار: زمینه بیت‌کوین نزولی',
      spreadPct != null && spreadPct > CONFIG.MAX_SPREAD_PCT ? 'هشدار: اسپرد بالا' : null,
      risk.extension > 1.5 ? 'هشدار: قیمت از میانگین یک‌ساعته فاصله گرفته' : null,
    ].filter(Boolean),
    _sort: { trend, pullback, buyers, volume, relative: relative.score, risk: risk.score, liquidityScore },
  };
}

async function getOrderBook(symbol) {
  const book = await requestGate(`/futures/${CONFIG.SETTLE}/order_book`, { contract: symbol, limit: CONFIG.ORDERBOOK_LEVELS });
  const bids = (book.bids || []).reduce((s, x) => s + (n(x.p) || 0) * Math.abs(n(x.s) || 0), 0);
  const asks = (book.asks || []).reduce((s, x) => s + (n(x.p) || 0) * Math.abs(n(x.s) || 0), 0);
  const total = bids + asks;
  return { bidShare: total > 0 ? bids / total * 100 : null, imbalance: asks > 0 ? bids / asks : null };
}

export function rankCandidates(items) {
  return items.sort((a, b) => {
    const statusOrder = { READY: 0, WAITING: 1 };
    const sa = statusOrder[a.tradeStatus] ?? 9;
    const sb = statusOrder[b.tradeStatus] ?? 9;
    if (sa !== sb) return sa - sb;
    if (b.score !== a.score) return b.score - a.score;
    if (b._sort?.risk !== a._sort?.risk) return b._sort.risk - a._sort.risk;
    return (b.quoteVolume24h || 0) - (a.quoteVolume24h || 0);
  }).map((x, i) => ({ ...x, rank: i + 1 }));
}

function reportLine(c, i) {
  const status = c.tradeStatus === 'READY' ? '🟢 آماده بررسی ورود' : '🟡 در انتظار؛ فعلاً خرید نکن';
  return [
    `${i + 1}. ${c.symbol} | امتیاز ${c.score}/100 | ${status}`,
    `قیمت: ${c.price} | تغییر ۲۴ساعت: ${fmt(c.change24h)}% | RSI: ${fmt(c.rsi1h, 1)}`,
    `فشار خریدار: ۱۵د ${fmt(c.buyerPressure15m, 0)}% / ۱س ${fmt(c.buyerPressure1h, 0)}% | حجم نسبی: ۱۵د ${fmt(c.volumeRatio15m)}x / ۱س ${fmt(c.volumeRatio1h)}x`,
    `محدوده ورود: ${c.entryZone.low} تا ${c.entryZone.high} | قیمت مرجع: ${c.entryZone.reference}`,
    `حد ضرر/ابطال: ${c.invalidation} | TP1: ${c.target1} | TP2: ${c.target2} | R:R تا TP1: ${fmt(c.rrToTarget1)} | ریسک: ${fmt(c.riskPercent)}%`,
    `دلیل رتبه: ${c.reasons.length ? c.reasons.join('؛ ') : c.setupLabel}`,
  ].join('\n');
}

function buildReport(output) {
  const lines = [
    '🚀 GATE.IO | رادار فرصت لانگ یک‌ساعته',
    '━━━━━━━━━━━━━━━━━━',
    `زمان: ${output.scannedAt}`,
    `بازار فعال: ${output.stats.active} | بررسی موفق: ${output.stats.success} | خطا: ${output.stats.failed}`,
    `نامزدهای واجد شرایط: ${output.stats.candidates} | آماده ورود: ${output.stats.ready} | در انتظار: ${output.stats.waiting}`,
    `وضعیت BTC: ${output.btc.regime} | بازه صعودی بازار: ${fmt(output.marketBreadth.positivePct, 1)}%`,
    'رتبه‌بندی بر اساس ساختار، کیفیت اصلاح، واکنش خریدار، حجم، قدرت نسبی، ریسک و شرایط بازار',
    '━━━━━━━━━━━━━━━━━━',
  ];
  const ready = output.candidates.filter(c => c.tradeStatus === 'READY');
  const waiting = output.candidates.filter(c => c.tradeStatus !== 'READY');
  if (!ready.length) lines.push('⛔ در این اسکن هیچ موقعیت آماده ورود تأیید نشد.');
  else { lines.push('🟢 فرصت‌های آماده ورود:'); ready.forEach((c, i) => lines.push(reportLine(c, i), '━━━━━━━━━━━━━━━━━━')); }
  if (waiting.length) { lines.push('🟡 فهرست انتظار (خرید فعلاً تأیید نشده):'); waiting.forEach((c, i) => lines.push(reportLine(c, i), '━━━━━━━━━━━━━━━━━━')); }
  lines.push('⚠️ این گزارش رتبه‌بندی تحلیلی است، نه تضمین سود یا دستور ورود. قیمت و ساختار ممکن است سریع تغییر کنند.');
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Credentials missing; report printed locally only.');
    return false;
  }
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > CONFIG.TELEGRAM_MAX_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`);
    await sleep(350);
  }
  return true;
}

export async function scanGateMarkets() {
  const started = Date.now();
  console.log('\n🚀 GATE.IO ONE-HOUR LONG RADAR');
  const [contracts, tickers] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/contracts`),
    requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);
  const tickerMap = new Map((tickers || []).map(t => [t.contract, t]));
  const activeContracts = (contracts || []).filter(c =>
    typeof c.name === 'string' && c.name.endsWith('_USDT') &&
    c.status === 'trading' && c.in_delisting === false
  );
  const markets = activeContracts.map(c => {
    const ticker = tickerMap.get(c.name);
    const qv = n(ticker?.volume_24h_quote) ?? 0;
    return ticker && positive(n(ticker.last)) && qv >= CONFIG.MIN_QUOTE_VOLUME_24H
      ? { symbol: c.name, ticker, quoteVolume24h: qv } : null;
  }).filter(Boolean);

  const btcTicker = tickerMap.get(CONFIG.BTC);
  if (!btcTicker) throw new Error('BTC_USDT ticker is unavailable; benchmark cannot be calculated.');
  const [btc1hCandles, btc4hCandles, btc1dCandles] = await Promise.all([
    getCandles(CONFIG.BTC, '1h', CONFIG.LIMITS.main),
    getCandles(CONFIG.BTC, '4h', CONFIG.LIMITS.context),
    getCandles(CONFIG.BTC, '1d', CONFIG.LIMITS.macro),
  ]);
  const btc = {
    h1: analyzeFrame(btc1hCandles, '1h'),
    h4: analyzeFrame(btc4hCandles, '4h'),
    d1: analyzeFrame(btc1dCandles, '1d'),
  };
  if (!btc.h1 || !btc.h4 || !btc.d1) throw new Error('BTC benchmark history is insufficient.');
  btc.regime = analyzeBtcRegime(btc.h1, btc.h4, btc.d1);
  const breadthEligible = markets.map(m => n(m.ticker.change_percentage)).filter(Number.isFinite);
  const positiveBreadth = breadthEligible.filter(x => x > 0).length;
  const marketBreadth = {
    total: breadthEligible.length,
    positive: positiveBreadth,
    ratio: breadthEligible.length ? positiveBreadth / breadthEligible.length : 0.5,
    positivePct: breadthEligible.length ? positiveBreadth / breadthEligible.length * 100 : 50,
  };

  console.log(`Active contracts: ${activeContracts.length} | Liquid markets: ${markets.length}`);
  let success = 0, failed = 0, completed = 0, qualifiedSoFar = 0;
  const analyzed = await mapPool(markets, CONFIG.CONCURRENCY, async market => {
    const [m15, h1, h4] = await Promise.all([
      getCandles(market.symbol, '15m', CONFIG.LIMITS.fast),
      getCandles(market.symbol, '1h', CONFIG.LIMITS.main),
      getCandles(market.symbol, '4h', CONFIG.LIMITS.context),
    ]);
    const candidate = analyzeCoin(market.symbol, market.ticker, { m15, h1, h4 }, btc, marketBreadth);
    success++;
    completed++;
    if (candidate) qualifiedSoFar++;
    if (completed % 50 === 0) console.log(`[PROGRESS] ${completed}/${markets.length} | qualified: ${qualifiedSoFar}`);
    return candidate;
  });
  const candidates = [];
  for (const item of analyzed) {
    if (item?.__error) failed++;
    else if (item) candidates.push(item);
  }
  const rankedAll = rankCandidates(candidates);

  // Optional order-book evidence is fetched only for a small shortlist to limit rate pressure.
  const bookShortlist = rankedAll.slice(0, CONFIG.ORDERBOOK_SHORTLIST);
  const books = await mapPool(bookShortlist, 3, item => getOrderBook(item.symbol));
  books.forEach((book, i) => {
    if (book && !book.__error) {
      bookShortlist[i].orderBook = book;
      const bid = book.bidShare;
      if (Number.isFinite(bid)) {
        bookShortlist[i].orderBook.bidShare = round(bid, 1);
        bookShortlist[i].orderBook.imbalance = round(book.imbalance, 3);
      }
    }
  });
  const ranked = rankCandidates(rankedAll);
  ranked.forEach((c, i) => { c.rank = i + 1; delete c._sort; });

  const output = {
    success: true,
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategy: 'ONE-HOUR LONG OPPORTUNITY RADAR',
    scannedAt: new Date().toISOString(),
    stats: {
      active: activeContracts.length,
      liquid: markets.length,
      success,
      failed,
      candidates: candidates.length,
      ready: ranked.filter(c => c.tradeStatus === 'READY').length,
      waiting: ranked.filter(c => c.tradeStatus !== 'READY').length,
      durationMs: Date.now() - started,
    },
    btc: { change1h6: round(btc.h1.ret6), change4h6: round(btc.h4.ret6), change1d6: round(btc.d1.ret6), regime: btc.regime.label, regimeScore: btc.regime.score },
    marketBreadth,
    candidates: ranked,
    rankedCandidates: ranked,
  };

  try {
    const stored = await saveMarketSnapshot(rankedAll.map(c => ({ ...c, _sort: undefined })));
    output.historyCount = stored?.historyCount ?? 0;
    output.summaryCount = stored?.summaryCount ?? rankedAll.length;
    output.rankChanges = stored?.rankChanges ?? {};
  } catch (error) {
    console.error('[STORAGE] Snapshot save failed:', error.message);
  }

  const report = buildReport(output);
  console.log(report);
  console.log(`\nFinished in ${(output.stats.durationMs / 1000).toFixed(1)}s | scanned ${markets.length} | success ${success} | failed ${failed}`);
  await sendTelegram(report);
  return output;
}

// Direct execution is the default. Set SCANNER_NO_AUTORUN=1 for isolated tests/imports.
if (process.env.SCANNER_NO_AUTORUN !== '1') {
try {
  const result = await scanGateMarkets();
  console.log('[SCANNER RESULT]', JSON.stringify({
    success: result.success,
    active: result.stats.active,
    liquid: result.stats.liquid,
    successful: result.stats.success,
    failed: result.stats.failed,
    candidates: result.stats.candidates,
    durationMs: result.stats.durationMs,
  }, null, 2));
} catch (error) {
  console.error('[SCANNER FATAL ERROR]', error);
  process.exitCode = 1;
}
}
