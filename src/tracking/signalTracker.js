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

export const EVALUATION = Object.freeze({
  version: 'pro-dynamic-stop-v2',
  maxHoldSeconds: DAY,
  observationSeconds: 2 * DAY,
  feeRate: 0.0006,
  slippageRate: 0.0003,
  fundingIncluded: false,
  entryModel: 'SMART_ZONE_OVERLAP_ENTRY',
  stopModel: 'WICK_PROTECTED_AND_AUTO_BREAKEVEN',
  wickToleranceR: 0.35, // تحمل شدوی استاپ‌هانت تا ۳۵٪ ریسک در صورت برگشت کلوز کندل
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
    ) {
      throw new Error('Invalid signal-state.json; refusing to overwrite');
    }

    for (const signal of Object.values(state.signals)) {
      if (signal.status === 'PENDING_DELIVERY') {
        signal.status = 'DELIVERY_UNKNOWN';
        signal.deliveryNote = 'Previous execution ended before delivery confirmation';
      }
      signal.liveAlertsSent ??= {};
      signal.pendingLiveAlerts ??= [];
      signal.activeStop ??= signal.stop;
      signal.survivedWickCount ??= 0;
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

  return !Object.values(state.signals).some(
    s =>
      s.symbol === candidate.symbol &&
      s.side === candidate.side &&
      ['PENDING_DELIVERY', 'PENDING_ENTRY', 'OPEN'].includes(s.status)
  );
}

export function createSignal(candidate, strategy, config = {}) {
  const entry = candidate.side === 'LONG' ? candidate.entryHigh : candidate.entryLow;
  const targets = candidate.takeProfits.map(t => t.price);
  const weights =
    targets.length === 3 ? [0.4, 0.4, 0.2] : targets.length === 2 ? [0.5, 0.5] : [1];

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
    !targets.every((t, i) =>
      long ? t > (i === 0 ? entry : targets[i - 1]) : t < (i === 0 ? entry : targets[i - 1])
    )
  ) {
    throw new Error('Invalid directional target/stop order');
  }

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

  const sentSeconds = Date.parse(signal.sentAt) / 1000;
  signal.nextMinute = Math.ceil(sentSeconds / MINUTE) * MINUTE;
  const expiry = Date.parse(signal.validUntil) / 1000;

  if (signal.nextMinute + MINUTE > expiry) {
    signal.status = 'EXPIRED_NO_ENTRY';
    signal.exitTime = signal.sentAt;
    signal.observationComplete = true;
  }
}

function direction(signal, price) {
  return ((signal.side === 'LONG' ? price - signal.entry : signal.entry - price) / signal.entry) * 100;
}

function currentStopLevel(signal) {
  return positive(signal.activeStop) ? signal.activeStop : signal.stop;
}

// سیستم حد ضرر هوشمند ضدِ شدو (Wick-Protected Stop):
// اگر قیمت فقط با شدوی ۱ دقیقه‌ای کمی از استاپ رد شود ولی بالای استاپ بسته شود، فریب استاپ‌هانت را نمی‌خورد!
function evaluateStopTouch(signal, candle) {
  const stopPrice = currentStopLevel(signal);
  const isInitialStop = Math.abs(stopPrice - signal.stop) < 1e-8;
  const maxWickBuffer = isInitialStop ? signal.initialRisk * EVALUATION.wickToleranceR : 0;

  if (signal.side === 'LONG') {
    const hardCatastrophicStop = stopPrice - maxWickBuffer;
    if (candle.low > stopPrice) return { hit: false, survivedWick: false };
    // اگر کلوز کندل زیر استاپ بسته شد یا شدو از حد مجاز استاپ‌هانت رد شد -> استاپ واقعی
    if (candle.close <= stopPrice || candle.low <= hardCatastrophicStop) {
      return { hit: true, fillPrice: Math.min(stopPrice, candle.close) };
    }
    return { hit: false, survivedWick: true };
  } else {
    const hardCatastrophicStop = stopPrice + maxWickBuffer;
    if (candle.high < stopPrice) return { hit: false, survivedWick: false };
    if (candle.close >= stopPrice || candle.high >= hardCatastrophicStop) {
      return { hit: true, fillPrice: Math.max(stopPrice, candle.close) };
    }
    return { hit: false, survivedWick: true };
  }
}

