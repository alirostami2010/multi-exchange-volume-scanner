
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  requestGate,
  closedCandles,
  positive,
  round,
} from '../services/gate.js';

const FILE = path.resolve(process.cwd(), 'data', 'signal-state.json');
const MINUTE = 60;
const DAY = 86400;

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
  return {
    schemaVersion: 1,
    signals: {},
    lastDailyReportDay: null,
  };
}

export async function loadSignalState() {
  try {
    const state = JSON.parse(await fs.readFile(FILE, 'utf8'));

    if (
      state.schemaVersion !== 1 ||
      !state.signals ||
      typeof state.signals !== 'object' ||
      Array.isArray(state.signals)
    ) throw new Error('Invalid signal-state.json; refusing to overwrite');

    // A prior run may have stopped after sending but before confirmation.
    for (const signal of Object.values(state.signals)) {
      if (signal.status === 'PENDING_DELIVERY') {
        signal.status = 'DELIVERY_UNKNOWN';
        signal.deliveryNote = 'Previous execution ended before delivery confirmation';
      }
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

  const temporary = FILE + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, FILE);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function strategyKey(version, config) {
  return version + '-' + hash(JSON.stringify(config)).slice(0, 10);
}

export function signalId(candidate, strategy) {
  return hash([
    strategy,
    candidate.symbol,
    candidate.side,
    candidate.triggerCandleTime,
  ].join('|')).slice(0, 24);
}

export function canRegister(state, candidate, strategy) {
  const id = signalId(candidate, strategy);
  if (state.signals[id]) return false;

  return !Object.values(state.signals).some(s =>
    s.symbol === candidate.symbol &&
    s.side === candidate.side &&
    ['PENDING_DELIVERY', 'PENDING_ENTRY', 'OPEN'].includes(s.status)
  );
}

export function createSignal(candidate, strategy, config = {}) {
  const entry = candidate.side === 'LONG'
    ? candidate.entryHigh
    : candidate.entryLow;

  const targets = candidate.takeProfits.map(t => t.price);
  const weights = targets.length === 3
    ? [0.4, 0.4, 0.2]
    : targets.length === 2 ? [0.5, 0.5] : [1];

  if (
    !positive(entry) ||
    !positive(candidate.stopLoss) ||
    targets.length < 1 ||
    targets.length > 3 ||
    !targets.every(positive) ||
    !Number.isFinite(Date.parse(candidate.validUntil))
  ) throw new Error('Invalid signal levels');

  const long = candidate.side === 'LONG';

  if (
    !['LONG', 'SHORT'].includes(candidate.side) ||

(long ? candidate.stopLoss >= entry : candidate.stopLoss <= entry) ||
    !targets.every((t, i) =>
      long
        ? t > (i === 0 ? entry : targets[i - 1])
        : t < (i === 0 ? entry : targets[i - 1])
    )
  ) throw new Error('Invalid directional target/stop order');

  return {
    id: signalId(candidate, strategy),
    symbol: candidate.symbol,
    side: candidate.side,
    strategy,
    strategyConfig: config,
    evaluationVersion: EVALUATION.version,
    evaluation: { ...EVALUATION },
    createdAt: new Date().toISOString(),
    sentAt: null,
    status: 'PENDING_DELIVERY',
    entry,
    entryLow: candidate.entryLow,
    entryHigh: candidate.entryHigh,
    stop: candidate.stopLoss,
    initialRisk: Math.abs(entry - candidate.stopLoss),
    targets,
    weights,
    targetHits: targets.map(() => null),
    validUntil: candidate.validUntil,
    triggerCandleTime: candidate.triggerCandleTime,
    score: candidate.score,
    setup: candidate.setup,
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
    observationComplete: false,
    dataIssue: null,
    resultNotified: false,
  };
}

export function markDelivered(signal, delivery) {
  signal.sentAt = delivery.confirmedAt;
  signal.messageIds = delivery.messageIds;
  signal.status = 'PENDING_ENTRY';

  const sentSeconds = Date.parse(signal.sentAt) / 1000;

  // Never inspect a candle that started before successful delivery.
  signal.nextMinute = Math.ceil(sentSeconds / MINUTE) * MINUTE;

  const expiry = Date.parse(signal.validUntil) / 1000;

  if (signal.nextMinute + MINUTE > expiry) {
    signal.status = 'EXPIRED_NO_ENTRY';
    signal.exitTime = signal.sentAt;
    signal.observationComplete = true;
  }
}

function direction(signal, price) {
  return (signal.side === 'LONG'
    ? price - signal.entry
    : signal.entry - price
  ) / signal.entry * 100;
}

function touchesStop(signal, candle) {
  return signal.side === 'LONG'
    ? candle.low <= signal.stop
    : candle.high >= signal.stop;
}

function crossedStopAtOpen(signal, candle) {
  return signal.side === 'LONG'
    ? candle.open <= signal.stop
    : candle.open >= signal.stop;
}

function targetTouched(signal, candle, price) {
  return signal.side === 'LONG'
    ? candle.high >= price
    : candle.low <= price;
}

function targetAtOpen(signal, candle, price) {
  return signal.side === 'LONG'
    ? candle.open >= price
    : candle.open <= price;
}

function recordExit(signal, price, fraction, reason, time) {
  const quantity = Math.min(signal.remaining, fraction);
  if (!(quantity > 0)) return;

  const gross = direction(signal, price) * quantity;

  const costRate =
    signal.evaluation.feeRate + signal.evaluation.slippageRate;

  const costs =
    costRate * (1 + price / signal.entry) * 100 * quantity;

  signal.realizedGrossPct += gross;
  signal.estimatedCostsPct += costs;
  signal.remaining = Math.max(0, signal.remaining - quantity);

  signal.exits.push({
    time: new Date(time * 1000).toISOString(),
    price,
    fraction: quantity,
    reason,
    grossPct: gross,
    costPct: costs,
  });
}

function finalize(signal, reason, time) {
  signal.status = 'CLOSED';
  signal.exitReason = reason;
  signal.exitTime = new Date(time * 1000).toISOString();
  signal.netPct = signal.realizedGrossPct - signal.estimatedCostsPct;

  const riskPct = signal.initialRisk / signal.entry * 100;
  signal.netR = signal.netPct / riskPct;
}

function ambiguous(signal, reason, time) {
  signal.status = 'AMBIGUOUS';
  signal.ambiguityReason = reason;
  signal.exitTime = new Date(time * 1000).toISOString();
  signal.netPct = null;
  signal.netR = null;
}

function observePrice(signal, candle) {
  const favorablePrice = signal.side === 'LONG' ? candle.high : candle.low;
  const adversePrice = signal.side === 'LONG' ? candle.low : candle.high;

const favorable = Math.max(0, direction(signal, favorablePrice));
  const adverse = Math.max(0, -direction(signal, adversePrice));

  signal.observationMfePct = Math.max(signal.observationMfePct, favorable);

  const finalTarget = signal.targets.at(-1);
  const beyond = signal.side === 'LONG'
    ? (favorablePrice - finalTarget) / finalTarget * 100
    : (finalTarget - favorablePrice) / finalTarget * 100;

  signal.beyondFinalTargetPct = Math.max(
    signal.beyondFinalTargetPct, beyond, 0
  );

  return { favorable, adverse };
}

/**
 * Mutates one paper signal using a fully closed one-minute candle.
 * Unknown intrabar order is marked AMBIGUOUS.
 * No price before successful Telegram delivery is used.
 */
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

    if (!(candle.low <= signal.entry && candle.high >= signal.entry)) {
      return;
    }

    signal.entryTime = new Date(end * 1000).toISOString();
    signal.entryCandleTime = candle.time;
    signal.holdUntil = end + signal.evaluation.maxHoldSeconds;
    signal.observeUntil = end + signal.evaluation.observationSeconds;
    signal.status = 'OPEN';
    enteredThisCandle = true;

    const targetInEntryCandle = signal.targets.some(t =>
      targetTouched(signal, candle, t)
    );

    if (touchesStop(signal, candle) || targetInEntryCandle) {
      ambiguous(signal, 'ENTRY_AND_EXIT_LEVEL_IN_SAME_MINUTE', end);
    }

    // Do not assign pre-entry candle extremes to post-entry performance.
    return;
  }

  if (!signal.entryTime || enteredThisCandle) return;

  if (candle.time >= signal.observeUntil) {
    signal.observationComplete = true;
    return;
  }

  const movement = observePrice(signal, candle);

  if (signal.status !== 'OPEN') {
    if (end >= signal.observeUntil) signal.observationComplete = true;
    return;
  }

  if (crossedStopAtOpen(signal, candle)) {
    // Gap through stop: use the worse opening price, not the old stop.
    recordExit(signal, candle.open, signal.remaining, 'STOP_GAP', candle.time);
    finalize(signal, 'STOP_GAP', candle.time);
    return;
  }

  // Targets already crossed at candle open have known ordering before
  // later intrabar stop touches. Fill conservatively at target price.
  for (let i = 0; i < signal.targets.length; i++) {
    if (
      signal.targetHits[i] == null &&
      targetAtOpen(signal, candle, signal.targets[i])
    ) {
      signal.targetHits[i] = new Date(candle.time * 1000).toISOString();
      recordExit(
        signal, signal.targets[i], signal.weights[i],
        'TP' + (i + 1), candle.time
      );
    }
  }

  if (signal.remaining < 1e-9) {
    finalize(signal, 'ALL_TARGETS', candle.time);
    return;
  }

  const pendingHits = signal.targets
    .map((price, i) => ({ price, i }))
    .filter(x =>
      signal.targetHits[x.i] == null &&
      targetTouched(signal, candle, x.price)
    );

  const stopHit = touchesStop(signal, candle);

  if (stopHit && pendingHits.length) {
    ambiguous(signal, 'STOP_AND_TARGET_IN_SAME_MINUTE', end);
    return;
  }

  if (stopHit) {
    recordExit(signal, signal.stop, signal.remaining, 'STOP', end);
    finalize(signal, 'STOP', end);
    return;
  }

  for (const { price, i } of pendingHits) {
    signal.targetHits[i] = new Date(end * 1000).toISOString();
    recordExit(signal, price, signal.weights[i], 'TP' + (i + 1), end);
  }

  if (signal.remaining < 1e-9) {
    finalize(signal, 'ALL_TARGETS', end);
    return;
  }

  // Conservative extrema: only candles where the position remained open.
  signal.observedMfePct = Math.max(
    signal.observedMfePct, movement.favorable
  );
  signal.observedMaePct = Math.max(
    signal.observedMaePct, movement.adverse
  );

if (end >= signal.holdUntil) {
    recordExit(signal, candle.close, signal.remaining, 'TIME_EXIT', end);
    finalize(signal, 'TIME_EXIT', end);
  }

  if (end >= signal.observeUntil) signal.observationComplete = true;
}

