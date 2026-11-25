import {
  analyzeWave,
  atrSeries,
  ema,
  macdHistogram,
} from './waveAnalysis.js';

// Wave Rider prototype.
// Uses closed Gate candles only.
// WATCH is not an entry signal.
// EXIT_REVIEW is an alert to inspect a position, not an exchange order.
// This module does not alter the existing scanner or paper evaluator.

export const WAVE_RIDER_VERSION = 'wave-rider-prototype-v1';

export const WAVE_RULES = Object.freeze({
  MIN_1H_CANDLES: 60,
  MIN_15M_CANDLES: 32,

  BASE_BARS: 8,
  VOLUME_BASELINE_BARS: 20,

  MIN_BREAK_VOLUME_RATIO: 1.3,
  MIN_CLOSE_LOCATION: 0.65,
  MAX_BREAK_DISTANCE_ATR: 0.8,
  MAX_TRIGGER_CANDLE_ATR: 2.5,

  ENTRY_HALF_WIDTH_ATR: 0.1,
  MAX_ENTRY_HALF_WIDTH_PCT: 0.15,
  STOP_BUFFER_ATR: 0.3,

  MIN_RISK_ATR: 0.5,
  MAX_RISK_ATR: 4,
  MAX_RISK_PCT: 4.5,

  MIN_NET_RR_TO_PRIOR_EXTREME: 1.5,
  COST_PER_SIDE: 0.0009,

  TRAIL_LOOKBACK_BARS: 3,
  TRAIL_BUFFER_ATR: 0.35,
  MIN_PROFIT_TO_ADVANCE_TRAIL_ATR: 0.75,

  ENTRY_VALID_SECONDS: 900,
});

function validNumber(value) {
  return Number.isFinite(value);
}

function positive(value) {
  return validNumber(value) && value > 0;
}

function round(value, digits = 4) {
  return validNumber(value)
    ? Number(value.toFixed(digits))
    : null;
}

function candleValid(candle) {
  if (!candle || !positive(candle.time)) return false;

  const prices = [
    candle.open,
    candle.high,
    candle.low,
    candle.close,
  ];

  if (!prices.every(positive)) return false;
  if (candle.high < Math.max(candle.open, candle.close)) return false;
  if (candle.low > Math.min(candle.open, candle.close)) return false;
  if (candle.low > candle.high) return false;

  return true;
}

function closedContinuousCandles(
  candles,
  seconds,
  minimum,
  asOf
) {
  if (!Array.isArray(candles)) return null;
  if (!positive(asOf)) return null;

  const closed = candles
    .filter(candle =>
      candleValid(candle) &&
      candle.time + seconds <= asOf
    )
    .sort((a, b) => a.time - b.time);

  if (closed.length < minimum) return null;

  const expectedLastStart =
    Math.floor(asOf / seconds) * seconds - seconds;

  if (closed.at(-1).time !== expectedLastStart) {
    return null;
  }

  const recent = closed.slice(-minimum);

  for (let index = 1; index < recent.length; index++) {
    if (
      recent[index].time - recent[index - 1].time !== seconds
    ) {
      return null;
    }
  }

  return closed;
}

function volumeRatio(candles) {
  const lookback = WAVE_RULES.VOLUME_BASELINE_BARS;
  const previous = candles.slice(-lookback - 1, -1);
  const last = candles.at(-1);

  if (previous.length !== lookback) return null;

  const all = [...previous, last];

  const hasQuoteVolume = all.every(candle =>
    validNumber(candle.quoteTurnover) &&
    candle.quoteTurnover >= 0
  );

  const field = hasQuoteVolume
    ? 'quoteTurnover'
    : 'volumeContracts';

  if (!all.every(candle =>
    validNumber(candle[field]) &&
    candle[field] >= 0
  )) {
    return null;
  }

  const average = previous.reduce(
    (sum, candle) => sum + candle[field],
    0
  ) / lookback;

  return positive(average)
    ? last[field] / average
    : null;
}

