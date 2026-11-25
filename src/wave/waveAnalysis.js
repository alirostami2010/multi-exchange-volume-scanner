// File: src/wave/waveAnalysis.js
// Wave Rider v1 — market structure analysis.
// Detects swings, trend structure, impulse/correction phase,
// wave number, correction depth and wave maturity ("is it late?").
// Heuristic analysis only. It does not predict outcomes.

// ==================== Helpers ====================

function median(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;

  const sorted = [...clean].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function volumeOf(candle) {
  if (Number.isFinite(candle.quoteTurnover) && candle.quoteTurnover >= 0) {
    return candle.quoteTurnover;
  }

  if (Number.isFinite(candle.volumeContracts) && candle.volumeContracts >= 0) {
    return candle.volumeContracts;
  }

  return null;
}

// ==================== Indicators ====================

export function ema(values, period) {
  if (values.length === 0) return [];

  const alpha = 2 / (period + 1);
  const output = [];
  let previous = values[0];

  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      previous = alpha * values[i] + (1 - alpha) * previous;
    }
    output.push(previous);
  }

  return output;
}

export function atrSeries(candles, period = 14) {
  const output = new Array(candles.length).fill(null);
  if (candles.length < period) return output;

  const ranges = candles.map((candle, index) => {
    const previous = candles[index - 1];
    if (!previous) return candle.high - candle.low;

    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previous.close),
      Math.abs(candle.low - previous.close)
    );
  });

  let current = mean(ranges.slice(0, period));
  output[period - 1] = current;

  for (let i = period; i < ranges.length; i++) {
    current = (current * (period - 1) + ranges[i]) / period;
    output[i] = current;
  }

  return output;
}

export function bollinger(closes, period = 20, multiplier = 2) {
  const mid = new Array(closes.length).fill(null);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const widthPct = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const average = mean(window);

    const variance = window.reduce(
      (sum, value) => sum + (value - average) ** 2,
      0
    ) / period;

    const deviation = Math.sqrt(variance);

    mid[i] = average;
    upper[i] = average + multiplier * deviation;
    lower[i] = average - multiplier * deviation;

    widthPct[i] = average > 0
      ? (upper[i] - lower[i]) / average * 100
      : null;
  }

  return { mid, upper, lower, widthPct };
}

export function macdHistogram(closes) {
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const line = closes.map((value, index) => fast[index] - slow[index]);
  const signal = ema(line, 9);

  return line.map((value, index) => value - signal[index]);
}

// ==================== Swings ====================

export function findSwings(candles, left = 3, right = 3) {
  const raw = [];

  for (let i = left; i < candles.length - right; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= left; j++) {
      if (candles[i - j].high >= current.high) isHigh = false;
      if (candles[i - j].low <= current.low) isLow = false;
    }

    for (let j = 1; j <= right; j++) {
      if (candles[i + j].high > current.high) isHigh = false;
      if (candles[i + j].low < current.low) isLow = false;
    }

    if (isHigh) {
      raw.push({
        type: 'HIGH',
        index: i,
        time: current.time,
        price: current.high,
      });
    }

    if (isLow) {
      raw.push({
        type: 'LOW',
        index: i,
        time: current.time,
        price: current.low,
      });
    }
  }

  // Force alternation HIGH / LOW; keep the more extreme duplicate.
  const swings = [];

  for (const swing of raw) {
    const last = swings.at(-1);

    if (!last) {
      swings.push(swing);
      continue;
    }

    if (last.type !== swing.type) {
      swings.push(swing);
      continue;
    }

    const moreExtreme = swing.type === 'HIGH'
      ? swing.price > last.price
      : swing.price < last.price;

    if (moreExtreme) {
      swings[swings.length - 1] = swing;
    }
  }

  return swings;
}

export function classifyStructure(swings) {
  const highs = swings.filter(swing => swing.type === 'HIGH');
  const lows = swings.filter(swing => swing.type === 'LOW');

  if (highs.length < 2) return 'UNKNOWN';
  if (lows.length < 2) return 'UNKNOWN';

  const previousHigh = highs.at(-2).price;
  const lastHigh = highs.at(-1).price;
  const previousLow = lows.at(-2).price;
  const lastLow = lows.at(-1).price;

  if (lastHigh > previousHigh && lastLow > previousLow) return 'UP';
  if (lastHigh < previousHigh && lastLow < previousLow) return 'DOWN';

  return 'RANGE';
}