function crossedStopAtOpen(signal, candle) {
  const stopPrice = currentStopLevel(signal);
  const isInitialStop = Math.abs(stopPrice - signal.stop) < 1e-8;
  const maxWickBuffer = isInitialStop ? signal.initialRisk * EVALUATION.wickToleranceR : 0;

  return signal.side === 'LONG'
    ? candle.open <= stopPrice - maxWickBuffer
    : candle.open >= stopPrice + maxWickBuffer;
}

function targetTouched(signal, candle, price) {
  return signal.side === 'LONG' ? candle.high >= price : candle.low <= price;
}

function targetAtOpen(signal, candle, price) {
  return signal.side === 'LONG' ? candle.open >= price : candle.open <= price;
}

function queueLiveAlert(signal, key, text) {
  signal.liveAlertsSent ??= {};
  signal.pendingLiveAlerts ??= [];
  if (signal.liveAlertsSent[key]) return;
  signal.liveAlertsSent[key] = new Date().toISOString();
  signal.pendingLiveAlerts.push({ key, text });
}

// انتقال خودکار حد ضرر به نقطه ورود (ریسک‌فری) پس از TP1 و به TP1 پس از TP2
function upgradeDynamicTrailingStop(signal) {
  if (signal.targetHits[1] != null && signal.targets[0] != null) {
    signal.activeStop = signal.targets[0];
  } else if (signal.targetHits[0] != null) {
    signal.activeStop = signal.entry;
  }
}

function recordExit(signal, price, fraction, reason, time) {
  const quantity = Math.min(signal.remaining, fraction);
  if (!(quantity > 0)) return;

  const gross = direction(signal, price) * quantity;
  const costRate = signal.evaluation.feeRate + signal.evaluation.slippageRate;
  const costs = costRate * (1 + price / signal.entry) * 100 * quantity;

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
  const riskPct = (signal.initialRisk / signal.entry) * 100;
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
  const beyond =
    signal.side === 'LONG'
      ? ((favorablePrice - finalTarget) / finalTarget) * 100
      : ((finalTarget - favorablePrice) / finalTarget) * 100;

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

    // ورود هوشمند روی کل ناحیه ورود (نه فقط یک نقطه تک‌قیمتی)
    const zoneLow = Math.min(signal.entryLow ?? signal.entry, signal.entryHigh ?? signal.entry);
    const zoneHigh = Math.max(signal.entryLow ?? signal.entry, signal.entryHigh ?? signal.entry);
    const tolerance = signal.initialRisk * 0.12;

    const touchedZone =
      candle.low <= zoneHigh + tolerance && candle.high >= zoneLow - tolerance;

    if (!touchedZone) return;

    const realisticEntry =
      signal.side === 'LONG'
        ? Math.min(zoneHigh, Math.max(zoneLow, candle.open))
        : Math.max(zoneLow, Math.min(zoneHigh, candle.open));

    signal.entry = realisticEntry;
    signal.activeStop = signal.stop;
    signal.entryTime = new Date(end * 1000).toISOString();
    signal.entryCandleTime = candle.time;
    signal.holdUntil = end + signal.evaluation.maxHoldSeconds;
    signal.observeUntil = end + signal.evaluation.observationSeconds;
    signal.status = 'OPEN';
    enteredThisCandle = true;

    const targetInEntryCandle = signal.targets.some(t => targetTouched(signal, candle, t));
    const stopCheck = evaluateStopTouch(signal, candle);
    if (stopCheck.hit && targetInEntryCandle) {
      ambiguous(signal, 'ENTRY_AND_EXIT_LEVEL_IN_SAME_MINUTE', end);
    }
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
    const reason = signal.targetHits[0] != null ? 'TRAILING_STOP_AFTER_TP' : 'STOP_GAP';
    recordExit(signal, candle.open, signal.remaining, reason, candle.time);
    finalize(signal, reason, candle.time);
    return;
  }

  for (let i = 0; i < signal.targets.length; i++) {
    if (signal.targetHits[i] == null && targetAtOpen(signal, candle, signal.targets[i])) {
      signal.targetHits[i] = new Date(candle.time * 1000).toISOString();
      recordExit(signal, signal.targets[i], signal.weights[i], 'TP' + (i + 1), candle.time);
      upgradeDynamicTrailingStop(signal);
    }
  }

  if (signal.remaining < 1e-9) {
    finalize(signal, 'ALL_TARGETS', candle.time);
    return;
  }

  const pendingHits = signal.targets
    .map((price, i) => ({ price, i }))
    .filter(x => signal.targetHits[x.i] == null && targetTouched(signal, candle, x.price));

  const stopEval = evaluateStopTouch(signal, candle);
  if (stopEval.survivedWick) {
    signal.survivedWickCount = (signal.survivedWickCount ?? 0) + 1;
  }

  if (stopEval.hit && pendingHits.length) {
    ambiguous(signal, 'STOP_AND_TARGET_IN_SAME_MINUTE', end);
    return;
  }

  if (stopEval.hit) {
    const stopReason = signal.targetHits[0] != null ? 'BREAKEVEN_AFTER_TP1' : 'STOP';
    recordExit(signal, stopEval.fillPrice, signal.remaining, stopReason, end);
    finalize(signal, stopReason, end);
    return;
  }

  for (const { price, i } of pendingHits) {
    signal.targetHits[i] = new Date(end * 1000).toISOString();
    recordExit(signal, price, signal.weights[i], 'TP' + (i + 1), end);
    upgradeDynamicTrailingStop(signal);
  }

  if (signal.remaining < 1e-9) {
    finalize(signal, 'ALL_TARGETS', end);
    return;
  }

  signal.observedMfePct = Math.max(signal.observedMfePct, movement.favorable);
  signal.observedMaePct = Math.max(signal.observedMaePct, movement.adverse);

  if (end >= signal.holdUntil) {
    recordExit(signal, candle.close, signal.remaining, 'TIME_EXIT', end);
    finalize(signal, 'TIME_EXIT', end);
  }
  if (end >= signal.observeUntil) signal.observationComplete = true;
}

