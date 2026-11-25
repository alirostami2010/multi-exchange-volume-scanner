import test from 'node:test';
import assert from 'node:assert/strict';

import { selectWaveEntries } from '../src/wave/waveEntries.js';
import {
  applyWaveMinute,
  applyStructureReview,
  createWaveTrade,
  wavePerformanceMessage,
} from '../src/wave/waveTracker.js';

const NOW = Date.parse('2026-11-25T16:00:00.000Z');

function entry(symbol = 'TEST_USDT', side = 'LONG') {
  const longSide = side === 'LONG';

  return {
    stage: 'ENTRY',
    version: 'wave-test',
    symbol,
    side,
    observedAt: new Date(NOW).toISOString(),
    validUntil: new Date(NOW + 10 * 60 * 1000).toISOString(),
    triggerCandleTime: new Date(NOW - 15 * 60 * 1000).toISOString(),
    entryLow: 99.8,
    entryHigh: 100.2,
    conservativeEntry: longSide ? 100.2 : 99.8,
    stopLoss: longSide ? 99 : 101,
    priorExtremeTarget: longSide ? 104 : 96,
    netRRToPriorExtreme: 2,
    currentPrice: 100,
    waveNumberHeuristic: 2,
    correctionDepthPct: 42,
  };
}

function state() {
  return {
    trades: {},
    attempts: {},
    daily: { day: '2026-11-25', attempts: 0 },
  };
}

test('WATCH cannot become an experimental entry', () => {
  const selected = selectWaveEntries(
    [{ ...entry(), stage: 'WATCH' }],
    state(),
    { signals: {} },
    NOW
  );

  assert.equal(selected.length, 0);
});

test('LONG is preferred and open main position blocks symbol', () => {
  const selected = selectWaveEntries(
    [entry('AAA_USDT', 'SHORT'), entry('BBB_USDT', 'LONG')],
    state(),
    {
      signals: {
        one: { symbol: 'BBB_USDT', status: 'OPEN' },
      },
    },
    NOW
  );

  assert.deepEqual(
    selected.map(item => item.symbol),
    ['AAA_USDT']
  );
});

test('stop is checked before a later structure review', () => {
  const trade = createWaveTrade(entry());
  trade.status = 'OPEN';
  trade.entryTime = new Date(NOW).toISOString();
  trade.activeStop = 99;

  applyWaveMinute(trade, {
    time: NOW / 1000,
    open: 100,
    high: 100.2,
    low: 98.9,
    close: 99.4,
  });

  assert.equal(trade.status, 'CLOSED');
  assert.equal(trade.exitReason, 'STOP');

  applyStructureReview(
    trade,
    { stage: 'HOLD', nextReferenceStop: 99.5 },
    100,
    NOW / 1000 + 60
  );

  assert.equal(trade.activeStop, 99);
  assert.equal(trade.exitReason, 'STOP');
});

test('trail applies only after structure review', () => {
  const trade = createWaveTrade(entry());
  trade.status = 'OPEN';
  trade.activeStop = 99;

  applyStructureReview(
    trade,
    {
      stage: 'HOLD',
      nextReferenceStop: 99.4,
      observedAt: new Date(NOW).toISOString(),
    },
    100.5,
    NOW / 1000
  );

  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.activeStop, 99.4);
});

test('wave report is explicitly separate', () => {
  const message = wavePerformanceMessage(state());
  assert.match(message, /جدا از آمار اسکنر اصلی/);
});
