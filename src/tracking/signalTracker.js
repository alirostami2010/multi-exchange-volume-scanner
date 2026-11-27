import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  requestGate,
  closedCandles,
  positive,
  round,
} from '../services/gate.js';
import {
  indicators,
  analyzeBtcDeep,
  extractDevelopingCandle,
} from '../scanner/marketScanner.js';

const FILE = path.resolve(process.cwd(), 'data', 'signal-state.json');
const MINUTE = 60;
const DAY = 86400;
const MAX_UNHEDGED_SAME_SIDE = 4;

export const EVALUATION = Object.freeze({
  version: 'paper-fixed-stop-v1',
  maxHoldSeconds: DAY,
  observationSeconds: 2 * DAY,
  feeRate: 0.0006,
  slippageRate: 0.0003,
  fundingIncluded: false,
  entryModel: 'CONSERVATIVE_BOUNDARY_TOUCH_AFTER_DELIVERY',
  stopModel: 'FIXED_INITIAL_STOP',
  ambiguityPolicy: 'EXCLUDE_AND_REPORT',
  maxPagesPerSignalPerRun: 8,
});

function emptyState() {
  return { schemaVersion: 1, signals: {}, lastDailyReportDay: null };
}

export async function loadSignalState() {
  try {
    const state = JSON.parse(await fs.readFile(FILE, 'utf8'));
    if (state.schemaVersion !== 1 || !state.signals || typeof state.signals !== 'object' || Array.isArray(state.signals)) {
      throw new Error('Invalid signal-state.json; refusing to overwrite');
    }
    for (const s of Object.values(state.signals)) {
      if (s.status === 'PENDING_DELIVERY') {
        s.status = 'DELIVERY_UNKNOWN';
        s.deliveryNote = 'Previous execution ended before delivery confirmation';
      }
      s.liveAlertsSent ??= {};
      s.pendingLiveAlerts ??= [];
      s.activeStop ??= s.stop;
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveSignalState(state) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const temp = FILE + '.tmp';
  await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temp, FILE);
}

const hash = v => createHash('sha256').update(v).digest('hex');
export const strategyKey = (ver, cfg) => ver + '-' + hash(JSON.stringify(cfg)).slice(0, 10);
export const signalId = (c, strat) => hash([strat, c.symbol, c.side, c.triggerCandleTime].join('|')).slice(0, 24);

export function canRegister(state, candidate, strategy) {
  const id = signalId(candidate, strategy);
  if (state.signals[id]) return false;

  const activeSignals = Object.values(state.signals).filter(s =>
    ['PENDING_DELIVERY', 'PENDING_ENTRY', 'OPEN'].includes(s.status)
  );

  if (activeSignals.some(s => s.symbol === candidate.symbol && s.side === candidate.side)) {
    return false;
  }

  // قفل ضد موج دسته‌جمعی برای نسخه تک‌تیرانداز V8: حداکثر ۴ معامله بازِ ریسک‌فری‌نشده در یک جهت
  if (String(strategy).includes('v8')) {
    const unhedgedSameSide = activeSignals.filter(
      s =>
        String(s.strategy).includes('v8') &&
        s.side === candidate.side &&
        s.targetHits?.[0] == null
    ).length;

    if (unhedgedSameSide >= MAX_UNHEDGED_SAME_SIDE) {
      return false;
    }
  }

  return true;
}

export function createSignal(candidate, strategy, config = {}) {
  const entry = candidate.side === 'LONG' ? candidate.entryHigh : candidate.entryLow;
  const targets = candidate.takeProfits.map(t => t.price);
  const weights = targets.length === 3 ? [0.45, 0.35, 0.2] : targets.length === 2 ? [0.5, 0.5] : [1];

  if (
    !positive(entry) ||
    !positive(candidate.stopLoss) ||
    targets.length < 1 ||
    targets.length > 3 ||
    !targets.every(positive) ||
    !Number.isFinite(Date.parse(candidate.validUntil))
  ) {
    throw new Error('Invalid signal levels');
  }

  const long = candidate.side === 'LONG';
  if (
    !['LONG', 'SHORT'].includes(candidate.side) ||
    (long ? candidate.stopLoss >= entry : candidate.stopLoss <= entry) ||
    !targets.every((t, i) => (long ? t > (i === 0 ? entry : targets[i - 1]) : t < (i === 0 ? entry : targets[i - 1])))
  ) {
    throw new Error('Invalid directional target/stop order');
  }

  const proProtectionEnabled = String(strategy).includes('v7') || String(strategy).includes('v8');

  return {
    id: signalId(candidate, strategy),
    symbol: candidate.symbol,
    side: candidate.side,
    strategy,
    strategyConfig: config,
    evaluationVersion: EVALUATION.version,
    evaluation: { ...EVALUATION },
    proProtectionEnabled,
    createdAt: new Date().toISOString(),
    sentAt: null,
    status: 'PENDING_DELIVERY',
    entry,
    entryLow: candidate.entryLow,
    entryHigh: candidate.entryHigh,
    stop: candidate.stopLoss,
    activeStop: candidate.stopLoss,
    initialRisk: Math.abs(entry - candidate.stopLoss),
    targets,
    weights,
    targetHits: targets.map(() => null),
    validUntil: candidate.validUntil,
    triggerCandleTime: candidate.triggerCandleTime,
    score: candidate.score,
    setup: candidate.setup,
    historyBehavior: candidate.historyBehavior ?? null,
    nextMinute: null,
    entryTime: null,
    exitTime: null,
    remaining: 1,
    realizedGrossPct: 0,
    estimatedCostsPct: 0,
    netPct: null,
    netR: null,
    exits: [],
    observedMfePct: 0,
    observedMaePct: 0,
    observationMfePct: 0,
    beyondFinalTargetPct: 0,
    survivedWickCount: 0,
    postMortem: null,
    observationComplete: false,
    dataIssue: null,
    resultNotified: false,
    liveAlertsSent: {},
    pendingLiveAlerts: [],
  };
}

export function markDelivered(signal, delivery) {
  signal.sentAt = delivery.confirmedAt;
  signal.messageIds = delivery.messageIds;
  signal.status = 'PENDING_ENTRY';
  const sentSec = Date.parse(signal.sentAt) / 1000;
  signal.nextMinute = Math.ceil(sentSec / MINUTE) * MINUTE;
  const exp = Date.parse(signal.validUntil) / 1000;
  if (signal.nextMinute + MINUTE > exp) {
    signal.status = 'EXPIRED_NO_ENTRY';
    signal.exitTime = signal.sentAt;
    signal.observationComplete = true;
  }
}

const direction = (s, p) => ((s.side === 'LONG' ? p - s.entry : s.entry - p) / s.entry) * 100;
const getEffectiveStop = s => (s.proProtectionEnabled && positive(s.activeStop) ? s.activeStop : s.stop);

function touchesStop(signal, candle) {
  const stopPrice = getEffectiveStop(signal);
  if (!signal.proProtectionEnabled) {
    return signal.side === 'LONG' ? candle.low <= stopPrice : candle.high >= stopPrice;
  }
  const isInitial = Math.abs(stopPrice - signal.stop) < 1e-8;
  const wickBuf = isInitial ? signal.initialRisk * 0.35 : 0;

  if (signal.side === 'LONG') {
    if (candle.low > stopPrice) return false;
    if (candle.close <= stopPrice || candle.low <= stopPrice - wickBuf) return true;
    signal.survivedWickCount = (signal.survivedWickCount ?? 0) + 1;
    return false;
  } else {
    if (candle.high < stopPrice) return false;
    if (candle.close >= stopPrice || candle.high >= stopPrice + wickBuf) return true;
    signal.survivedWickCount = (signal.survivedWickCount ?? 0) + 1;
    return false;
  }
}

const crossedStopAtOpen = (s, c) => (s.side === 'LONG' ? c.open <= getEffectiveStop(s) : c.open >= getEffectiveStop(s));
const targetTouched = (s, c, p) => (s.side === 'LONG' ? c.high >= p : c.low <= p);
const targetAtOpen = (s, c, p) => (s.side === 'LONG' ? c.open >= p : c.open <= p);

function updateProTrailingStop(signal, candle) {
  if (!signal.proProtectionEnabled) return;
  const costOffset = signal.entry * 0.0022;
  const bePrice = signal.side === 'LONG' ? signal.entry + costOffset : signal.entry - costOffset;

  if (signal.targetHits[1] != null && signal.targets[0] != null) {
    signal.activeStop = signal.targets[0];
    return;
  }
  if (signal.targetHits[0] != null) {
    signal.activeStop = bePrice;
    return;
  }
  const tp1 = signal.targets[0];
  if (tp1 != null) {
    const dist = Math.abs(tp1 - signal.entry);
    const fav = signal.side === 'LONG' ? candle.high - signal.entry : signal.entry - candle.low;
    if (fav >= dist * 0.65) {
      signal.activeStop = bePrice;
    }
  }
}

function queueLiveAlert(signal, key, text) {
  signal.liveAlertsSent ??= {};
  signal.pendingLiveAlerts ??= [];
  if (signal.liveAlertsSent[key]) return;
  signal.liveAlertsSent[key] = new Date().toISOString();
  signal.pendingLiveAlerts.push({ key, text });
}

function recordExit(signal, price, fraction, reason, time) {
  const qty = Math.min(signal.remaining, fraction);
  if (!(qty > 0)) return;
  const gross = direction(signal, price) * qty;
  const costRate = signal.evaluation.feeRate + signal.evaluation.slippageRate;
  const costs = costRate * (1 + price / signal.entry) * 100 * qty;
  signal.realizedGrossPct += gross;
  signal.estimatedCostsPct += costs;
  signal.remaining = Math.max(0, signal.remaining - qty);
  signal.exits.push({ time: new Date(time * 1000).toISOString(), price, fraction: qty, reason, grossPct: gross, costPct: costs });
}

function finalize(signal, reason, time) {
  signal.status = 'CLOSED';
  signal.exitReason = reason;
  signal.exitTime = new Date(time * 1000).toISOString();
  signal.netPct = signal.realizedGrossPct - signal.estimatedCostsPct;
  signal.netR = signal.netPct / ((signal.initialRisk / signal.entry) * 100);
}

function ambiguous(signal, reason, time) {
  signal.status = 'AMBIGUOUS';
  signal.ambiguityReason = reason;
  signal.exitTime = new Date(time * 1000).toISOString();
  signal.netPct = null;
  signal.netR = null;
}

function observePrice(signal, candle) {
  const favP = signal.side === 'LONG' ? candle.high : candle.low;
  const advP = signal.side === 'LONG' ? candle.low : candle.high;
  const favorable = Math.max(0, direction(signal, favP));
  const adverse = Math.max(0, -direction(signal, advP));
  signal.observationMfePct = Math.max(signal.observationMfePct, favorable);
  const finalT = signal.targets.at(-1);
  const beyond = signal.side === 'LONG' ? ((favP - finalT) / finalT) * 100 : ((finalT - favP) / finalT) * 100;
  signal.beyondFinalTargetPct = Math.max(signal.beyondFinalTargetPct, beyond, 0);
  return { favorable, adverse };
}

export function processCandle(signal, candle) {
  const end = candle.time + MINUTE;
  const expiry = Date.parse(signal.validUntil) / 1000;
  let enteredThisCandle = false;

  if (signal.status === 'PENDING_ENTRY') {
    if (end > expiry) {
      signal.status = 'EXPIRED_NO_ENTRY';
      signal.exitTime = new Date(expiry * 1000).toISOString();
      signal.observationComplete = true;
      return;
    }
    const touched = signal.proProtectionEnabled
      ? candle.low <= Math.max(signal.entryLow ?? signal.entry, signal.entryHigh ?? signal.entry) &&
        candle.high >= Math.min(signal.entryLow ?? signal.entry, signal.entryHigh ?? signal.entry)
      : candle.low <= signal.entry && candle.high >= signal.entry;

    if (!touched) return;

    signal.entryTime = new Date(end * 1000).toISOString();
    signal.entryCandleTime = candle.time;
    signal.holdUntil = end + signal.evaluation.maxHoldSeconds;
    signal.observeUntil = end + signal.evaluation.observationSeconds;
    signal.status = 'OPEN';
    enteredThisCandle = true;

    const targetInEntry = signal.targets.some(t => targetTouched(signal, candle, t));
    if (touchesStop(signal, candle) || targetInEntry) {
      ambiguous(signal, 'ENTRY_AND_EXIT_LEVEL_IN_SAME_MINUTE', end);
    }
    return;
  }

  if (!signal.entryTime || enteredThisCandle) return;
  if (candle.time >= signal.observeUntil) { signal.observationComplete = true; return; }

  const movement = observePrice(signal, candle);
  if (signal.status !== 'OPEN') {
    if (end >= signal.observeUntil) signal.observationComplete = true;
    return;
  }

  if (crossedStopAtOpen(signal, candle)) {
    const tag = signal.targetHits[0] != null && signal.proProtectionEnabled ? 'BREAKEVEN_STOP' : 'STOP_GAP';
    recordExit(signal, candle.open, signal.remaining, tag, candle.time);
    finalize(signal, tag, candle.time);
    return;
  }

  for (let i = 0; i < signal.targets.length; i++) {
    if (signal.targetHits[i] == null && targetAtOpen(signal, candle, signal.targets[i])) {
      signal.targetHits[i] = new Date(candle.time * 1000).toISOString();
      recordExit(signal, signal.targets[i], signal.weights[i], 'TP' + (i + 1), candle.time);
      updateProTrailingStop(signal, candle);
    }
  }

  if (signal.remaining < 1e-9) { finalize(signal, 'ALL_TARGETS', candle.time); return; }

  const pendingHits = signal.targets
    .map((price, i) => ({ price, i }))
    .filter(x => signal.targetHits[x.i] == null && targetTouched(signal, candle, x.price));

  const stopHit = touchesStop(signal, candle);
  if (stopHit && pendingHits.length) {
    ambiguous(signal, 'STOP_AND_TARGET_IN_SAME_MINUTE', end);
    return;
  }

  if (stopHit) {
    const fill = getEffectiveStop(signal);
    const tag = signal.targetHits[0] != null && signal.proProtectionEnabled ? 'BREAKEVEN_STOP' : 'STOP';
    recordExit(signal, fill, signal.remaining, tag, end);
    finalize(signal, tag, end);
    return;
  }

  for (const { price, i } of pendingHits) {
    signal.targetHits[i] = new Date(end * 1000).toISOString();
    recordExit(signal, price, signal.weights[i], 'TP' + (i + 1), end);
  }

  updateProTrailingStop(signal, candle);
  if (signal.remaining < 1e-9) { finalize(signal, 'ALL_TARGETS', end); return; }

  signal.observedMfePct = Math.max(signal.observedMfePct, movement.favorable);
  signal.observedMaePct = Math.max(signal.observedMaePct, movement.adverse);

  if (end >= signal.holdUntil) {
    recordExit(signal, candle.close, signal.remaining, 'TIME_EXIT', end);
    finalize(signal, 'TIME_EXIT', end);
  }
  if (end >= signal.observeUntil) signal.observationComplete = true;
}

async function auditPostStopAndExpiredSignals(state, nowSec) {
  const list = Object.values(state.signals).filter(s => {
    if (!['CLOSED', 'EXPIRED_NO_ENTRY'].includes(s.status)) return false;
    const isStop = s.status === 'CLOSED' && (s.exitReason === 'STOP' || s.exitReason === 'STOP_GAP' || s.netPct < 0);
    const isExp = s.status === 'EXPIRED_NO_ENTRY';
    if (!isStop && !isExp) return false;
    const base = Date.parse(s.exitTime || s.createdAt) / 1000;
    return Number.isFinite(base) && !s.postMortem?.complete && nowSec - base >= 900;
  });

  for (const signal of list.slice(0, 12)) {
    try {
      const startSec = Math.floor(Date.parse(signal.createdAt) / 1000 / 900) * 900;
      const raw15 = await requestGate('candlesticks', {
        contract: signal.symbol, interval: '15m', from: startSec, to: Math.min(Math.floor(nowSec), startSec + 192 * 900),
      });
      const candles = closedCandles(raw15, 900, nowSec);
      if (candles.length < 2) continue;

      const longSide = signal.side === 'LONG';
      const exitSec = Date.parse(signal.exitTime || signal.createdAt) / 1000;
      const post = candles.filter(c => c.time + 900 >= exitSec);
      if (!post.length) continue;

      const hi = Math.max(...post.map(c => c.high)), lo = Math.min(...post.map(c => c.low));
      const reached = (signal.targets || []).map(tp => (longSide ? hi >= tp : lo <= tp));
      const highestTp = reached.lastIndexOf(true) + 1;
      const worst = longSide ? lo : hi;
      const overDist = longSide ? Math.max(0, signal.stop - worst) : Math.max(0, worst - signal.stop);
      const overR = signal.initialRisk > 0 ? round(overDist / signal.initialRisk, 2) : 0;
      const intact = overR <= 0.95;
      const hitTp1Before = signal.targetHits?.[0] != null;

      signal.postMortem = {
        auditedAt: new Date().toISOString(),
        complete: (nowSec - exitSec) / 3600 >= 18 || highestTp === signal.targets.length,
        highestTpReached: Math.max(highestTp, hitTp1Before ? 1 : 0),
        overshootR: overR,
        structureIntact: intact,
        hitTp1BeforeStop: hitTp1Before,
        stopHuntedThenWon: signal.status === 'CLOSED' && (hitTp1Before || (highestTp >= 1 && intact)),
        reversedAfterStopAny: signal.status === 'CLOSED' && highestTp >= 1,
        missedEntryThenWon: signal.status === 'EXPIRED_NO_ENTRY' && highestTp >= 1 && !(longSide ? lo <= signal.stop : hi >= signal.stop),
      };
    } catch {}
  }
}

async function evaluateLiveSignalHealth(signal, nowSec, btcDeep) {
  if (signal.status !== 'OPEN') return;
  try {
    const raw15 = await requestGate('candlesticks', { contract: signal.symbol, interval: '15m', limit: 65 });
    const c15closed = closedCandles(raw15, 900, nowSec);
    if (c15closed.length < 30) return;

    const live15 = extractDevelopingCandle(raw15, c15closed, 900, nowSec);
    const c15 = indicators(live15 ? [...c15closed, live15] : c15closed);
    const last = c15.at(-1), prev = c15.at(-2);
    const curPrice = last.close, longSide = signal.side === 'LONG';
    const pnlPct = round(direction(signal, curPrice), 2), sign = pnlPct >= 0 ? '+' : '';

    for (let i = 0; i < signal.targets.length - 1; i++) {
      if (signal.targetHits[i] != null) {
        queueLiveAlert(
          signal, 'TP_HIT_' + (i + 1),
          [
            '✅ آپدیت لحظه‌ای سیگنال: هدف ' + (i + 1) + ' (TP' + (i + 1) + ') با موفقیت زده شد!',
            '🪙 ارز: #' + signal.symbol + ' | جهت: ' + signal.side + ' | قیمت هدف: ' + signal.targets[i],
            '🛡️ سیستم محافظ خودکار: حد ضرر باقی‌مانده معامله روی نقطه ورود (' + signal.entry + ') قفل و ریسک‌فری شد!',
            '₿ وضعیت BTC: ' + (btcDeep?.regimeFa ?? '—') + ' — ' + (btcDeep?.nextMoveForecast ?? ''),
          ].join('\n')
        );
      }
    }

    const tp1 = signal.targets[0];
    const distTp1 = Math.abs(tp1 - signal.entry);
    const gainDist = longSide ? curPrice - signal.entry : signal.entry - curPrice;
    const rng = last.high - last.low;
    const lowW = Math.min(last.open, last.close) - last.low, upW = last.high - Math.max(last.open, last.close);

    if (signal.targetHits[0] == null && gainDist >= distTp1 * 0.65 && gainDist < distTp1) {
      const stalling = longSide
        ? last.close < last.open && last.macdHist < prev.macdHist && (upW > rng * 0.38 || last.rsi < prev.rsi - 2.5)
        : last.close > last.open && last.macdHist > prev.macdHist && (lowW > rng * 0.38 || last.rsi > prev.rsi + 2.5);

      if (stalling) {
        queueLiveAlert(
          signal, 'TP1_WEAKNESS',
          [
            '⚠️ هشدار لحظه‌ای: کاهش شتاب در نزدیکی هدف اول (TP1) روی #' + signal.symbol,
            '💰 قیمت فعلی: ' + curPrice + ' (سود: ' + sign + pnlPct + '%)',
            '🛡️ فرمان رادار: معامله خودکار ریسک‌فری شد؛ پیشنهاد می‌شود ۵۰٪ سود را همین الان دستی سیو کنید.',
          ].join('\n')
        );
      }
    }
  } catch {}
}

function trackingNeeded(s) {
  return s.status === 'PENDING_ENTRY' || s.status === 'OPEN' || Boolean(s.entryTime && !s.observationComplete && ['CLOSED', 'AMBIGUOUS'].includes(s.status));
}

async function updateOne(signal, nowSec, btcDeep) {
  if (!trackingNeeded(signal)) return;
  const prevStatus = signal.status;
  const closedEnd = Math.floor(nowSec / MINUTE) * MINUTE;

  for (let page = 0; page < EVALUATION.maxPagesPerSignalPerRun; page++) {
    const from = signal.nextMinute;
    if (!Number.isFinite(from)) throw new Error('Missing cursor');
    const horizon = signal.entryTime ? signal.observeUntil : Math.floor(Date.parse(signal.validUntil) / 1000 / MINUTE) * MINUTE;
    const until = Math.min(closedEnd, horizon, from + 500 * MINUTE);

    if (from >= until) {
      if (signal.status === 'PENDING_ENTRY' && closedEnd >= horizon) {
        signal.status = 'EXPIRED_NO_ENTRY'; signal.exitTime = signal.validUntil; signal.observationComplete = true;
      } else if (signal.entryTime && from >= signal.observeUntil) {
        signal.observationComplete = true;
      }
      break;
    }

    const raw = await requestGate('candlesticks', { contract: signal.symbol, interval: '1m', from, to: until - 1 });
    const candles = closedCandles(raw, MINUTE, nowSec).filter(c => c.time >= from && c.time < until);
    const byTime = new Map(candles.map(c => [c.time, c]));

    for (let time = from; time < until; time += MINUTE) {
      const candle = byTime.get(time);
      if (!candle) {
        signal.dataIssue = { type: 'MISSING_MINUTE', time: new Date(time * 1000).toISOString(), checkedAt: new Date().toISOString() };
        return;
      }
      processCandle(signal, candle);
      signal.nextMinute = time + MINUTE;
      signal.dataIssue = null;
      if (!trackingNeeded(signal)) break;
    }
  }

  if (prevStatus === 'PENDING_ENTRY' && signal.status === 'OPEN') {
    queueLiveAlert(
      signal, 'ENTRY_ACTIVATED',
      [
        '🎯 نقطه ورود فعال شد: معامله #' + signal.symbol + ' (' + signal.side + ') باز شد!',
        '💵 ورود: ' + signal.entry + ' | 🛑 حد ضرر هوشمند: ' + signal.stop,
        '🎯 اهداف: ' + signal.targets.join(' -> '),
      ].join('\n')
    );
  }

  if (signal.status === 'OPEN') await evaluateLiveSignalHealth(signal, nowSec, btcDeep);
}

export async function updateTrackedSignals(state) {
  const nowSec = Date.now() / 1000;
  const hasOpen = Object.values(state.signals).some(s => s.status === 'OPEN' || s.status === 'PENDING_ENTRY');
  const btcDeep = hasOpen ? await analyzeBtcDeep(nowSec) : null;

  for (const signal of Object.values(state.signals)) {
    try { await updateOne(signal, nowSec, btcDeep); }
    catch (e) { signal.dataIssue = { type: 'FETCH_ERROR', message: e.message, checkedAt: new Date().toISOString() }; }
    await saveSignalState(state);
  }

  await auditPostStopAndExpiredSignals(state, nowSec);
  await saveSignalState(state);
}

export function resultMessage(signal) {
  const lines = ['📋 نتیجه نهایی سیگنال Gate', signal.symbol + ' | ' + signal.side + ' | ' + signal.id.slice(0, 12)];
  if (signal.status === 'EXPIRED_NO_ENTRY') {
    lines.push('⏳ منقضی بدون ورود.');
  } else if (signal.status === 'AMBIGUOUS') {
    lines.push('نتیجه مبهم در کندل یک‌دقیقه‌ای.');
  } else {
    const sign = signal.netPct >= 0 ? '+' : '';
    lines.push(
      'نتیجه خالص تخمینی (بدون اهرم): ' + sign + signal.netPct.toFixed(3) + '%',
      'نتیجه برحسب ریسک اولیه: ' + signal.netR.toFixed(2) + 'R',
      'علت پایان: ' + signal.exitReason,
      'اهداف ثبت‌شده: ' + signal.targetHits.map((t, i) => 'T' + (i + 1) + (t ? ' ✓' : ' —')).join(' | ')
    );
  }
  return lines.join('\n');
}

const pct = (c, t) => (t > 0 ? ((c / t) * 100).toFixed(1) + '%' : '—');

function periodReport(signals, days, now) {
  const since = now - days * DAY * 1000;
  const issued = signals.filter(s => s.sentAt && Date.parse(s.sentAt) >= since);
  const closed = issued.filter(s => s.status === 'CLOSED');
  const wins = closed.filter(s => s.netPct > 0.000001 || s.targetHits?.[0] != null);
  const losses = closed.filter(s => !wins.includes(s));
  return [
    'بازه: ' + days + ' روز اخیر | ارسال‌شده: ' + issued.length + ' | بسته‌شده: ' + closed.length,
    '✅ به سود رسیده: ' + wins.length + ' (' + pct(wins.length, closed.length) + ')',
    '❌ حد ضرر: ' + losses.length + ' (' + pct(losses.length, closed.length) + ')',
  ].join('\n');
}

export function performanceMessages(state, now = Date.now()) {
  const delivered = Object.values(state.signals).filter(s => s.sentAt);
  if (!delivered.length) return ['📊 گزارش عملکرد Gate\nهنوز سیگنالی ثبت نشده است.'];
  return [['📊 گزارش عملکرد سیستم هوشمند Gate', periodReport(delivered, 7, now), '━━━━━━━━━━━━━━━━━━', periodReport(delivered, 30, now)].join('\n')];
}