// ==================== کالبدشکافی پس از استاپ و انقضا (Post-Mortem Forensics) ====================
// بررسی می‌کند چند درصد از ارزهایی که به حد ضرر خوردند یا بدون ورود بسته شدند، بدون شکست ساختار به اهداف رسیدند!
async function auditPostStopAndExpiredSignals(state, nowSeconds) {
  const candidatesForAudit = Object.values(state.signals).filter(s => {
    if (!['CLOSED', 'EXPIRED_NO_ENTRY'].includes(s.status)) return false;
    const isStopped = s.status === 'CLOSED' && (s.exitReason === 'STOP' || s.exitReason === 'STOP_GAP' || s.netPct < 0);
    const isExpired = s.status === 'EXPIRED_NO_ENTRY';
    if (!isStopped && !isExpired) return false;

    const baseTime = Date.parse(s.exitTime || s.createdAt) / 1000;
    if (!Number.isFinite(baseTime)) return false;

    // اگر قبلاً بعد از گذشت ۱۲ ساعت کامل کالبدشکافی شده، دوباره درخواست نزن
    if (s.postMortem?.complete) return false;
    return nowSeconds - baseTime >= 900; // حداقل ۱۵ دقیقه از بسته شدن گذشته باشد
  });

  // در هر اسکن حداکثر ۱۵ سیگنال قدیمی/جدید را کالبدشکافی می‌کنیم تا به API فشار نیاید
  for (const signal of candidatesForAudit.slice(0, 15)) {
    try {
      const startSec = Math.floor(Date.parse(signal.createdAt) / 1000 / 900) * 900;
      const raw15 = await requestGate('candlesticks', {
        contract: signal.symbol,
        interval: '15m',
        from: startSec,
        to: Math.min(Math.floor(nowSeconds), startSec + 192 * 900),
      });

      const candles = closedCandles(raw15, 900, nowSeconds);
      if (candles.length < 2) continue;

      const longSide = signal.side === 'LONG';
      const exitSec = Date.parse(signal.exitTime || signal.createdAt) / 1000;
      const postCandles = candles.filter(c => c.time + 900 >= exitSec);
      if (postCandles.length === 0) continue;

      const highestAfter = Math.max(...postCandles.map(c => c.high));
      const lowestAfter = Math.min(...postCandles.map(c => c.low));

      const reachedTargets = (signal.targets || []).map(tp =>
        longSide ? highestAfter >= tp : lowestAfter <= tp
      );
      const highestTpReached = reachedTargets.lastIndexOf(true) + 1; // 0, 1, 2, or 3

      // میزان نفوذ بیش از حد ضرر (بر حسب واحد ریسک R)
      const worstPrice = longSide ? lowestAfter : highestAfter;
      const overshootDist = longSide
        ? Math.max(0, signal.stop - worstPrice)
        : Math.max(0, worstPrice - signal.stop);
      const overshootR = signal.initialRisk > 0 ? round(overshootDist / signal.initialRisk, 2) : 0;

      // اگر کمتر از 0.9R از حد ضرر رد شده و هیچ کندل 15m با فاصله سنگین زیر ساختار بسته نشده، یعنی ساختار نشکسته (فقط استاپ‌هانت بوده!)
      const structureIntact = overshootR <= 0.95;

      const isStoppedOut = signal.status === 'CLOSED';
      const stopHuntedThenWon = isStoppedOut && highestTpReached >= 1 && structureIntact;
      const reversedAfterStopAny = isStoppedOut && highestTpReached >= 1;

      // برای سیگنال‌های منقضی بدون ورود: آیا بدون زدن استاپ مستقیم به تارگت رسید؟
      const touchedStopInPost = longSide ? lowestAfter <= signal.stop : highestAfter >= signal.stop;
      const missedEntryThenWon =
        signal.status === 'EXPIRED_NO_ENTRY' && highestTpReached >= 1 && !touchedStopInPost;

      const ageHours = (nowSeconds - exitSec) / 3600;

      signal.postMortem = {
        auditedAt: new Date().toISOString(),
        complete: ageHours >= 18 || highestTpReached === signal.targets.length,
        highestTpReached,
        overshootR,
        structureIntact,
        stopHuntedThenWon,
        reversedAfterStopAny,
        missedEntryThenWon,
      };
    } catch (error) {
      console.warn('[POST-MORTEM]', signal.symbol, error.message);
    }
  }
}

