import 'dotenv/config';

import {
  scanGateMarkets,
  CONFIG,
  STRATEGY_VERSION,
} from './scanner/marketScanner.js';

import {
  saveMarketSnapshot,
} from './storage/marketStorage.js';

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

import {
  runWaveWatch,
} from './wave/waveWatch.js';

const FINAL_STATUSES = [
  'CLOSED',
  'AMBIGUOUS',
  'EXPIRED_NO_ENTRY',
];

function needsResultNotification(signal) {
  if (!signal.sentAt) return false;
  if (signal.resultNotified) return false;

  return FINAL_STATUSES.includes(signal.status);
}

async function notifyResults(state) {
  if (!telegramConfigured()) return;

  let sent = 0;

  for (const signal of Object.values(state.signals)) {
    if (!needsResultNotification(signal)) continue;
    if (sent >= 10) break;

    try {
      const history = symbolHistoryLine(
        symbolStats(state, signal.symbol)
      );

      const delivery = await sendTelegram(
        resultMessage(signal) +
        '\n━━━━━━━━━━━━━━━━━━\n' +
        history
      );

      if (delivery.sent) {
        signal.resultNotified = true;
        signal.resultNotifiedAt =
          delivery.confirmedAt;

        await saveSignalState(state);
        sent++;
      }
    } catch (error) {
      console.error(
        '[RESULT TELEGRAM]',
        error.message
      );

      break;
    }
  }
}

async function notifyDailyReport(state) {
  if (!telegramConfigured()) return;

  const day = new Date()
    .toISOString()
    .slice(0, 10);

  if (state.lastDailyReportDay === day) {
    return;
  }

  try {
    const messages = [
      ...performanceMessages(state),
      symbolReportMessage(state),
    ];

    for (const message of messages) {
      const delivery = await sendTelegram(message);

      if (!delivery.sent) return;
    }

    state.lastDailyReportDay = day;
    await saveSignalState(state);
  } catch (error) {
    console.error(
      '[DAILY REPORT]',
      error.message
    );
  }
}

function candidateIsFresh(candidate) {
  const now = Date.now();

  if (
    now >= Date.parse(candidate.validUntil)
  ) {
    return false;
  }

  const checkedAt =
    Date.parse(candidate.priceCheckedAt);

  if (!Number.isFinite(checkedAt)) {
    return false;
  }

  return now - checkedAt <=
    CONFIG.MAX_QUOTE_AGE_SECONDS * 1000;
}

async function main() {
  const state = await loadSignalState();
  await saveSignalState(state);

  // Previously delivered paper signals remain tracked.
  await updateTrackedSignals(state);
  await notifyResults(state);
  await notifyDailyReport(state);

  const output = await scanGateMarkets();

  if (
    output.success &&
    output.stats.scanned > 0
  ) {
    try {
      const stored = await saveMarketSnapshot(
        output.rankedCandidates
      );

      console.log('[STORAGE]', {
        historyCount: stored.historyCount,
        summaryCount: stored.summaryCount,
      });
    } catch (error) {
      console.error(
        '[STORAGE]',
        error.message
      );

      process.exitCode = 1;
    }
  }

  const strategy = strategyKey(
    STRATEGY_VERSION,
    CONFIG
  );

  let sentCount = 0;

  if (!telegramConfigured()) {
    console.warn(
      '[TELEGRAM] Missing credentials; ' +
      'no issued signals registered.'
    );
  } else if (output.success) {
    for (const candidate of output.rankedCandidates) {
      if (sentCount >= CONFIG.TOP_COUNT) {
        break;
      }

      if (!canRegister(
        state,
        candidate,
        strategy
      )) {
        continue;
      }

      if (!candidateIsFresh(candidate)) {
        continue;
      }

      const history = symbolHistoryLine(
        symbolStats(state, candidate.symbol)
      );

      const signal = createSignal(
        candidate,
        strategy,
        CONFIG
      );

      state.signals[signal.id] = signal;

      // Save local intent before contacting Telegram.
      await saveSignalState(state);

      try {
        const message =
          signalMessage(
            candidate,
            signal.id,
            output.marketRegime
          ) +
          '\n━━━━━━━━━━━━━━━━━━\n' +
          history;

        const delivery = await sendTelegram(message);

        if (delivery.sent) {
          markDelivered(signal, delivery);
          sentCount++;
        } else {
          signal.status = 'NOT_SENT';
          signal.deliveryNote =
            delivery.reason;
        }
      } catch (error) {
        signal.status = 'DELIVERY_UNKNOWN';
        signal.deliveryNote = error.message;

        console.error(
          '[SIGNAL TELEGRAM]',
          error.message
        );
      }

      await saveSignalState(state);

      if (
        signal.status === 'DELIVERY_UNKNOWN'
      ) {
        break;
      }
    }
  }

  // Experimental WATCH messages are informational.
  // They never enter state.signals or paper performance.
  let waveWatch = {
    scanned: 0,
    found: 0,
    sent: 0,
    reason: 'BASE_SCAN_UNAVAILABLE',
  };

  if (output.success) {
    try {
      waveWatch = await runWaveWatch(
        state,
        output.marketRegime
      );
    } catch (error) {
      console.error(
        '[WAVE WATCH ERROR]',
        error?.stack ?? error
      );

      waveWatch = {
        scanned: 0,
        found: 0,
        sent: 0,
        reason: 'WAVE_WATCH_ERROR',
      };
    }
  }

  await saveSignalState(state);

  console.log(
    '[WAVE WATCH RESULT]',
    JSON.stringify(waveWatch)
  );

  console.log(
    '[SCANNER RESULT]',
    JSON.stringify({
      ...output.stats,
      successfulMarkets: output.stats.success,
      success: output.success,

      newSignalsSent: sentCount,
      waveWatchSent: waveWatch.sent,

      trackedRecords:
        Object.keys(state.signals).length,

      filterStats: output.filterStats,
    }, null, 2)
  );

  if (!output.success) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(
    '[FATAL]',
    error?.stack ?? error
  );

  process.exitCode = 1;
}