function trackingNeeded(signal) {
  if (signal.status === 'PENDING_ENTRY' || signal.status === 'OPEN') return true;

  return Boolean(
    signal.entryTime &&
    !signal.observationComplete &&
    ['CLOSED', 'AMBIGUOUS'].includes(signal.status)
  );
}

async function updateOne(signal, nowSeconds) {
  if (!trackingNeeded(signal)) return;

  const closedEnd = Math.floor(nowSeconds / MINUTE) * MINUTE;

  for (let page = 0; page < EVALUATION.maxPagesPerSignalPerRun; page++) {
    const from = signal.nextMinute;
    if (!Number.isFinite(from)) throw new Error('Missing tracking cursor');

    const horizon = signal.entryTime
      ? signal.observeUntil
      : Math.floor(Date.parse(signal.validUntil) / 1000 / MINUTE) * MINUTE;

    const until = Math.min(closedEnd, horizon, from + 500 * MINUTE);

    if (from >= until) {
      if (
        signal.status === 'PENDING_ENTRY' &&
        closedEnd >= horizon
      ) {
        signal.status = 'EXPIRED_NO_ENTRY';
        signal.exitTime = signal.validUntil;
        signal.observationComplete = true;
      } else if (signal.entryTime && from >= signal.observeUntil) {
        signal.observationComplete = true;
      }
      return;
    }

    const raw = await requestGate('candlesticks', {
      contract: signal.symbol,
      interval: '1m',
      from,
      to: until - 1,
    });

    const candles = closedCandles(raw, MINUTE, nowSeconds)
      .filter(c => c.time >= from && c.time < until);

    const byTime = new Map(candles.map(c => [c.time, c]));

    for (let time = from; time < until; time += MINUTE) {
      const candle = byTime.get(time);

      if (!candle) {
        signal.dataIssue = {
          type: 'MISSING_MINUTE',
          time: new Date(time * 1000).toISOString(),
          checkedAt: new Date().toISOString(),
        };
        // Never skip missing candles and infer a win.
        return;
      }

      processCandle(signal, candle);
      signal.nextMinute = time + MINUTE;
      signal.dataIssue = null;

      if (!trackingNeeded(signal)) return;
    }
  }

  if (trackingNeeded(signal) && signal.nextMinute < closedEnd) {
    signal.dataIssue = {
      type: 'BACKLOG_PENDING',
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function updateTrackedSignals(state) {
  const nowSeconds = Date.now() / 1000;

  for (const signal of Object.values(state.signals)) {
    try {
      await updateOne(signal, nowSeconds);
    } catch (error) {
      signal.dataIssue = {
        type: 'FETCH_ERROR',
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
      console.error('[TRACKER]', signal.symbol, error.message);
    }

    // Persist progress locally after each signal.
    await saveSignalState(state);
  }
}

export function resultMessage(signal) {
  const lines = [
    '📋 نتیجه فرضی سیگنال Gate',
    signal.symbol + ' | ' + signal.side + ' | ' + signal.id.slice(0, 12),
  ];

  if (signal.status === 'EXPIRED_NO_ENTRY') {
    lines.push('منقضی بدون ورود فرضی؛ برد یا باخت محسوب نمی‌شود.');
  } else if (signal.status === 'AMBIGUOUS') {
    lines.push(
      'نتیجه مبهم: ترتیب لمس سطوح در کندل یک‌دقیقه‌ای مشخص نیست.',
      'از آمار برد و باخت قطعی کنار گذاشته شده است.'
    );
  } else {
    const sign = signal.netPct >= 0 ? '+' : '';

    lines.push(
      'نتیجه خالص تخمینی: ' + sign + signal.netPct.toFixed(3) + '%',
      'نتیجه برحسب ریسک اولیه: ' + signal.netR.toFixed(2) + 'R',
      'علت پایان: ' + signal.exitReason,
      'اهداف ثبت‌شده: ' + signal.targetHits
        .map((time, i) => 'T' + (i + 1) + (time ? ' ✓' : ' —'))
        .join(' | ')
    );
  }

  lines.push(
    'ارزیابی فرضی بدون اهرم؛ شامل هزینه تخمینی و بدون فاندینگ.',
    'این نتیجه سود واقعی حساب LBank نیست.'
  );

  return lines.join('\n');
}

const pct = (count, total) =>
  total > 0 ? (count / total * 100).toFixed(1) + '%' : '—';

function periodReport(signals, days, now) {
  const since = now - days * DAY * 1000;

  const issued = signals.filter(s =>
    s.sentAt && Date.parse(s.sentAt) >= since
  );

  const activated = issued.filter(s => s.entryTime);
  const closed = issued.filter(s => s.status === 'CLOSED');
  const wins = closed.filter(s => s.netPct > 0.000001);
  const losses = closed.filter(s => s.netPct < -0.000001);
  const flat = closed.length - wins.length - losses.length;

  const positiveSum = wins.reduce((sum, s) => sum + s.netPct, 0);
  const negativeSum = -losses.reduce((sum, s) => sum + s.netPct, 0);

  const factor = negativeSum > 0
    ? (positiveSum / negativeSum).toFixed(2)
    : positiveSum > 0 ? 'بدون زیان ثبت‌شده؛ قابل اتکا نیست' : '—';

  const averageNet = closed.length
    ? closed.reduce((sum, s) => sum + s.netPct, 0) / closed.length
    : null;

  const averageR = closed.length
    ? closed.reduce((sum, s) => sum + s.netR, 0) / closed.length
    : null;

  const observed = activated.filter(s => s.observationComplete);

  const averageBeyond = observed.length
    ? observed.reduce((sum, s) => sum + s.beyondFinalTargetPct, 0) / observed.length
    : null;

  const lines = [
    'بازه صدور: ' + days + ' روز اخیر',
    'ارسال‌شده: ' + issued.length + ' | فعال‌شده: ' + activated.length,
    'باز/منتظر ورود: ' +
      issued.filter(s => ['OPEN', 'PENDING_ENTRY'].includes(s.status)).length,
    'بدون ورود: ' + issued.filter(s => s.status === 'EXPIRED_NO_ENTRY').length +
      ' | مبهم: ' + issued.filter(s => s.status === 'AMBIGUOUS').length,
    'بسته‌شده قابل ارزیابی: ' + closed.length,
    '✅ سودده: ' + wins.length + ' | ' + pct(wins.length, closed.length),
    '❌ زیان‌ده: ' + losses.length + ' | ' + pct(losses.length, closed.length),
    '➖ سربه‌سر: ' + flat + ' | ' + pct(flat, closed.length),
    'میانگین خالص هر معامله: ' +
      (averageNet == null ? '—' : averageNet.toFixed(3) + '%'),
    'امید ریاضی مشاهده‌شده: ' +
      (averageR == null ? '—' : averageR.toFixed(3) + 'R'),

    'ضریب سود با اندازه اسمی برابر: ' + factor,
  ];

  for (let i = 0; i < 3; i++) {
    const eligible = closed.filter(s => s.targets.length > i);
    const hits = eligible.filter(s => s.targetHits[i] != null);

    lines.push(
      'T' + (i + 1) + ' در معاملات بسته‌شده دارای این هدف: ' +
      hits.length + '/' + eligible.length + ' | ' + pct(hits.length, eligible.length)
    );
  }

  lines.push(
    'پایش ۴۸ساعته تکمیل‌شده: ' + observed.length,
    'میانگین عبور از آخرین هدف در پایش ۴۸ساعته: ' +
      (averageBeyond == null ? '—' : averageBeyond.toFixed(3) + '%'),
    'این عبور ممکن است پس از خروج/حد ضرر رخ داده باشد و سود معامله نیست.'
  );

  for (const side of ['LONG', 'SHORT']) {
    const group = closed.filter(s => s.side === side);
    const successful = group.filter(s => s.netPct > 0.000001).length;

    lines.push(
      side + ': ' + group.length + ' بسته‌شده | برد ' +
      pct(successful, group.length)
    );
  }

  return lines.join('\n');
}

export function performanceMessages(state, now = Date.now()) {
  const signals = Object.values(state.signals);
  const delivered = signals.filter(s => s.sentAt);
  const groups = new Map();

  for (const signal of delivered) {
    const key = signal.strategy + ' / ' + signal.evaluationVersion;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(signal);
  }

  if (!groups.size) {
    return [
      '📊 گزارش عملکرد فرضی Gate\n' +
      'هنوز سیگنال با ارسال تأییدشده برای ارزیابی ثبت نشده است.\n' +
      'ارزیابی از زمان نصب این نسخه آغاز می‌شود؛ گذشته بازسازی نشده است.',
    ];
  }

  const messages = [];

  for (const [version, group] of groups) {
    messages.push([
      '📊 گزارش عملکرد فرضی Gate',

'نسخه: ' + version,
      periodReport(group, 7, now),
      '━━━━━━━━━━━━━━━━━━',
      periodReport(group, 30, now),
      '━━━━━━━━━━━━━━━━━━',
      'اختلال/عقب‌ماندگی داده در این نسخه: ' +
        group.filter(s => s.dataIssue).length,
      'برد و باخت فقط بین معاملات بسته‌شده غیرمبهم محاسبه شده است.',
      'حذف موارد مبهم می‌تواند بر نرخ برد اثر بگذارد؛ تعدادشان را بررسی کن.',
      'حد ضرر ثابت؛ خروج پله‌ای؛ هزینه تخمینی؛ بدون فاندینگ و اهرم.',
      'این درصدها بازده حساب نیستند. داده Gate، نه اجرای واقعی LBank.',
    ].join('\n'));
  }

  const unknown = signals.filter(s => s.status === 'DELIVERY_UNKNOWN').length;

  if (unknown) {
    messages.push(
      '⚠️ ارسال نامشخص: ' + unknown +
      ' مورد؛ برای جلوگیری از آمار ساختگی وارد ارزیابی نشده‌اند.'
    );
  }

  return messages;
}