function netRiskReward(side, entry, stop, target) {
  const cost = WAVE_RULES.COST_PER_SIDE;

  const priceRisk = side === 'LONG'
    ? entry - stop
    : stop - entry;

  const priceReward = side === 'LONG'
    ? target - entry
    : entry - target;

  const risk =
    priceRisk + (entry + stop) * cost;

  const reward =
    priceReward - (entry + target) * cost;

  return positive(risk)
    ? reward / risk
    : null;
}

function noData(reason) {
  return {
    stage: 'NO_DATA',
    reason,
  };
}

function noSetup(reason) {
  return {
    stage: 'NONE',
    reason,
  };
}

function watchResult({
  symbol,
  side,
  wave,
  base,
  asOf,
  reason,
  volumeMultiple,
}) {
  return {
    version: WAVE_RIDER_VERSION,
    stage: 'WATCH',
    symbol,
    side,
    reason,
    observedAt: new Date(asOf * 1000).toISOString(),

    structure: wave.structure,
    phase: wave.phase,
    waveNumberHeuristic: wave.waveNumber,

    correctionDepthPct: round(
      wave.correction.depth * 100,
      2
    ),

    correctionVolumeContracting:
      wave.correction.volumeContracting === true,

    correctionMacdFading:
      wave.correction.macdFading === true,

    baseHigh: base.high,
    baseLow: base.low,

    triggerLevel: side === 'LONG'
      ? base.high
      : base.low,

    priorExtreme: wave.correction.fromPrice,

    volumeMultiple: round(volumeMultiple, 2),

    note:
      'زیر نظر است؛ هنوز شرط ورود تکمیل نشده است.',
  };
}

/**
 * Evaluates an already computed 1H wave using closed 15m candles.
 * Exported separately to allow deterministic unit tests.
 */