async function evaluateLiveSignalHealth(signal, nowSeconds, btcDeep) {
  if (signal.status !== 'OPEN') return;

  try {
    const raw15 = await requestGate('candlesticks', {
      contract: signal.symbol,
      interval: '15m',
      limit: 65,
    });

    const c15closed = closedCandles(raw15, 900, nowSeconds);
    if (c15closed.length < 30) return;

    const live15 = extractDevelopingCandle(raw15, c15closed, 900, nowSeconds);
    const fullSeries = live15 ? [...c15closed, live15] : c15closed;

    const c15 = indicators(fullSeries);
    const last = c15.at(-1);
    const prev = c15.at(-2);
    const currentPrice = last.close;
    const longSide = signal.side === 'LONG';
    const pnlPct = round(direction(signal, currentPrice), 2);
    const sign = pnlPct >= 0 ? '+' : '';

    for (let i = 0; i < signal.targets.length - 1; i++) {
      if (signal.targetHits[i] != null) {
        const tpKey = 'TP_HIT_' + (i + 1);
        const nextTp = signal.targets[i + 1];
        const strongContinuation =
          last.adx >= 22 && (longSide ? last.close > last.ema9 : last.close < last.ema9);

        queueLiveAlert(
          signal,
          tpKey,
          [
            '✅ آپدیت لحظه‌ای سیگنال: هدف ' + (i + 1) + ' (TP' + (i + 1) + ') با موفقیت زده شد!',
            '🪙 ارز: #' + signal.symbol + ' | جهت: ' + signal.side,
            '💰 قیمت هدف زده‌شده: ' + signal.targets[i],
            '📊 وضعیت ادامه حرکت: ' +
              (strongContinuation
                ? '🔥 قدرت حرکت در کندل جاری بالاست و مسیر به سمت هدف بعدی (' + nextTp + ') باز است.'
                : '⚖️ شتاب حرکت کمی متعادل شده؛ حتماً بخشی از سود را سیو کنید.'),
            '🛡️ سیستم محافظ سود: حد ضرر باقی‌مانده معامله به صورت خودکار به نقطه ورود (' +
              signal.activeStop +
              ') منتقل و ریسک‌فری شد!',
            '₿ وضعیت فعلی BTC: ' + (btcDeep?.regimeFa ?? '—') + ' — ' + (btcDeep?.nextMoveForecast ?? ''),
          ].join('\n')
        );
      }
    }

    const tp2Hit = signal.targets.length >= 2 && signal.targetHits[1] != null;
    const tp3 = signal.targets.at(-1);
    const distToTp3 = Math.abs(tp3 - signal.entry);
    const currentGainDist = longSide ? currentPrice - signal.entry : signal.entry - currentPrice;

    if (
      (tp2Hit || currentGainDist >= distToTp3 * 0.75) &&
      last.adx >= 25 &&
      last.volumeRatio >= 1.35 &&
      (longSide ? last.close > last.ema9 : last.close < last.ema9)
    ) {
      const dir = longSide ? 1 : -1;
      const extendedTarget4 = round(tp3 + dir * signal.initialRisk * 1.6, 6);

      queueLiveAlert(
        signal,
        'EXTENDED_RUNNER',
        [
          '🚀 انفجار مومنتوم: ظرفیت عبور از اهداف تعیین‌شده فعال شد!',
          '🪙 ارز: #' + signal.symbol + ' | سود فعلی: ' + sign + pnlPct + '%',
          '📈 تحلیل لحظه‌ای: حجم معاملات (' +
            round(last.volumeRatio, 1) +
            ' برابر میانگین) و قدرت روند (ADX: ' +
            round(last.adx, 1) +
            ') نشان می‌دهد حرکت اصلی بسیار پرقدرت است و پتانسیل عبور از هدف سوم (' +
            tp3 +
            ') را دارد.',
          '🎯 هدف چهارم (فراتر از اهداف): ' + extendedTarget4,
          '💡 فرمان لحظه‌ای: کل پوزیشن را در TP3 نبندید؛ ۲۰٪ حجم را با تریل کردن حد ضرر برای شکار موج بزرگ‌تر نگه دارید.',
        ].join('\n')
      );
    }

    const range = last.high - last.low;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);

    const dippedIntoDrawdown = longSide
      ? last.low < signal.entry - signal.initialRisk * 0.25 && last.low > signal.stop
      : last.high > signal.entry + signal.initialRisk * 0.25 && last.high < signal.stop;

    const recoveredStrongly =
      range > 0 &&
      (longSide
        ? lowerWick / range >= 0.45 && last.close >= signal.entry * 0.998
        : upperWick / range >= 0.45 && last.close <= signal.entry * 1.002);

    if (
      (dippedIntoDrawdown && recoveredStrongly && signal.targetHits[0] == null) ||
      signal.survivedWickCount > 0
    ) {
      queueLiveAlert(
        signal,
        'SHAKEOUT_COMPLETED',
        [
          '🪤 کشف و خنثی‌سازی کلک بازارگردان (Stop-Hunt) روی #' + signal.symbol,
          '📊 وضعیت لحظه‌ای: قیمت یک شدوی فریبنده به سمت حد ضرر زد تا تریدرهای عادی را لیکویید کند، اما بدون شکستن ساختار سریع به داخل برگشت!',
          '🔋 نتیجه رادار: سیستم ضدِ شدو فعال شد و معامله را نبست؛ ارز در حال جمع کردن انرژی برای شروع حرکت اصلی است.',
          '🟢 فرمان لحظه‌ای: احتمال انجام حرکت اصلی پابرجاست؛ با اطمینان معامله را حفظ کنید.',
        ].join('\n')
      );
    }

    const tp1 = signal.targets[0];
    const distToTp1 = Math.abs(tp1 - signal.entry);
    const reachedNearTp1 =
      signal.targetHits[0] == null &&
      currentGainDist >= distToTp1 * 0.65 &&
      currentGainDist < distToTp1;

    const momentumStalling = longSide
      ? last.close < last.open &&
        last.macdHist < prev.macdHist &&
        (upperWick > range * 0.38 || last.rsi < prev.rsi - 2.5)
      : last.close > last.open &&
        last.macdHist > prev.macdHist &&
        (lowerWick > range * 0.38 || last.rsi > prev.rsi + 2.5);

    const momentumStrongNearTp1 = longSide
      ? currentGainDist >= distToTp1 * 0.78 &&
        last.close > last.open &&
        last.volumeRatio >= 1.3 &&
        last.close >= last.ema9
      : currentGainDist >= distToTp1 * 0.78 &&
        last.close < last.open &&
        last.volumeRatio >= 1.3 &&
        last.close <= last.ema9;

    if (reachedNearTp1 && momentumStalling) {
      queueLiveAlert(
        signal,
        'TP1_WEAKNESS_WARNING',
        [
          '⚠️ هشدار لحظه‌ای: احتمال نرسیدن به هدف اول (TP1) روی #' + signal.symbol,
          '💰 قیمت لحظه‌ای: ' + currentPrice + ' (سود فعلی: ' + sign + pnlPct + '%)',
          '🔍 علت هشدار: قیمت به نزدیکی هدف اول (' +
            tp1 +
            ') رسیده اما در کندل جاری فشار مخالف ظاهر شده و شتاب حرکت کم شده است.',
          '🛡️ فرمان لحظه‌ای برای حفظ سود: منتظر لمس دقیق TP1 نمانید! همین الان ۵۰٪ سود را دستی سیو کنید و حد ضرر مابقی را روی نقطه ورود بگذارید.',
        ].join('\n')
      );
    } else if (reachedNearTp1 && momentumStrongNearTp1) {
      queueLiveAlert(
        signal,
        'APPROACHING_TP1_STRONG',
        [
          '🔥 نزدیک شدن پرقدرت به هدف اول (TP1) روی #' + signal.symbol,
          '💰 قیمت لحظه‌ای: ' + currentPrice + ' (سود فعلی: ' + sign + pnlPct + '%) | هدف اول: ' + tp1,
          '📈 وضعیت رادار: شتاب حجم در کندل جاری بالاست و احتمال شکست TP1 و حرکت به سمت TP2 (' +
            (signal.targets[1] ?? tp1) +
            ') بسیار بالاست.',
          '📌 فرمان لحظه‌ای: آماده سیو سود پله اول در TP1 باشید و باقی‌مانده پوزیشن را با ریسک‌فری کردن برای اهداف بالاتر نگه دارید.',
        ].join('\n')
      );
    }

    const adverseDist = longSide ? signal.entry - currentPrice : currentPrice - signal.entry;
    const inDangerZone =
      signal.targetHits[0] == null &&
      adverseDist >= signal.initialRisk * 0.55 &&
      adverseDist < signal.initialRisk * 0.95;

    const structureBrokenAgainstUs = longSide
      ? last.close < last.ema20 &&
        prev.close < prev.ema20 &&
        last.close < last.open &&
        last.rsi < 38 &&
        lowerWick < range * 0.22
      : last.close > last.ema20 &&
        prev.close > prev.ema20 &&
        last.close > last.open &&
        last.rsi > 62 &&
        upperWick < range * 0.22;

    if (inDangerZone && structureBrokenAgainstUs) {
      queueLiveAlert(
        signal,
        'EMERGENCY_EXIT_WARNING',
        [
          '🛑 فرمان خروج اضطراری (محافظت از سرمایه) روی #' + signal.symbol,
          '📉 قیمت لحظه‌ای: ' + currentPrice + ' (' + sign + pnlPct + '%) | جهت سیگنال: ' + signal.side,
          '⚠️ علت هشدار: ساختار ۱۵ دقیقه بدون زدن شدوی برگشتی شکسته شده و حرکت اصلی تضعیف شده است. احتمال لمس حد ضرر (' +
            signal.stop +
            ') بالا رفته است.',
          '🚨 فرمان لحظه‌ای: برای اینکه بیشتر ضرر نکنید، منتظر خوردن استاپ‌لاس کامل نمانید و همین الان با ضرر کوچک خارج شوید.',
          '₿ وضعیت بیت‌کوین: ' + (btcDeep?.regimeFa ?? '—') + ' — ' + (btcDeep?.nextMoveForecast ?? ''),
        ].join('\n')
      );
    }
  } catch (error) {
    console.warn('[LIVE RADAR]', signal.symbol, error.message);
  }
}

