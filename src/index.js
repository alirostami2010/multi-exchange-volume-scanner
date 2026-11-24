
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

async function notifyResults(state) {
  if (!telegramConfigured()) return;

  let sent = 0;

  for (const signal of Object.values(state.signals)) {
    if (
      !signal.sentAt ||
      signal.resultNotified ||
      !['CLOSED', 'AMBIGUOUS', 'EXPIRED_NO_ENTRY'].includes(signal.status)
    ) continue;

    // Bound notifications per run. Remaining results wait for later runs.
    if (sent >= 10) break;

    try {
      const delivery = await sendTelegram(resultMessage(signal));

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

async function notifyDailyReport(state) {
  if (!telegramConfigured()) return;

  const day = new Date().toISOString().slice(0, 10);
  if (state.lastDailyReportDay === day) return;

  try {
    for (const message of performanceMessages(state)) {
      const delivery = await sendTelegram(message);
      if (!delivery.sent) return;
    }

    state.lastDailyReportDay = day;
    await saveSignalState(state);
  } catch (error) {
    console.error('[DAILY REPORT]', error.message);
  }
}

async function main() {
  const state = await loadSignalState();
  await saveSignalState(state);

  // Existing signals are tracked even if a later market scan fails.
  await updateTrackedSignals(state);
  await notifyResults(state);
  await notifyDailyReport(state);

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

  if (output.success && telegramConfigured()) {
    for (const candidate of output.rankedCandidates) {
      if (sentCount >= CONFIG.TOP_COUNT) break;
      if (!canRegister(state, candidate, strategy)) continue;

      const now = Date.now();

      if (
        now >= Date.parse(candidate.validUntil) ||
        now - Date.parse(candidate.priceCheckedAt) >
          CONFIG.MAX_QUOTE_AGE_SECONDS * 1000
      ) continue;

      const signal = createSignal(candidate, strategy, CONFIG);
      state.signals[signal.id] = signal;

      // Local durable intent before external notification.
      await saveSignalState(state);

try {
        const delivery = await sendTelegram(
          signalMessage(candidate, signal.id, output.marketRegime)
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
  } else if (!telegramConfigured()) {
    console.warn('[TELEGRAM] Missing credentials; no issued signals registered.');
  }

  await saveSignalState(state);

  console.log('[SCANNER RESULT]', JSON.stringify({
    success: output.success,
    ...output.stats,
    newSignalsSent: sentCount,
    trackedRecords: Object.keys(state.signals).length,
    filterStats: output.filterStats,
  }, null, 2));

  if (!output.success) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('[FATAL]', error?.stack || error);
  process.exitCode = 1;
}
