import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eligibleWaveWatch,
  selectWaveWatchEvents,
  waveWatchKey,
} from '../src/wave/waveWatch.js';

const NOW = Date.parse(
  '2026-11-25T12:00:00.000Z'
);

function event(
  symbol = 'TEST_USDT',
  side = 'LONG',
  overrides = {}
) {
  const longSide = side === 'LONG';

  return {
    stage: 'WATCH',
    reason: 'WAITING_FOR_BASE_BREAK',
    symbol,
    side,

    observedAt:
      new Date(NOW).toISOString(),

    baseLow: longSide ? 99 : 100,
    baseHigh: longSide ? 100 : 101,

    triggerLevel: 100,
    currentPrice: longSide ? 99.5 : 100.5,
    priorExtreme: longSide ? 105 : 95,

    correctionDepthPct: 45,
    correctionVolumeContracting: true,
    correctionMacdFading: true,

    quoteVolume24h: 2_000_000,

    ...overrides,
  };
}

function state() {
  return {
    signals: {},
    waveWatches: {},
    waveWatchDaily: {
      day: '2026-11-25',
      attempts: 0,
    },
  };
}

test('WATCH is informational; ENTRY is not included', () => {
  const input = event(
    'FIRST_USDT',
    'LONG'
  );

  assert.equal(
    eligibleWaveWatch(input, NOW),
    true
  );

  assert.equal(
    eligibleWaveWatch({
      ...input,
      stage: 'ENTRY',
    }, NOW),
    false
  );
});

test('only a waiting setup near its trigger is selected', () => {
  const first = event('FIRST_USDT');

  const tooFar = event(
    'FAR_USDT',
    'LONG',
    { currentPrice: 95 }
  );

  const alreadyBroken = event(
    'BROKEN_USDT',
    'LONG',
    { currentPrice: 101 }
  );

  const selected = selectWaveWatchEvents(
    [first, tooFar, alreadyBroken],
    state(),
    NOW
  );

  assert.deepEqual(
    selected.map(item => item.symbol),
    ['FIRST_USDT']
  );
});

test('previously sent watch respects cooldown', () => {
  const data = state();
  const first = event();

  data.waveWatches[waveWatchKey(first)] = {
    status: 'SENT',
    lastAttemptAt: new Date(
      NOW - 60 * 60 * 1000
    ).toISOString(),
  };

  const selected = selectWaveWatchEvents(
    [first],
    data,
    NOW
  );

  assert.equal(selected.length, 0);
});

test('daily limit is shared between LONG and SHORT', () => {
  const data = state();

  data.waveWatchDaily.attempts = 9;

  const selected = selectWaveWatchEvents(
    [
      event('LONG_USDT', 'LONG'),
      event('SHORT_USDT', 'SHORT'),
    ],
    data,
    NOW
  );

  assert.equal(selected.length, 1);
});

test('a tracked active position suppresses watch spam', () => {
  const data = state();

  data.signals.open = {
    symbol: 'TEST_USDT',
    side: 'SHORT',
    status: 'OPEN',
  };

  const selected = selectWaveWatchEvents(
    [event('TEST_USDT', 'LONG')],
    data,
    NOW
  );

  assert.equal(selected.length, 0);
});

test('stale WATCH is not selected', () => {
  const stale = event(
    'STALE_USDT',
    'LONG',
    {
      observedAt: new Date(
        NOW - 4 * 60 * 1000
      ).toISOString(),
    }
  );

  const selected = selectWaveWatchEvents(
    [stale],
    state(),
    NOW
  );

  assert.equal(selected.length, 0);
});