export function buildLegs(swings) {
  const legs = [];

  for (let i = 1; i < swings.length; i++) {
    const from = swings[i - 1];
    const to = swings[i];

    legs.push({
      from,
      to,
      direction: to.price > from.price ? 'UP' : 'DOWN',
      size: Math.abs(to.price - from.price),
      bars: to.index - from.index,
    });
  }

  return legs;
}

function trendWaveNumber(swings, up) {
  const type = up ? 'HIGH' : 'LOW';
  const points = swings.filter(swing => swing.type === type);

  let count = 0;

  for (let i = points.length - 1; i > 0; i--) {
    const beyond = up
      ? points[i].price > points[i - 1].price
      : points[i].price < points[i - 1].price;

    if (!beyond) break;
    count++;
  }

  // Number of impulse waves in the current consecutive trend.
  return count + 1;
}

function percentileRank(values, current) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  if (!Number.isFinite(current)) return null;

  const below = clean.filter(value => value <= current).length;
  return below / clean.length * 100;
}

// ==================== Main analysis ====================

export function analyzeWave(candles, options = {}) {
  const left = options.left ?? 3;
  const right = options.right ?? 3;
  const minimum = options.minCandles ?? 60;

  if (!Array.isArray(candles)) {
    return { valid: false, reason: 'NO_CANDLES' };
  }

  if (candles.length < minimum) {
    return { valid: false, reason: 'INSUFFICIENT_CANDLES' };
  }

  const closes = candles.map(candle => candle.close);
  const atr = atrSeries(candles).at(-1);

  if (!(atr > 0)) {
    return { valid: false, reason: 'BAD_ATR' };
  }

  const bands = bollinger(closes);
  const histogram = macdHistogram(closes);
  const swings = findSwings(candles, left, right);
  const structure = classifyStructure(swings);
  const legs = buildLegs(swings);

  const last = candles.at(-1);
  const price = last.close;

  const bbMid = bands.mid.at(-1);
  const bbUpper = bands.upper.at(-1);
  const bbLower = bands.lower.at(-1);
  const bbWidth = bands.widthPct.at(-1);

  const result = {
    valid: true,
    structure,
    phase: 'UNKNOWN',
    price,
    atr,
    waveNumber: 0,
    swings: swings.slice(-8),

    bollinger: {
      mid: bbMid,
      upper: bbUpper,
      lower: bbLower,
      widthPct: bbWidth,
      widthRank: percentileRank(bands.widthPct.slice(-120), bbWidth),
    },

    macdHist: histogram.at(-1),
    impulse: null,
    correction: null,
    range: null,
    late: false,
    lateReasons: [],
  };

  if (structure !== 'UP' && structure !== 'DOWN') {
    result.phase = structure === 'RANGE' ? 'RANGE' : 'UNKNOWN';

    const highs = swings.filter(swing => swing.type === 'HIGH').slice(-2);
    const lows = swings.filter(swing => swing.type === 'LOW').slice(-2);

    if (highs.length > 0 && lows.length > 0) {
      result.range = {
        top: Math.max(...highs.map(swing => swing.price)),
        bottom: Math.min(...lows.map(swing => swing.price)),
      };
    }

    return result;
  }

  const up = structure === 'UP';
  const endType = up ? 'HIGH' : 'LOW';
  const startType = up ? 'LOW' : 'HIGH';
  const impulseDirection = up ? 'UP' : 'DOWN';

  const beyond = (a, b) => (up ? a > b : a < b);
  const favorable = candle => (up ? candle.high : candle.low);
  const adverse = candle => (up ? candle.low : candle.high);

  function previousSwing(type, beforeIndex) {
    for (let i = swings.length - 1; i >= 0; i--) {
      if (swings[i].type === type && swings[i].index < beforeIndex) {
        return swings[i];
      }
    }
    return null;
  }

  result.waveNumber = trendWaveNumber(swings, up);

  // Typical behavior of THIS coin, learned from its recent legs.
  const impulseLegs = legs.filter(leg => leg.direction === impulseDirection);
  const typicalImpulse = median(impulseLegs.slice(-6).map(leg => leg.size));

  const depths = [];

  for (let i = 1; i < legs.length; i++) {
    const previous = legs[i - 1];
    const current = legs[i];

    if (
      previous.direction === impulseDirection &&
      current.direction !== impulseDirection &&
      previous.size > 0
    ) {
      depths.push(current.size / previous.size);
    }
  }

  const typicalDepth = median(depths.slice(-6));
  const lastSwing = swings.at(-1);

  let impulseStart = null;

  if (lastSwing.type === endType && !beyond(price, lastSwing.price)) {
    // Price is pulling back from the last confirmed impulse extreme.
    result.phase = 'CORRECTION';

    const start = previousSwing(startType, lastSwing.index);
    const after = candles.slice(lastSwing.index + 1);

    if (start && after.length > 0) {
      const extreme = up
        ? Math.min(...after.map(adverse))
        : Math.max(...after.map(adverse));

      const impulseSize = Math.abs(lastSwing.price - start.price);
      const depth = impulseSize > 0
        ? Math.abs(lastSwing.price - extreme) / impulseSize
        : null;

      const impulseCandles = candles.slice(start.index, lastSwing.index + 1);

      const impulseVolume = mean(impulseCandles.map(volumeOf));
      const correctionVolume = mean(after.map(volumeOf));

      const correctionHist = histogram.slice(lastSwing.index + 1);

      const againstTrend = correctionHist.filter(value =>
        up ? value < 0 : value > 0
      );

      const peakAgainst = againstTrend.length > 0
        ? Math.max(...againstTrend.map(Math.abs))
        : 0;

      const lastHist = histogram.at(-1);
      const histWithTrend = up ? lastHist > 0 : lastHist < 0;

      const macdFading =
        peakAgainst > 0 &&
        (histWithTrend || Math.abs(lastHist) < peakAgainst * 0.5);

      result.correction = {
        fromPrice: lastSwing.price,
        impulseStartPrice: start.price,
        extreme,
        depth,
        typicalDepth,
        bars: after.length,

        structureIntact: beyond(extreme, start.price),

        volumeContracting:
          Number.isFinite(impulseVolume) &&
          Number.isFinite(correctionVolume) &&
          correctionVolume < impulseVolume,

        volumeRatio:
          impulseVolume > 0 && Number.isFinite(correctionVolume)
            ? correctionVolume / impulseVolume
            : null,

        macdFading,

        nearBollingerMid:
          Number.isFinite(bbMid) &&
          Math.abs(extreme - bbMid) <= atr,

        depthHealthy:
          Number.isFinite(depth) &&
          depth >= 0.236 &&
          depth <= 0.786,
      };
    }
  } else {
    result.phase = 'IMPULSE';

    if (lastSwing.type === endType) {
      // Price already exceeded the last confirmed extreme.
      impulseStart = previousSwing(startType, lastSwing.index);
    } else {
      impulseStart = lastSwing;
    }
  }

  if (result.phase === 'IMPULSE' && impulseStart) {
    const since = candles.slice(impulseStart.index);

    const extreme = up
      ? Math.max(...since.map(favorable))
      : Math.min(...since.map(favorable));

    const size = Math.abs(extreme - impulseStart.price);

    const maturityRatio = typicalImpulse > 0
      ? size / typicalImpulse
      : null;

    const stretched = up
      ? Number.isFinite(bbUpper) && price > bbUpper
      : Number.isFinite(bbLower) && price < bbLower;

    result.impulse = {
      startPrice: impulseStart.price,
      extreme,
      size,
      sizeATR: size / atr,
      typicalSize: typicalImpulse,
      maturityRatio,
      bars: candles.length - 1 - impulseStart.index,
      stretchedOutsideBollinger: stretched,
    };

    if (result.waveNumber >= 4) {
      result.lateReasons.push('WAVE_4_OR_LATER');
    }

    if (Number.isFinite(maturityRatio) && maturityRatio > 1.3) {
      result.lateReasons.push('WAVE_LARGER_THAN_TYPICAL');
    }

    if (stretched) {
      result.lateReasons.push('PRICE_OUTSIDE_BOLLINGER');
    }

    result.late = result.lateReasons.length > 0;
  }

  return result;
  }