export function assessWaveSetup({
  symbol,
  side,
  wave,
  candles15m,
  asOf,
}) {
  if (!['LONG', 'SHORT'].includes(side)) {
    return noData('INVALID_SIDE');
  }

  const candles = closedContinuousCandles(
    candles15m,
    900,
    WAVE_RULES.MIN_15M_CANDLES,
    asOf
  );

  if (!candles) {
    return noData('INVALID_OR_STALE_15M_CANDLES');
  }

  if (!wave || wave.valid !== true) {
    return noData('INVALID_1H_WAVE');
  }

  const expectedStructure = side === 'LONG'
    ? 'UP'
    : 'DOWN';

  if (
    wave.structure !== expectedStructure ||
    wave.phase !== 'CORRECTION' ||
    !wave.correction
  ) {
    return noSetup('NO_CORRECTION_IN_TREND');
  }

  const correction = wave.correction;

  if (
    correction.structureIntact !== true ||
    correction.depthHealthy !== true ||
    !positive(correction.fromPrice) ||
    !positive(correction.extreme)
  ) {
    return noSetup('CORRECTION_STRUCTURE_NOT_READY');
  }

  const last = candles.at(-1);
  const previous = candles.at(-2);

  const baseCandles = candles.slice(
    -WAVE_RULES.BASE_BARS - 1,
    -1
  );

  const base = {
    high: Math.max(...baseCandles.map(candle => candle.high)),
    low: Math.min(...baseCandles.map(candle => candle.low)),
  };

  const ratio = volumeRatio(candles);

  const watch = reason => watchResult({
    symbol,
    side,
    wave,
    base,
    asOf,
    reason,
    volumeMultiple: ratio,
  });

  const atr = atrSeries(candles).at(-1);

  if (!positive(atr)) {
    return noData('INVALID_15M_ATR');
  }

  const lastRange = last.high - last.low;

  if (!positive(lastRange)) {
    return watch('NO_TRIGGER_CANDLE_RANGE');
  }

  const longSide = side === 'LONG';

  const triggerLevel = longSide
    ? base.high
    : base.low;

  const brokeLevel = longSide
    ? (
        previous.close <= triggerLevel &&
        last.close > triggerLevel &&
        last.close > last.open
      )
    : (
        previous.close >= triggerLevel &&
        last.close < triggerLevel &&
        last.close < last.open
      );

  if (!brokeLevel) {
    return watch('WAITING_FOR_BASE_BREAK');
  }

  const breakDistance = longSide
    ? last.close - triggerLevel
    : triggerLevel - last.close;

  if (
    breakDistance > atr * WAVE_RULES.MAX_BREAK_DISTANCE_ATR ||
    lastRange > atr * WAVE_RULES.MAX_TRIGGER_CANDLE_ATR
  ) {
    return watch('BREAKOUT_ALREADY_EXTENDED');
  }

  if (
    ratio == null ||
    ratio < WAVE_RULES.MIN_BREAK_VOLUME_RATIO
  ) {
    return watch('BREAKOUT_WITHOUT_VOLUME_CONFIRMATION');
  }

  const closeLocation = longSide
    ? (last.close - last.low) / lastRange
    : (last.high - last.close) / lastRange;

  if (closeLocation < WAVE_RULES.MIN_CLOSE_LOCATION) {
    return watch('WEAK_BREAKOUT_CLOSE');
  }

  const histogram = macdHistogram(
    candles.map(candle => candle.close)
  );

  const currentHistogram = histogram.at(-1);
  const previousHistogram = histogram.at(-2);

  const momentumImproving = longSide
    ? currentHistogram > previousHistogram
    : currentHistogram < previousHistogram;

  if (!momentumImproving) {
    return watch('MACD_NOT_IMPROVING');
  }

  const halfWidth = Math.min(
    atr * WAVE_RULES.ENTRY_HALF_WIDTH_ATR,
    last.close * WAVE_RULES.MAX_ENTRY_HALF_WIDTH_PCT / 100
  );

  const entryLow = last.close - halfWidth;
  const entryHigh = last.close + halfWidth;

  const conservativeEntry = longSide
    ? entryHigh
    : entryLow;

  const stopLoss = longSide
    ? Math.min(
        correction.extreme,
        base.low,
        last.low
      ) - atr * WAVE_RULES.STOP_BUFFER_ATR
    : Math.max(
        correction.extreme,
        base.high,
        last.high
      ) + atr * WAVE_RULES.STOP_BUFFER_ATR;

  const risk = longSide
    ? conservativeEntry - stopLoss
    : stopLoss - conservativeEntry;

  const stopInvalid = longSide
    ? stopLoss >= entryLow
    : stopLoss <= entryHigh;

  if (
    !positive(stopLoss) ||
    !positive(entryLow) ||
    stopInvalid ||
    risk < atr * WAVE_RULES.MIN_RISK_ATR ||
    risk > atr * WAVE_RULES.MAX_RISK_ATR ||
    risk / conservativeEntry * 100 >
      WAVE_RULES.MAX_RISK_PCT
  ) {
    return watch('STOP_DISTANCE_NOT_ACCEPTABLE');
  }

  // This is the previous impulse extreme, NOT an invented T2 or T3.
  const historicalTarget = correction.fromPrice;

  const targetBeyondEntry = longSide
    ? historicalTarget > entryHigh
    : historicalTarget < entryLow;

  if (!targetBeyondEntry) {
    return watch('NO_ROOM_TO_PRIOR_EXTREME');
  }

  const rr = netRiskReward(
    side,
    conservativeEntry,
    stopLoss,
    historicalTarget
  );

  if (
    !validNumber(rr) ||
    rr < WAVE_RULES.MIN_NET_RR_TO_PRIOR_EXTREME
  ) {
    return watch('LOW_RR_TO_PRIOR_EXTREME');
  }

  return {
    version: WAVE_RIDER_VERSION,
    stage: 'ENTRY',
    symbol,
    side,

    observedAt: new Date(asOf * 1000).toISOString(),
    triggerCandleTime:
      new Date(last.time * 1000).toISOString(),

    validUntil: new Date(
      (last.time + 900 + WAVE_RULES.ENTRY_VALID_SECONDS) *
      1000
    ).toISOString(),

    structure: wave.structure,
    phaseBeforeEntry: wave.phase,
    waveNumberHeuristic: wave.waveNumber,
    correctionDepthPct: round(
      correction.depth * 100,
      2
    ),

    baseHigh: base.high,
    baseLow: base.low,
    triggerLevel,

    entryLow,
    entryHigh,
    conservativeEntry,
    stopLoss,

    // One identifiable historical objective only.
    priorExtremeTarget: historicalTarget,
    netRRToPriorExtreme: round(rr, 2),

    volumeMultiple: round(ratio, 2),

    evidence: [
      'ساختار روند و اصلاح 1H',
      'شکست پایه در کندل بسته‌شده 15m',
      'تأیید حجم کندل',
      'تقویت شتاب MACD در جهت حرکت',
    ],

    caution:
      'داده Gate است؛ ورود، حد ضرر و قیمت LBank باید جدا بررسی شوند.',
  };
}

