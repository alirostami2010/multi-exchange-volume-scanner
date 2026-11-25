import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessWaveSetup,
  assessWaveExit,
  scanWaveSetup,
  formatWaveEvent,
} from '../src/wave/waveRider.js';

const BASE = 1_800_000_000;

function candles15({
  side = 'LONG',
  breakPrice = true,
  volume = 2000,
} = {}) {
  const candles = [];

  for (let index = 0; index < 40; index++) {
    candles.push({
      time: BASE + index * 900,
      open: 100,
      high: 100.2,
      low: 99.8,
      close: 100,
      quoteTurnover: 1000,
      volumeContracts: 10,
    });
  }

  let last;

  if (side === 'LONG') {
    last = {
      time: BASE + 40 * 900,
      open: 100,
      high: breakPrice ? 100.55 : 100.2,
      low: 99.9,
      close: breakPrice ? 100.4 : 100.1,
      quoteTurnover: volume,
      volumeContracts: 20,
    };
  } else {
    last = {
      time: BASE + 40 * 900,
      open: 100,
      high: 100.1,
      low: breakPrice ? 99.45 : 99.8,
      close: breakPrice ? 99.6 : 99.9,
      quoteTurnover: volume,
      volumeContracts: 20,
    };
  }

  candles.push(last);
  return candles;
}

function wave(side = 'LONG') {
  return {
    valid: true,
    structure: side === 'LONG' ? 'UP' : 'DOWN',
    phase: 'CORRECTION',
    waveNumber: 2,
    correction: {
      depth: 0.45,
      depthHealthy: true,
      structureIntact: true,
      volumeContracting: true,
      macdFading: true,
      fromPrice: side === 'LONG' ? 103 : 97,
      extreme: side === 'LONG' ? 99.4 : 100.6,
    },
  };
}

function evaluate(side = 'LONG', options = {}) {
  const data = candles15({ side, ...options });

  return assessWaveSetup({
    symbol: 'TEST_USDT',
    side,
    wave: wave(side),
    candles15m: data,
    asOf: data.at(-1).time + 900,
  });
}

test('correction without a base break remains WATCH', () => {
  const result = evaluate('LONG', {
    breakPrice: false,
  });

  assert.equal(result.stage, 'WATCH');
  assert.equal(result.reason, 'WAITING_FOR_BASE_BREAK');
});

test('confirmed LONG break creates one historical target', () => {
  const result = evaluate('LONG');

  assert.equal(result.stage, 'ENTRY');
  assert.equal(result.side, 'LONG');
  assert.equal(result.priorExtremeTarget, 103);
  assert.ok(result.stopLoss < result.entryLow);
  assert.ok(result.netRRToPriorExtreme >= 1.5);
});

test('confirmed SHORT break creates one historical target', () => {
  const result = evaluate('SHORT');

  assert.equal(result.stage, 'ENTRY');
  assert.equal(result.side, 'SHORT');
  assert.equal(result.priorExtremeTarget, 97);
  assert.ok(result.stopLoss > result.entryHigh);
  assert.ok(result.netRRToPriorExtreme >= 1.5);
});

test('breakout without volume remains WATCH, not ENTRY', () => {
  const result = evaluate('LONG', {
    volume: 1000,
  });

  assert.equal(result.stage, 'WATCH');
  assert.equal(
    result.reason,
    'BREAKOUT_WITHOUT_VOLUME_CONFIRMATION'
  );
});

test('stale 15m data cannot produce an entry', () => {
  const data = candles15();

  const result = assessWaveSetup({
    symbol: 'TEST_USDT',
    side: 'LONG',
    wave: wave(),
    candles15m: data,
    asOf: data.at(-1).time + 1800,
  });

  assert.equal(result.stage, 'NO_DATA');
});

test('live wrapper refuses missing 1H history', () => {
  const data = candles15();

  const result = scanWaveSetup({
    symbol: 'TEST_USDT',
    side: 'LONG',
    candles1h: [],
    candles15m: data,
    asOf: data.at(-1).time + 900,
  });

  assert.equal(result.stage, 'NO_DATA');
});

test('previous reference stop touch requests exit review', () => {
  const data = candles15();
  const last = data.at(-1);

  last.open = 100;
  last.high = 100.2;
  last.low = 99.6;
  last.close = 99.9;

  const result = assessWaveExit({
    position: {
      side: 'LONG',
      entry: 100,
      initialStop: 98,
      trailingStop: 99.7,
      entryTime: BASE + 10 * 900,
    },
    candles15m: data,
    asOf: last.time + 900,
  });

  assert.equal(result.stage, 'EXIT_REVIEW');
  assert.equal(
    result.reason,
    'GATE_REFERENCE_STOP_TOUCHED'
  );
  assert.equal(result.nextReferenceStop, 99.7);
});

test('one small adverse move is not an automatic exit', () => {
  const data = candles15({
    breakPrice: false,
  });

  const result = assessWaveExit({
    position: {
      side: 'LONG',
      entry: 100,
      initialStop: 98,
      trailingStop: 98,
      entryTime: BASE + 10 * 900,
    },
    candles15m: data,
    asOf: data.at(-1).time + 900,
  });

  assert.notEqual(result.stage, 'EXIT_REVIEW');
});

test('WATCH message explicitly says entry is not ready', () => {
  const message = formatWaveEvent(
    evaluate('LONG', {
      breakPrice: false,
    })
  );

  assert.match(message, /هنوز ورود نیست/);
});
