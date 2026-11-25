import 'dotenv/config';

import {
  scanGateMarkets,
  CONFIG,
  STRATEGY_VERSION,
} from './scanner/marketScanner.js';

import { saveMarketSnapshot } from './storage/marketStorage.js';

import {
  sendTelegram,
  telegramConfigured,
  signalMessage,
} from './services/telegram.js';

import {
  loadSignalState,
  saveSignalState,
  updateTrackedSignals,
  strategyKey,
  canRegister,
  createSignal,
  markDelivered,
  resultMessage,
  performanceMessages,
} from './tracking/signalTracker.js';

import {
  symbolStats,
  symbolHistoryLine,
  symbolReportMessage,
} from './tracking/symbolStats.js';

import { runWaveWatch } from './wave/waveWatch.js';
import { runWaveEntries } from './wave/waveEntries.js';

import {
  loadWaveState,
  saveWaveState,
  updateWaveTrades,
  waveResultMessage,
  waveNotification,
  wavePerformanceMessage,
} from './wave/waveTracker.js';

const FINAL_STATUSES = ['CLOSED', 'AMBIGUOUS', 'EXPIRED_NO_ENTRY'];

function needsResultNotification(signal) {
  return signal.sentAt &&
    !signal.resultNotified &&
    FINAL_STATUSES.includes(signal.status);
}

async function notifyResults(state) {
  if (!telegramConfigured()) return;

  let sent = 0;

  for (const signal of Object.values(state.signals)) {
    if (!needsResultNotification(signal) || sent >= 10) continue;

    try {
      const history = symbolHistoryLine(symbolStats(state, signal.symbol));
      const delivery = await sendTelegram(
        resultMessage(signal) + '\n━━━━━━━━━━━━━━━━━━\n' + history
      );

      if (delivery.sent) {
        signal.resultNotified = true;
        signal.resultNotifiedAt = delivery.confirmedAt;
        await saveSignalState(state);
        sent++;
      }
    } catch (error) {
      console.error('[RESULT TELEGRAM]', error.message);
      break;
    }
  }
}

async function notifyDailyReport(state, waveState) {
  if (!telegramConfigured()) return;

  const day = new Date().toISOString().slice(0, 10);

  if (state.lastDailyReportDay !== day) {
    try {
      for (const message of [
        ...performanceMessages(state),
        symbolReportMessage(state),
      ]) {
        const delivery = await sendTelegram(message);
        if (!delivery.sent) return;
      }

      state.lastDailyReportDay = day;
      await saveSignalState(state);
    } catch (error) {
      console.error('[DAILY REPORT]', error.message);
    }
  }

  if (waveState.lastReportDay !== day) {
    try {
      const delivery = await sendTelegram(
        wavePerformanceMessage(waveState)
      );

      if (delivery.sent) {
        waveState.lastReportDay = day;
        await saveWaveState(waveState);
      }
    } catch (error) {
      console.error('[WAVE REPORT]', error.message);
    }
  }
}

async function notifyWaveResults(waveState) {
  if (!telegramConfigured()) return;

  for (const trade of Object.values(waveState.trades)) {
    const text = waveNotification(trade);

    if (text) {
      try {
        const delivery = await sendTelegram(text);

        if (delivery.sent) {
          if (trade.pendingNotification?.type === 'BREAKEVEN_TRAIL') {
            trade.notifications.breakeven = true;
          }

          if (trade.pendingNotification?.type === 'CORRECTION_WATCH') {
            trade.notifications.correction =
              trade.pendingNotification.at;
          }

          trade.pendingNotification = null;
          await saveWaveState(waveState);
        }
      } catch (error) {
        console.error('[WAVE NOTIFY]', error.message);
      }
    }

    if (
      !trade.sentAt ||
      trade.resultNotified ||
      !FINAL_STATUSES.includes(trade.status)
    ) continue;

    try {
      const delivery = await sendTelegram(waveResultMessage(trade));

      if (delivery.sent) {
        trade.resultNotified = true;
        trade.resultNotifiedAt = delivery.confirmedAt;
        await saveWaveState(waveState);
      }
    } catch (error) {
      console.error('[WAVE RESULT]', error.message);
      break;
    }
  }
}

