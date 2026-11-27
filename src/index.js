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

const FINAL_STATUSES = ['CLOSED', 'AMBIGUOUS', 'EXPIRED_NO_ENTRY'];

function needsResultNotification(signal) {
  return (
    signal.sentAt &&
    !signal.resultNotified &&
    FINAL_STATUSES.includes(signal.status)
  );
}

// ساخت کپسول فشرده و ۳ ثانیه‌ای از تمام تحلیل‌های هوش مصنوعی، بیت‌کوین و رفتار تاریخی
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

// ارسال تمام آپدیت‌های لحظه‌ای رادار با ریپلای مستقیم روی پیام سیگنال اصلی
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

// ارسال نتیجه نهایی با ریپلای مستقیم روی پیام سیگنال اصلی
async function notifyResults(state) {
  if (!telegramConfigured()) return;

  for (const signal of Object.values(state.signals)) {
    if (!needsResultNotification(signal)) continue;

    // اگر سیگنالی اصلاً وارد محدوده ورود نشده و منقضی شده، کانال را شلوغ نکن
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
    // بدون هیچ محدودیتی (حذف TOP_COUNT)، تمام سیگنال‌های تاییدشده ارسال می‌شوند
    for (const candidate of output.rankedCandidates) {
      if (!canRegister(state, candidate, strategy)) continue;
      if (!candidateIsFresh(candidate)) continue;

      const history = symbolHistoryLine(symbolStats(state, candidate.symbol));
      const aiCapsule = buildCompactAiCapsule(candidate);
      const signal = createSignal(candidate, strategy, CONFIG);
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
