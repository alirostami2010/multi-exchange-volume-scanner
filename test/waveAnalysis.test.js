import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWave } from '../src/wave/waveAnalysis.js';

// Builds a clean zig-zag candle series through the given turning points.
function series(points, steps = 10) {
  const candles = [];
  let time = 1700000000;

  function push(close) {
    candles.push({
      time,
      open: close,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volumeContracts: 100,
      quoteTurnover: 1000,
    });
    time += 3600;
  }

  push(points[0]);

  for (let p = 1; p < points.length; p++) {
    const from = points[p - 1];
    const to = points[p];

    for (let s = 1; s <= steps; s++) {
      push(from + (to - from) * s / steps);
    }
  }

  return candles;
}

test('uptrend pullback is detected as CORRECTION', () => {
  const result = analyzeWave(series([10, 12, 11, 13.5, 12.5, 15, 14]));

  assert.equal(result.valid, true);
  assert.equal(result.structure, 'UP');
  assert.equal(result.phase, 'CORRECTION');
  assert.ok(result.waveNumber >= 2);
  assert.ok(result.correction.depth > 0.35);
  assert.ok(result.correction.depth < 0.5);
  assert.equal(result.correction.structureIntact, true);
});

test('downtrend bounce is detected as CORRECTION', () => {
  const result = analyzeWave(series([20, 18, 19, 16.5, 17.5, 15, 16]));

  assert.equal(result.valid, true);
  assert.equal(result.structure, 'DOWN');
  assert.equal(result.phase, 'CORRECTION');
});

test('oversized late impulse is flagged as late', () => {
  const result = analyzeWave(series([10, 12, 11, 13, 12, 14, 13, 20]));

  assert.equal(result.structure, 'UP');
  assert.equal(result.phase, 'IMPULSE');
  assert.equal(result.late, true);
  assert.ok(result.lateReasons.includes('WAVE_LARGER_THAN_TYPICAL'));
});

test('too few candles are rejected', () => {
  const result = analyzeWave(series([10, 12, 11]));

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'INSUFFICIENT_CANDLES');
});
