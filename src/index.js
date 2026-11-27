import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

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

const FINAL_STATUSES = ['CLOSED', 'AMBIGUOUS', 'EXPIRED_NO_ENTRY'];
const DASHBOARD_FILE = path.resolve(process.cwd(), 'data', 'latest-scan.json');

function needsResultNotification(signal) {
  return (
    signal.sentAt &&
    !signal.resultNotified &&
    FINAL_STATUSES.includes(signal.status)
  );
}

function buildCompactAiCapsule(candidate) {
  const ai = candidate.liveInsight;
  const hb = candidate.historyBehavior;
  const btc = candidate.btcIntel;
  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.join(' • ')
    : 'تأیید ساختار';

  const candleMode = candidate.isIntrabar
    ? '⚡ شکار زنده در کندل جاری (' + candidate.intrabarProgressPct + '%)'
    : '🔒 کلوز کندل ۱۵ دقیقه';

  const lines = [
    '🧠 رادار هوشمند (' + candleMode + ' | اطمینان: ' + (ai?.confidencePct ?? 80) + '%):',
    '• چرایی ورود: ' + reasons,
    '• فاز و کلک بازارگردان: ' + (ai?.manipulationStatus ?? 'در حال رصد'),
    '• ظرفیت هدف: ' + (ai?.targetProjection ?? 'مسیر باز تا اهداف'),
    '• پیش‌بینی BTC (' + (btc?.regimeFa ?? '—') + '): ' + (btc?.nextMoveForecast ?? '—'),
    '• رفتار تاریخی ارز: مقاومت در ریزش ' +
      (hb?.resiliencePct ?? 50) +
      '% | شتاب در صعود ' +
      (hb?.beta ?? 1) +
      'x | ' +
      (hb?.whenBtcNeutral ?? ''),
  ];

  if (candidate.riskNote) {
    lines.push('⚠️ ' + candidate.riskNote);
  }

  return lines.join('\n');
}

async function notifyLiveRadarUpdates(state) {
  if (!telegramConfigured()) return 0;

  let liveSent = 0;

  for (const signal of Object.values(state.signals)) {
    if (!signal.pendingLiveAlerts?.length) continue;

    const remainingAlerts = [];
    const replyId = signal.messageIds?.[0] ?? null;

    for (const alert of signal.pendingLiveAlerts) {
      try {
        const delivery = await sendTelegram(alert.text, replyId);
        if (delivery.sent) {
          liveSent++;
          signal.alertHistory ??= [];
          signal.alertHistory.push({
            key: alert.key,
            text: alert.text,
            time: new Date().toISOString(),
          });
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

  for (const signal of Object.values(state.signals)) {
    if (!needsResultNotification(signal)) continue;

    if (signal.status === 'EXPIRED_NO_ENTRY') {
      signal.resultNotified = true;
      signal.resultNotifiedAt = new Date().toISOString();
      await saveSignalState(state);
      continue;
    }

    try {
      const replyId = signal.messageIds?.[0] ?? null;
      const history = symbolHistoryLine(symbolStats(state, signal.symbol));
      const delivery = await sendTelegram(
        resultMessage(signal) + '\n━━━━━━━━━━━━━━━━━━\n' + history,
        replyId
      );

      if (delivery.sent) {
        signal.resultNotified = true;
        signal.resultNotifiedAt = delivery.confirmedAt;
        await saveSignalState(state);
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

// ذخیره اطلاعات کامل رادار و اسکن برای نمایش در داشبورد وب رایگان
async function saveDashboardData(output, state, sentCount, liveRadarSent) {
  try {
    await fs.mkdir(path.dirname(DASHBOARD_FILE), { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      strategyVersion: STRATEGY_VERSION,
      marketRegime: output.marketRegime,
      btcIntel: output.btcIntel ?? null,
      stats: {
        ...output.stats,
        newSignalsSent: sentCount,
        liveRadarUpdatesSent: liveRadarSent,
        trackedRecords: Object.keys(state.signals).length,
      },
      rankedCandidates: output.rankedCandidates ?? [],
      nearMisses: output.nearMisses ?? [],
      filterStats: output.filterStats ?? {},
    };
    await fs.writeFile(DASHBOARD_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('[DASHBOARD JSON]', error.message);
  }
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
      if (!canRegister(state, candidate, strategy)) continue;
      if (!candidateIsFresh(candidate)) continue;

      const history = symbolHistoryLine(symbolStats(state, candidate.symbol));
      const aiCapsule = buildCompactAiCapsule(candidate);
      const signal = createSignal(candidate, strategy, CONFIG);

      // ذخیره اطلاعات هوش مصنوعی داخل سیگنال برای نمایش در داشبورد وب
      signal.liveInsight = candidate.liveInsight ?? null;
      signal.btcIntel = candidate.btcIntel ?? null;
      signal.reasons = candidate.reasons ?? [];
      signal.grade = candidate.grade ?? 'A';
      signal.isIntrabar = candidate.isIntrabar ?? false;

      state.signals[signal.id] = signal;
      await saveSignalState(state);

      try {
        const fullMessage = [
          signalMessage(candidate, signal.id, output.marketRegime),
          '━━━━━━━━━━━━━━━━━━',
          aiCapsule,
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
  await saveDashboardData(output, state, sentCount, liveRadarSent);

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