function trackingNeeded(signal) {
  if (signal.status === 'PENDING_ENTRY' || signal.status === 'OPEN') return true;
  return Boolean(
    signal.entryTime &&
      !signal.observationComplete &&
      ['CLOSED', 'AMBIGUOUS'].includes(signal.status)
  );
}

async function updateOne(signal, nowSeconds, btcDeep) {
  if (!trackingNeeded(signal)) return;

  const prevStatus = signal.status;
  const closedEnd = Math.floor(nowSeconds / MINUTE) * MINUTE;

  for (let page = 0; page < EVALUATION.maxPagesPerSignalPerRun; page++) {
    const from = signal.nextMinute;
    if (!Number.isFinite(from)) throw new Error('Missing tracking cursor');

    const horizon = signal.entryTime
      ? signal.observeUntil
      : Math.floor(Date.parse(signal.validUntil) / 1000 / MINUTE) * MINUTE;

    const until = Math.min(closedEnd, horizon, from + 500 * MINUTE);

    if (from >= until) {
      if (signal.status === 'PENDING_ENTRY' && closedEnd >= horizon) {
        signal.status = 'EXPIRED_NO_ENTRY';
        signal.exitTime = signal.validUntil;
        signal.observationComplete = true;
      } else if (signal.entryTime && from >= signal.observeUntil) {
        signal.observationComplete = true;
      }
      break;
    }

    const raw = await requestGate('candlesticks', {
      contract: signal.symbol,
      interval: '1m',
      from,
      to: until - 1,
    });

    const candles = closedCandles(raw, MINUTE, nowSeconds).filter(
      c => c.time >= from && c.time < until
    );
    const byTime = new Map(candles.map(c => [c.time, c]));

    for (let time = from; time < until; time += MINUTE) {
      const candle = byTime.get(time);
      if (!candle) {
        signal.dataIssue = {
          type: 'MISSING_MINUTE',
          time: new Date(time * 1000).toISOString(),
          checkedAt: new Date().toISOString(),
        };
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
      signal,
      'ENTRY_ACTIVATED',
      [
        '🎯 نقطه ورود فعال شد: معامله #' + signal.symbol + ' (' + signal.side + ') باز شد!',
        '💵 قیمت ورود: ' + signal.entry + ' | 🛑 حد ضرر هوشمند (ضد شدو): ' + signal.stop,
        '🎯 اهداف: ' + signal.targets.join(' -> '),
        '📡 رادار زنده و محافظ ریسک‌فری خودکار پس از TP1 فعال است.',
      ].join('\n')
    );
  }

  if (signal.status === 'OPEN') {
    await evaluateLiveSignalHealth(signal, nowSeconds, btcDeep);
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
  const hasActiveOpenSignals = Object.values(state.signals).some(
    s => s.status === 'OPEN' || s.status === 'PENDING_ENTRY'
  );

  const btcDeep = hasActiveOpenSignals ? await analyzeBtcDeep(nowSeconds) : null;

  for (const signal of Object.values(state.signals)) {
    try {
      await updateOne(signal, nowSeconds, btcDeep);
    } catch (error) {
      signal.dataIssue = {
        type: 'FETCH_ERROR',
        message: error.message,
        checkedAt: new Date().toISOString(),
      };
      console.error('[TRACKER]', signal.symbol, error.message);
    }
    await saveSignalState(state);
  }

  // اجرای موتور کالبدشکافی روی سیگنال‌های استاپ‌شده و منقضی‌شده
  await auditPostStopAndExpiredSignals(state, nowSeconds);
  await saveSignalState(state);
}

export function resultMessage(signal) {
  const lines = [
    '📋 نتیجه نهایی سیگنال Gate',
    signal.symbol + ' | ' + signal.side + ' | ' + signal.id.slice(0, 12),
  ];

  if (signal.status === 'EXPIRED_NO_ENTRY') {
    lines.push('⏳ منقضی بدون ورود (قیمت در زمان معتبر به محدوده ورود نرسید و سیگنال لغو شد).');
  } else if (signal.status === 'AMBIGUOUS') {
    lines.push(
      'نتیجه مبهم: ترتیب لمس سطوح در کندل یک‌دقیقه‌ای مشخص نیست.',
      'از آمار برد و باخت قطعی کنار گذاشته شده است.'
    );
  } else {
    const sign = signal.netPct >= 0 ? '+' : '';
    lines.push(
      'نتیجه خالص تخمینی (بدون اهرم): ' + sign + signal.netPct.toFixed(3) + '%',
      'نتیجه برحسب ریسک اولیه: ' + signal.netR.toFixed(2) + 'R',
      'علت پایان: ' + signal.exitReason,
      'اهداف ثبت‌شده: ' +
        signal.targetHits.map((time, i) => 'T' + (i + 1) + (time ? ' ✓' : ' —')).join(' | ')
    );
  }
  return lines.join('\n');
}

const pct = (count, total) => (total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '—');

function periodReport(signals, days, now) {
  const since = now - days * DAY * 1000;
  const issued = signals.filter(s => s.sentAt && Date.parse(s.sentAt) >= since);
  const activated = issued.filter(s => s.entryTime);
  const closed = issued.filter(s => s.status === 'CLOSED');
  const wins = closed.filter(s => s.netPct > 0.000001);
  const losses = closed.filter(s => s.netPct < -0.000001);
  const flat = closed.length - wins.length - losses.length;

  const stoppedList = closed.filter(s => s.netPct < 0);
  const huntedButWon = stoppedList.filter(s => s.postMortem?.stopHuntedThenWon).length;
  const expiredList = issued.filter(s => s.status === 'EXPIRED_NO_ENTRY');
  const missedWinners = expiredList.filter(s => s.postMortem?.missedEntryThenWon).length;

  const positiveSum = wins.reduce((sum, s) => sum + s.netPct, 0);
  const negativeSum = -losses.reduce((sum, s) => sum + s.netPct, 0);
  const factor =
    negativeSum > 0
      ? (positiveSum / negativeSum).toFixed(2)
      : positiveSum > 0
      ? 'بدون زیان ثبت‌شده'
      : '—';

  const averageNet = closed.length
    ? closed.reduce((sum, s) => sum + s.netPct, 0) / closed.length
    : null;
  const averageR = closed.length
    ? closed.reduce((sum, s) => sum + s.netR, 0) / closed.length
    : null;

  const lines = [
    'بازه صدور: ' + days + ' روز اخیر',
    'ارسال‌شده: ' + issued.length + ' | فعال‌شده: ' + activated.length,
    '✅ سودده: ' + wins.length + ' | ' + pct(wins.length, closed.length),
    '❌ زیان‌ده (حد ضرر): ' + losses.length + ' | ' + pct(losses.length, closed.length),
    '🪤 استاپ‌هانت‌شده که بعداً بدون شکست ساختار به هدف رسید: ' +
      huntedButWon +
      ' از ' +
      stoppedList.length +
      ' (' +
      pct(huntedButWon, stoppedList.length) +
      ')',
    '🏃‍♂️ بدون ورود (منقضی) که مستقیم به هدف رسید: ' +
      missedWinners +
      ' از ' +
      expiredList.length +
      ' (' +
      pct(missedWinners, expiredList.length) +
      ')',
    'میانگین خالص هر معامله: ' + (averageNet == null ? '—' : averageNet.toFixed(3) + '%'),
    'امید ریاضی مشاهده‌شده: ' + (averageR == null ? '—' : averageR.toFixed(3) + 'R'),
    'ضریب سود: ' + factor,
  ];

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
      '📊 گزارش عملکرد Gate\nهنوز سیگنال با ارسال تأییدشده برای ارزیابی ثبت نشده است.',
    ];
  }

  const messages = [];
  for (const [version, group] of groups) {
    messages.push(
      [
        '📊 گزارش عملکرد و کالبدشکافی استاپ‌هانت Gate',
        'نسخه: ' + version,
        periodReport(group, 7, now),
        '━━━━━━━━━━━━━━━━━━',
        periodReport(group, 30, now),
      ].join('\n')
    );
  }

  return messages;
}