/**
 * Live wrapper. Do not feed a 1H or 15m candle that has not closed.
 */
export function scanWaveSetup({
  symbol,
  side,
  candles1h,
  candles15m,
  asOf = Math.floor(Date.now() / 1000),
}) {
  const hours = closedContinuousCandles(
    candles1h,
    3600,
    WAVE_RULES.MIN_1H_CANDLES,
    asOf
  );

  if (!hours) {
    return noData('INVALID_OR_STALE_1H_CANDLES');
  }

  const wave = analyzeWave(hours, {
    minCandles: WAVE_RULES.MIN_1H_CANDLES,
  });

  return assessWaveSetup({
    symbol,
    side,
    wave,
    candles15m,
    asOf,
  });
}

/**
 * Reviews an already open position from closed Gate 15m candles.
 * Does NOT execute exits or modify an exchange stop order.
 *
 * A proposed trailing stop is calculated AFTER checking whether the
 * PREVIOUS stop was touched. The new value is not applied retroactively.
 */
export function assessWaveExit({
  position,
  candles15m,
  asOf = Math.floor(Date.now() / 1000),
}) {
  if (!position || !['LONG', 'SHORT'].includes(position.side)) {
    return noData('INVALID_POSITION');
  }

  const entry = position.entry;
  const initialStop = position.initialStop;

  if (!positive(entry) || !positive(initialStop)) {
    return noData('INVALID_POSITION_LEVELS');
  }

  const entryTime = typeof position.entryTime === 'string'
    ? Date.parse(position.entryTime) / 1000
    : position.entryTime;

  if (!positive(entryTime)) {
    return noData('INVALID_ENTRY_TIME');
  }

  const candles = closedContinuousCandles(
    candles15m,
    900,
    WAVE_RULES.MIN_15M_CANDLES,
    asOf
  );

  if (!candles) {
    return noData('INVALID_OR_STALE_15M_CANDLES');
  }

  const last = candles.at(-1);

  // Avoid attributing a candle partly before entry to the position.
  if (last.time < entryTime) {
    return {
      stage: 'WAIT',
      reason: 'NO_FULL_CLOSED_CANDLE_AFTER_ENTRY',
    };
  }

  const longSide = position.side === 'LONG';

  const priorTrail = positive(position.trailingStop)
    ? position.trailingStop
    : initialStop;

  const activeTrail = longSide
    ? Math.max(initialStop, priorTrail)
    : Math.min(initialStop, priorTrail);

  const oldStopTouched = longSide
    ? last.low <= activeTrail
    : last.high >= activeTrail;

  if (oldStopTouched) {
    return {
      stage: 'EXIT_REVIEW',
      reason: 'GATE_REFERENCE_STOP_TOUCHED',
      currentReferenceStop: activeTrail,
      nextReferenceStop: activeTrail,
      observedAt: new Date(asOf * 1000).toISOString(),
      caution:
        'لمس در Gate ثبت شده؛ وضعیت سفارش و قیمت LBank تأیید نشده است.',
    };
  }

  const atr = atrSeries(candles).at(-1);

  if (!positive(atr)) {
    return noData('INVALID_15M_ATR');
  }

  const closes = candles.map(candle => candle.close);
  const ema9 = ema(closes, 9).at(-1);
  const histogram = macdHistogram(closes);

  const momentumWeakening = longSide
    ? histogram.at(-1) < histogram.at(-2)
    : histogram.at(-1) > histogram.at(-2);

  const previousBars = candles.slice(
    -WAVE_RULES.TRAIL_LOOKBACK_BARS - 1,
    -1
  );

  const localLevel = longSide
    ? Math.min(...previousBars.map(candle => candle.low))
    : Math.max(...previousBars.map(candle => candle.high));

  const structureBroken = longSide
    ? last.close < localLevel
    : last.close > localLevel;

  const wrongSideOfEma = longSide
    ? last.close < ema9
    : last.close > ema9;

  const evidenceCount = [
    structureBroken,
    wrongSideOfEma,
    momentumWeakening,
  ].filter(Boolean).length;

  let stage = 'HOLD';
  let reason = 'NO_EXIT_CONDITION_ON_CLOSED_GATE_CANDLE';

  if (
    structureBroken &&
    (wrongSideOfEma || momentumWeakening)
  ) {
    stage = 'EXIT_REVIEW';
    reason = 'SHORT_TERM_STRUCTURE_BREAK';
  } else if (evidenceCount >= 2) {
    stage = 'WATCH_CORRECTION';
    reason = 'POSSIBLE_CORRECTION_START';
  }

  let nextTrail = activeTrail;

  if (stage === 'HOLD') {
    const favorableDistance = longSide
      ? last.close - entry
      : entry - last.close;

    if (
      favorableDistance >=
      atr * WAVE_RULES.MIN_PROFIT_TO_ADVANCE_TRAIL_ATR
    ) {
      const proposed = longSide
        ? localLevel - atr * WAVE_RULES.TRAIL_BUFFER_ATR
        : localLevel + atr * WAVE_RULES.TRAIL_BUFFER_ATR;

      const sensible = longSide
        ? proposed < last.close - atr * 0.1
        : proposed > last.close + atr * 0.1;

      if (sensible) {
        nextTrail = longSide
          ? Math.max(activeTrail, proposed)
          : Math.min(activeTrail, proposed);
      }
    }
  }

  return {
    stage,
    reason,
    observedAt: new Date(asOf * 1000).toISOString(),

    currentReferenceStop: activeTrail,
    nextReferenceStop: nextTrail,

    structureBroken,
    wrongSideOfEma,
    momentumWeakening,

    caution:
      'این فقط بررسی کندل بسته‌شده Gate است؛ حد ضرر واقعی باید در LBank ثبت باشد.',
  };
}

