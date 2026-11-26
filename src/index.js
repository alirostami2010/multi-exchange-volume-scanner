import 'dotenv/config';

import {
  scanGateMarkets,
  formatInitialAiReport,
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

const FINAL_STATUSES = ['CLOSED', 'AMBIGUOUS', 'EXPIRED_NO_ENTRY'];

function needsResultNotification(signal) {
  return (
    signal.sentAt &&
    !signal.resultNotified &&
    FINAL_STATUSES.includes(signal.status)
  );
}

async function notifyLiveRadarUpdates(state) {
  if (!telegramConfigured()) return 0;

  let liveSent = 0;

  for (const signal of Object.values(state.signals)) {
    if (!signal.pendingLiveAlerts?.length) continue;

    const remainingAlerts = [];

    for (const alert of signal.pendingLiveAlerts) {
      if (liveSent >= 12) {
        remainingAlerts.push(alert);
        continue;
      }

      try {
        const delivery = await sendTelegram(alert.text);
        if (delivery.sent) {
          liveSent++;
        } else {
          remainingAlerts.push(alert);
        }
      } catch (error) {
        console.error('[LIVE RADAR TELEGRAM]', error.message);
        remainingAlerts.push(alert);
      }
    }

    signal.pendingLiveAlerts = remainingAlerts;
    await saveSignalState(state);
  }

  return liveSent;
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

async function notifyDailyReport(state) {
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
}

function candidateIsFresh(candidate) {
  const now = Date.now();
  const checkedAt = Date.parse(candidate.priceCheckedAt);

  return (
    now < Date.parse(candidate.validUntil) &&
    Number.isFinite(checkedAt) &&
    now - checkedAt <= CONFIG.MAX_QUOTE_AGE_SECONDS * 1000
  );
}

async function main() {
  const state = await loadSignalState();

  await saveSignalState(state);
  await updateTrackedSignals(state);

  const liveRadarSent = await notifyLiveRadarUpdates(state);
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

  if (!telegramConfigured()) {
    console.warn('[TELEGRAM] Missing credentials; no issued signals registered.');
  } else if (output.success) {
    for (const candidate of output.rankedCandidates) {
      if (sentCount >= CONFIG.TOP_COUNT) break;
      if (!canRegister(state, candidate, strategy)) continue;
      if (!candidateIsFresh(candidate)) continue;

      const history = symbolHistoryLine(symbolStats(state, candidate.symbol));
      const aiReport = formatInitialAiReport(candidate);
      const signal = createSignal(candidate, strategy, CONFIG);
      state.signals[signal.id] = signal;
      await saveSignalState(state);

      try {
        const fullMessage = [
          signalMessage(candidate, signal.id, output.marketRegime),
          '━━━━━━━━━━━━━━━━━━',
          aiReport,
          '━━━━━━━━━━━━━━━━━━',
          history,
        ].join('\n');

        const delivery = await sendTelegram(fullMessage);

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

  await saveSignalState(state);

  console.log(
    '[SCANNER RESULT]',
    JSON.stringify(
      {
        ...output.stats,
        successfulMarkets: output.stats.success,
        success: output.success,
        newSignalsSent: sentCount,
        liveRadarUpdatesSent: liveRadarSent,
        trackedRecords: Object.keys(state.signals).length,
        btcForecast: output.btcIntel?.nextMoveForecast,
        filterStats: output.filterStats,
      },
      null,
      2
    )
  );

  if (!output.success) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error('[FATAL]', error?.stack ?? error);
  process.exitCode = 1;
}