function candidateIsFresh(candidate) {
  const now = Date.now();
  const checkedAt = Date.parse(candidate.priceCheckedAt);

  return now < Date.parse(candidate.validUntil) &&
    Number.isFinite(checkedAt) &&
    now - checkedAt <= CONFIG.MAX_QUOTE_AGE_SECONDS * 1000;
}

async function main() {
  const state = await loadSignalState();
  const waveState = await loadWaveState();

  await saveSignalState(state);
  await saveWaveState(waveState);

  await updateTrackedSignals(state);
  await updateWaveTrades(waveState);
  await notifyResults(state);
  await notifyWaveResults(waveState);
  await notifyDailyReport(state, waveState);

  const output = await scanGateMarkets();

  if (output.success && output.stats.scanned > 0) {
    try {
      const stored = await saveMarketSnapshot(output.rankedCandidates);
      console.log('[STORAGE]', {
        historyCount: stored.historyCount,
        summaryCount: stored.summaryCount,
      });
    } catch (error) {
      console.error('[STORAGE]', error.message);
      process.exitCode = 1;
    }
  }

  const strategy = strategyKey(STRATEGY_VERSION, CONFIG);
  let sentCount = 0;

  if (!telegramConfigured()) {
    console.warn('[TELEGRAM] Missing credentials; no issued signals registered.');
  } else if (output.success) {
    for (const candidate of output.rankedCandidates) {
      if (sentCount >= CONFIG.TOP_COUNT) break;
      if (!canRegister(state, candidate, strategy)) continue;
      if (!candidateIsFresh(candidate)) continue;

      const history = symbolHistoryLine(symbolStats(state, candidate.symbol));
      const signal = createSignal(candidate, strategy, CONFIG);
      state.signals[signal.id] = signal;
      await saveSignalState(state);

      try {
        const delivery = await sendTelegram(
          signalMessage(candidate, signal.id, output.marketRegime) +
          '\n━━━━━━━━━━━━━━━━━━\n' + history
        );

        if (delivery.sent) {
          markDelivered(signal, delivery);
          sentCount++;
        } else {
          signal.status = 'NOT_SENT';
          signal.deliveryNote = delivery.reason;
        }
      } catch (error) {
        signal.status = 'DELIVERY_UNKNOWN';
        signal.deliveryNote = error.message;
        console.error('[SIGNAL TELEGRAM]', error.message);
      }

      await saveSignalState(state);
      if (signal.status === 'DELIVERY_UNKNOWN') break;
    }
  }

  let waveWatch = { sent: 0, reason: 'BASE_SCAN_UNAVAILABLE' };
  let waveEntry = { sent: 0, reason: 'BASE_SCAN_UNAVAILABLE' };

  if (output.success) {
    try {
      waveWatch = await runWaveWatch(state, output.marketRegime);
    } catch (error) {
      console.error('[WAVE WATCH ERROR]', error?.stack ?? error);
      waveWatch = { sent: 0, reason: 'WAVE_WATCH_ERROR' };
    }

    try {
      waveEntry = await runWaveEntries(
        waveState,
        state,
        output.marketRegime
      );
    } catch (error) {
      console.error('[WAVE ENTRY ERROR]', error?.stack ?? error);
      waveEntry = { sent: 0, reason: 'WAVE_ENTRY_ERROR' };
    }
  }

  await saveSignalState(state);
  await saveWaveState(waveState);

  console.log('[WAVE WATCH RESULT]', JSON.stringify(waveWatch));
  console.log('[WAVE ENTRY RESULT]', JSON.stringify(waveEntry));

  console.log('[SCANNER RESULT]', JSON.stringify({
    ...output.stats,
    successfulMarkets: output.stats.success,
    success: output.success,
    newSignalsSent: sentCount,
    waveWatchSent: waveWatch.sent,
    waveEntrySent: waveEntry.sent,
    trackedRecords: Object.keys(state.signals).length,
    waveTrackedRecords: Object.keys(waveState.trades).length,
    filterStats: output.filterStats,
  }, null, 2));

  if (!output.success) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('[FATAL]', error?.stack ?? error);
  process.exitCode = 1;
}
