
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSignal,
  markDelivered,
  processCandle,
} from '../src/tracking/signalTracker.js';

function signal(side = 'LONG') {
  const candidate = {
    symbol: 'TEST_USDT',
    side,
    entryLow: 100,
    entryHigh: 100,
    stopLoss: side === 'LONG' ? 95 : 105,
    takeProfits: side === 'LONG'
      ? [{ price: 110 }, { price: 120 }]
      : [{ price: 90 }, { price: 80 }],
    validUntil: '2026-01-01T00:15:00.000Z',
    triggerCandleTime: '2025-12-31T23:45:00.000Z',
    score: 80,
    setup: 'Pullback',
  };

  const s = createSignal(candidate, 'test-strategy');
  markDelivered(s, {
    confirmedAt: '2026-01-01T00:00:10.000Z',
    messageIds: [1],
  });
  return s;
}

const start = Date.parse('2026-01-01T00:01:00.000Z') / 1000;

test('tracking starts after delivery minute', () => {
  assert.equal(signal().nextMinute, start);
});

test('LONG partial target then stop: net result is computed', () => {
  const s = signal();

  processCandle(s, {
    time: start, open: 100, high: 101, low: 99, close: 100,
  });

  assert.equal(s.status, 'OPEN');

  processCandle(s, {
    time: start + 60, open: 101, high: 111, low: 100, close: 109,
  });

  assert.equal(s.remaining, 0.5);
  assert.ok(s.targetHits[0]);

  processCandle(s, {
    time: start + 120, open: 99, high: 100, low: 94, close: 96,
  });

  assert.equal(s.status, 'CLOSED');
  assert.ok(s.netPct > 0);
  assert.ok(s.netPct < 2.5);
});

test('SHORT all targets yield positive net return', () => {
  const s = signal('SHORT');

  processCandle(s, {
    time: start, open: 100, high: 101, low: 99, close: 100,
  });

  processCandle(s, {
    time: start + 60, open: 99, high: 100, low: 79, close: 82,
  });

  assert.equal(s.status, 'CLOSED');
  assert.equal(s.exitReason, 'ALL_TARGETS');
  assert.ok(s.netPct > 0);
});

test('stop and target in the same minute are ambiguous', () => {
  const s = signal();

  processCandle(s, {
    time: start, open: 100, high: 101, low: 99, close: 100,
  });

  processCandle(s, {
    time: start + 60, open: 100, high: 111, low: 94, close: 102,
  });

  assert.equal(s.status, 'AMBIGUOUS');
  assert.equal(s.netPct, null);
});

test('entry and target in same minute are ambiguous', () => {
  const s = signal();

  processCandle(s, {
    time: start, open: 108, high: 111, low: 99, close: 105,
  });

  assert.equal(s.status, 'AMBIGUOUS');
});

test('stop gap uses opening price, not a better stop fill', () => {
  const s = signal();

  processCandle(s, {
    time: start, open: 100, high: 101, low: 99, close: 100,
  });

  processCandle(s, {
    time: start + 60, open: 93, high: 96, low: 92, close: 94,
  });

  assert.equal(s.status, 'CLOSED');
  assert.equal(s.exits[0].price, 93);
  assert.ok(s.netPct < -7);
});
