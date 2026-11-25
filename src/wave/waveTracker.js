import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  requestGate,
  closedCandles,
  positive,
} from '../services/gate.js';

import { assessWaveExit } from './waveRider.js';

// Separate paper evaluation for Wave Rider.
// Fixed-stop results in signal-state.json are intentionally not used here.

const FILE = path.resolve(process.cwd(), 'data', 'wave-state.json');
const MINUTE = 60;

export const WAVE_EVALUATION = Object.freeze({
  version: 'wave-trail-v1',
  maxHoldSeconds: 12 * 60 * 60,
  feeRate: 0.0006,
  slippageRate: 0.0003,
  fundingIncluded: false,
  entryModel: 'CONSERVATIVE_BOUNDARY_TOUCH_AFTER_DELIVERY',
  exitModel: '1M_STOP_THEN_15M_STRUCTURE_OR_TRAIL',
  initialRiskIncludesCosts: false,
});

function emptyState() {
  return {
    schemaVersion: 1,
    trades: {},
    attempts: {},
    daily: {
      day: null,
      attempts: 0,
    },
    lastReportDay: null,
  };
}

function isRecord(value) {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

export async function loadWaveState() {
  try {
    const state = JSON.parse(await fs.readFile(FILE, 'utf8'));

    if (!isRecord(state) || state.schemaVersion !== 1) {
      throw new Error('Invalid wave-state.json');
    }

    if (!isRecord(state.trades)) state.trades = {};
    if (!isRecord(state.attempts)) state.attempts = {};

    if (!isRecord(state.daily)) {
      state.daily = { day: null, attempts: 0 };
    }

    for (const trade of Object.values(state.trades)) {
      if (trade.status === 'PENDING_DELIVERY') {
        trade.status = 'DELIVERY_UNKNOWN';
        trade.deliveryNote =
          'Execution ended before delivery confirmation';
      }
    }

    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

export async function saveWaveState(state) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  state.updatedAt = new Date().toISOString();

  const temporary = FILE + '.tmp';
  await fs.writeFile(
    temporary,
    JSON.stringify(state, null, 2),
    'utf8'
  );
  await fs.rename(temporary, FILE);
}

export function waveTradeId(event) {
  return createHash('sha256')
    .update([
      'wave-rider-entry',
      event.symbol,
      event.side,
      event.triggerCandleTime,
    ].join('|'))
    .digest('hex')
    .slice(0, 24);
}

export function createWaveTrade(event) {
  const entry = Number(event.conservativeEntry);
  const stop = Number(event.stopLoss);

  if (!positive(entry) || !positive(stop)) {
    throw new Error('Invalid wave entry levels');
  }

  const longSide = event.side === 'LONG';
  const stopValid = longSide ? stop < entry : stop > entry;

  if (!stopValid) {
    throw new Error('Wave stop is on the wrong side');
  }

  return {
    id: waveTradeId(event),
    experimental: true,
    symbol: event.symbol,
    side: event.side,
    strategyVersion: event.version,
    evaluationVersion: WAVE_EVALUATION.version,
    evaluation: { ...WAVE_EVALUATION },

    status: 'PENDING_DELIVERY',
    createdAt: new Date().toISOString(),
    sentAt: null,

    entry,
    entryLow: Number(event.entryLow),
    entryHigh: Number(event.entryHigh),
    initialStop: stop,
    activeStop: stop,
    priorExtremeTarget: Number(event.priorExtremeTarget),

    validUntil: event.validUntil,
    triggerCandleTime: event.triggerCandleTime,
    waveNumberHeuristic: event.waveNumberHeuristic,
    correctionDepthPct: event.correctionDepthPct,

    nextMinute: null,
    structureReviewedUntil: null,
    entryTime: null,
    exitTime: null,
    exitReason: null,

    grossPct: 0,
    costPct: 0,
    netPct: null,
    netR: null,
    mfePct: 0,
    maePct: 0,

    exits: [],
    trailHistory: [],
    notifications: {
      breakeven: false,
      correction: null,
    },
    dataIssue: null,
    resultNotified: false,
  };
}

export function markWaveDelivered(trade, delivery) {
  trade.sentAt = delivery.confirmedAt;
  trade.messageIds = delivery.messageIds;
  trade.status = 'PENDING_ENTRY';

  const sentSeconds = Date.parse(trade.sentAt) / 1000;
  trade.nextMinute = Math.ceil(sentSeconds / MINUTE) * MINUTE;

  const expiry = Date.parse(trade.validUntil) / 1000;

  if (trade.nextMinute + MINUTE > expiry) {
    trade.status = 'EXPIRED_NO_ENTRY';
    trade.exitTime = trade.sentAt;
    trade.observationComplete = true;
  }
}

function directionalPct(trade, price) {
  return trade.side === 'LONG'
    ? (price - trade.entry) / trade.entry * 100
    : (trade.entry - price) / trade.entry * 100;
}

function finish(trade, price, reason, timeSeconds) {
  const gross = directionalPct(trade, price);
  const costRate =
    trade.evaluation.feeRate + trade.evaluation.slippageRate;

  const costs =
    costRate * (1 + price / trade.entry) * 100;

  trade.grossPct = gross;
  trade.costPct = costs;
  trade.netPct = gross - costs;

  const riskPct =
    Math.abs(trade.entry - trade.initialStop) / trade.entry * 100;

  trade.netR = trade.netPct / riskPct;
  trade.status = 'CLOSED';
  trade.exitReason = reason;
  trade.exitTime = new Date(timeSeconds * 1000).toISOString();

  trade.exits.push({
    time: trade.exitTime,
    price,
    reason,
    grossPct: gross,
    costPct: costs,
  });
}

export function applyWaveMinute(trade, candle) {
  const end = candle.time + MINUTE;

  if (trade.status === 'PENDING_ENTRY') {
    const expiry = Date.parse(trade.validUntil) / 1000;

    if (end > expiry) {
      trade.status = 'EXPIRED_NO_ENTRY';
      trade.exitTime = trade.validUntil;
      trade.observationComplete = true;
      return;
    }

    const touched =
      candle.low <= trade.entry &&
      candle.high >= trade.entry;

    if (!touched) return;

    trade.status = 'OPEN';
    trade.entryTime = new Date(end).toISOString();
    trade.entryCandleTime = candle.time;
    trade.holdUntil = end + trade.evaluation.maxHoldSeconds;
    trade.activeStop = trade.initialStop;

    const nextBoundary =
      Math.ceil(end / 900) * 900;

    trade.structureReviewedUntil = nextBoundary;

    const stopInEntryCandle = trade.side === 'LONG'
      ? candle.low <= trade.initialStop
      : candle.high >= trade.initialStop;

    if (stopInEntryCandle) {
      trade.status = 'AMBIGUOUS';
      trade.ambiguityReason = 'ENTRY_AND_STOP_IN_SAME_MINUTE';
      trade.exitTime = new Date(end).toISOString();
      trade.netPct = null;
      trade.netR = null;
    }

    return;
  }

  if (trade.status !== 'OPEN') return;

  const longSide = trade.side === 'LONG';
  const stop = trade.activeStop;

  const gap = longSide
    ? candle.open <= stop
    : candle.open >= stop;

  if (gap) {
    finish(trade, candle.open, 'STOP_GAP', candle.time);
    return;
  }

  const hit = longSide
    ? candle.low <= stop
    : candle.high >= stop;

  if (hit) {
    finish(trade, stop, 'STOP', end);
    return;
  }

  const favorable = longSide ? candle.high : candle.low;
  const adverse = longSide ? candle.low : candle.high;

  trade.mfePct = Math.max(
    trade.mfePct,
    Math.max(0, directionalPct(trade, favorable))
  );

  trade.maePct = Math.max(
    trade.maePct,
    Math.max(0, -directionalPct(trade, adverse))
  );

  if (end >= trade.holdUntil) {
    finish(trade, candle.close, 'TIME_EXIT', end);
  }
}

export function applyStructureReview(
  trade,
  review,
  closePrice,
  timeSeconds
) {
  if (trade.status !== 'OPEN') return;
  if (!review) return;

  if (review.reason === 'GATE_REFERENCE_STOP_TOUCHED') {
    trade.dataIssue = {
      type: 'STOP_TOUCH_MISMATCH',
      time: new Date(timeSeconds * 1000).toISOString(),
    };
    return;
  }

  if (
    review.stage === 'EXIT_REVIEW' &&
    review.reason === 'SHORT_TERM_STRUCTURE_BREAK'
  ) {
    finish(trade, closePrice, 'STRUCTURE_EXIT', timeSeconds);
    return;
  }

  if (
    review.stage === 'WATCH_CORRECTION' &&
    trade.notifications.correction !== review.observedAt
  ) {
    trade.pendingNotification = {
      type: 'CORRECTION_WATCH',
      at: review.observedAt,
    };
  }

  const nextStop = Number(review.nextReferenceStop);

  if (!positive(nextStop) || nextStop === trade.activeStop) {
    return;
  }

  const improved = trade.side === 'LONG'
    ? nextStop > trade.activeStop
    : nextStop < trade.activeStop;

  if (!improved) return;

  trade.activeStop = nextStop;

  trade.trailHistory.push({
    time: new Date(timeSeconds * 1000).toISOString(),
    stop: nextStop,
  });

  const riskReduced = trade.side === 'LONG'
    ? nextStop >= trade.entry
    : nextStop <= trade.entry;

  if (riskReduced && !trade.notifications.breakeven) {
    trade.pendingNotification = {
      type: 'BREAKEVEN_TRAIL',
      stop: nextStop,
    };
  }
}

function trackingNeeded(trade) {
  return trade.status === 'PENDING_ENTRY' ||
    trade.status === 'OPEN';
}

async function reviewBoundary(trade, boundary) {
  const raw = await requestGate('candlesticks', {
    contract: trade.symbol,
    interval: '15m',
    limit: 80,
  });

  const candles = closedCandles(raw, 900, boundary);
  const candle = candles.find(
    item => item.time + 900 === boundary
  );

  if (!candle) {
    trade.dataIssue = {
      type: 'MISSING_15M_REVIEW',
      boundary: new Date(boundary * 1000).toISOString(),
    };
    return false;
  }

  const review = assessWaveExit({
    position: {
      side: trade.side,
      entry: trade.entry,
      initialStop: trade.initialStop,
      trailingStop: trade.activeStop,
      entryTime: trade.entryTime,
    },
    candles15m: candles,
    asOf: boundary,
  });

  applyStructureReview(
    trade,
    review,
    candle.close,
    boundary
  );

  trade.structureReviewedUntil = boundary;
  return true;
}

async function updateOne(trade, nowSeconds) {
  if (!trackingNeeded(trade)) return;

  const closedEnd = Math.floor(nowSeconds / MINUTE) * MINUTE;

  for (let page = 0; page < 8; page++) {
    const from = trade.nextMinute;

    if (!Number.isFinite(from)) {
      throw new Error('Missing wave tracking cursor');
    }

    const horizon = trade.status === 'PENDING_ENTRY'
      ? Math.floor(Date.parse(trade.validUntil) / 1000 / MINUTE) * MINUTE
      : trade.holdUntil;

    const until = Math.min(closedEnd, horizon, from + 500 * MINUTE);

    if (from >= until) {
      if (
        trade.status === 'PENDING_ENTRY' &&
        closedEnd >= horizon
      ) {
        trade.status = 'EXPIRED_NO_ENTRY';
        trade.exitTime = trade.validUntil;
        trade.observationComplete = true;
      }
      return;
    }

    const raw = await requestGate('candlesticks', {
      contract: trade.symbol,
      interval: '1m',
      from,
      to: until - 1,
    });

    const candles = closedCandles(raw, MINUTE, nowSeconds)
      .filter(candle =>
        candle.time >= from && candle.time < until
      );

    const byTime = new Map(
      candles.map(candle => [candle.time, candle])
    );

    for (let time = from; time < until; time += MINUTE) {
      const candle = byTime.get(time);

      if (!candle) {
        trade.dataIssue = {
          type: 'MISSING_MINUTE',
          time: new Date(time * 1000).toISOString(),
        };
        return;
      }

      applyWaveMinute(trade, candle);
      trade.nextMinute = time + MINUTE;

      if (
        trade.status === 'OPEN' &&
        trade.nextMinute % 900 === 0 &&
        trade.structureReviewedUntil < trade.nextMinute
      ) {
        const reviewed = await reviewBoundary(
          trade,
          trade.nextMinute
        );

        if (!reviewed) return;
      }

      if (!trackingNeeded(trade)) return;
    }
  }

  trade.dataIssue = {
    type: 'BACKLOG_PENDING',
    checkedAt: new Date().toISOString(),
  };
}

export async function updateWaveTrades(state) {
  for (const trade of Object.values(state.trades)) {
    try {
      await updateOne(trade, Date.now() / 1000);
    } catch (error) {
      trade.dataIssue = {
        type: 'UPDATE_ERROR',
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
      console.error('[WAVE TRACKER]', trade.symbol, error.message);
    }

    await saveWaveState(state);
  }
}

function signed(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + value.toFixed(digits);
}

export function waveResultMessage(trade) {
  const lines = [
    '🧪 نتیجه آزمایشی موج‌سوار',
    'این نتیجه جدا از اسکنر اصلی است.',
    trade.symbol + ' | ' + trade.side + ' | ' + trade.id.slice(0, 12),
  ];

  if (trade.status === 'EXPIRED_NO_ENTRY') {
    lines.push('ناحیه ورود لمس نشد؛ برد یا باخت نیست.');
  } else if (trade.status === 'AMBIGUOUS') {
    lines.push('نتیجه مبهم است و در درصد برد حساب نمی‌شود.');
    lines.push('علت: ' + trade.ambiguityReason);
  } else {
    lines.push('نتیجه خالص تخمینی: ' + signed(trade.netPct, 3) + '%');
    lines.push('نتیجه نسبت به ریسک اولیه: ' + signed(trade.netR, 2) + 'R');
    lines.push('علت پایان: ' + trade.exitReason);
    lines.push('بیشترین حرکت مطلوب تا خروج: ' + signed(trade.mfePct) + '%');
  }

  lines.push(
    'مدل: ورود محافظه‌کارانه، حد ضرر یک‌دقیقه‌ای، سپس ساختار یا تریل ۱۵دقیقه‌ای.',
    'هزینه تخمینی دارد؛ فاندینگ، اهرم و اجرای LBank ندارد.',
    'سودآوری این مدل هنوز اثبات نشده است.'
  );

  return lines.join('\n');
}

export function waveNotification(trade) {
  const pending = trade.pendingNotification;
  if (!pending) return null;

  if (pending.type === 'BREAKEVEN_TRAIL') {
    return [
      '🧪 موج‌سوار | به‌روزرسانی حد مرجع',
      trade.symbol + ' | ' + trade.side,
      'حد مرجع Gate به محدوده ورود یا بهتر منتقل شد: ' + pending.stop,
      'این سفارش صرافی را تغییر نمی‌دهد؛ حد ضرر واقعی باید در LBank بررسی شود.',
    ].join('\n');
  }

  if (pending.type === 'CORRECTION_WATCH') {
    return [
      '🧪 موج‌سوار | نشانه احتمالی اصلاح',
      trade.symbol + ' | ' + trade.side,
      'ساختار هنوز به‌تنهایی خروج قطعی را تأیید نکرده است.',
      'منبع Gate است و سفارش اجرا نمی‌شود.',
    ].join('\n');
  }

  return null;
}

export function wavePerformanceMessage(state) {
  const trades = Object.values(state.trades)
    .filter(trade => trade.sentAt);

  const closed = trades.filter(trade => trade.status === 'CLOSED');
  const wins = closed.filter(trade => trade.netPct > 0.000001);
  const losses = closed.filter(trade => trade.netPct < -0.000001);

  const average = closed.length
    ? closed.reduce((sum, trade) => sum + trade.netPct, 0) / closed.length
    : null;

  return [
    '🧪 گزارش آزمایشی موج‌سوار',
    'جدا از آمار اسکنر اصلی و حد ضرر ثابت.',
    'ارسال‌شده: ' + trades.length,
    'بسته‌شده: ' + closed.length,
    'بدون ورود: ' + trades.filter(trade => trade.status === 'EXPIRED_NO_ENTRY').length,
    'مبهم: ' + trades.filter(trade => trade.status === 'AMBIGUOUS').length,
    'باز: ' + trades.filter(trade =>
      trade.status === 'OPEN' || trade.status === 'PENDING_ENTRY'
    ).length,
    'موفق: ' + wins.length,
    'ناموفق: ' + losses.length,
    'میانگین خالص بسته‌شده‌ها: ' + signed(average, 3) + '%',
    'نمونه کم یا صفر، کیفیت مدل را اثبات نمی‌کند.',
    'نتایج فرضی Gate هستند، نه سود حساب LBank.',
  ].join('\n');
    }