export function formatWaveEvent(event) {
  if (!event || !event.stage) {
    return 'وضعیت موج در دسترس نیست.';
  }

  if (event.stage === 'WATCH') {
    return [
      '👀 زیر نظر؛ هنوز ورود نیست',
      event.symbol + ' | ' + event.side,
      'سطح مورد انتظار: ' + event.triggerLevel,
      'دلیل انتظار: ' + event.reason,
      'منبع: Gate؛ قیمت LBank بررسی نشده.',
    ].join('\n');
  }

  if (event.stage === 'ENTRY') {
    return [
      '🎯 ستاپ آزمایشی موج | ' + event.symbol +
        ' | ' + event.side,
      'ورود مرجع Gate: ' + event.entryLow +
        ' تا ' + event.entryHigh,
      'حد ضرر مرجع: ' + event.stopLoss,
      'هدف تاریخی نخست: ' + event.priorExtremeTarget,
      'RR خالص تخمینی: ' + event.netRRToPriorExtreme,
      'اعتبار تا: ' + event.validUntil,
      event.caution,
    ].join('\n');
  }

  if (event.stage === 'EXIT_REVIEW') {
    return [
      '⚠️ بررسی خروج؛ نه دستور خودکار',
      'علت: ' + event.reason,
      'حد مرجع قبلی Gate: ' + event.currentReferenceStop,
      event.caution,
    ].join('\n');
  }

  if (event.stage === 'WATCH_CORRECTION') {
    return [
      '⚠️ نشانه‌های احتمالی اصلاح در Gate',
      'هنوز شکست ساختار به‌تنهایی تأیید خروج قطعی نیست.',
      event.caution,
    ].join('\n');
  }

  return 'وضعیت: ' + event.stage + ' | ' + event.reason;
    }
