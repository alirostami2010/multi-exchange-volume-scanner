import { sleep } from './gate.js';

const MAX_LENGTH = 3800;
const TIMEOUT_MS = 15000;

function getCredentials() {
  let token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return { token, chatId };
}

export function telegramConfigured() {
  const credentials = getCredentials();
  return Boolean(credentials.token && credentials.chatId);
}

function splitMessage(text) {
  const chunks = [];
  let current = '';

  for (const line of String(text).split('\n')) {
    const pieces = [];
    let piece = '';

    for (const character of line) {
      if (piece.length + character.length > MAX_LENGTH) {
        pieces.push(piece);
        piece = '';
      }
      piece += character;
    }
    pieces.push(piece);

    for (const part of pieces) {
      const combined = current ? current + '\n' + part : part;
      if (combined.length > MAX_LENGTH) {
        if (current) chunks.push(current);
        current = part;
      } else {
        current = combined;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// قابلیت ریپلای خودکار روی پیام اصلی سیگنال (replyToMessageId) اضافه شد
export async function sendTelegram(text, replyToMessageId = null) {
  const { token, chatId } = getCredentials();

  if (!token || !chatId) {
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }

  const chunks = splitMessage(text);
  if (chunks.length === 0) {
    return { sent: false, reason: 'EMPTY_MESSAGE' };
  }

  const messageIds = [];
  let confirmedAt = null;

  for (let index = 0; index < chunks.length; index++) {
    let response;
    const payload = {
      chat_id: chatId,
      text: chunks[index],
      disable_web_page_preview: true,
    };

    if (index === 0 && Number.isFinite(replyToMessageId)) {
      payload.reply_to_message_id = replyToMessageId;
      payload.allow_sending_without_reply = true;
    }

    try {
      response = await fetch(
        'https://api.telegram.org/bot' + token + '/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
    } catch {
      throw new Error(
        'Telegram network/timeout on part ' + (index + 1) + '; delivery uncertain'
      );
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    const accepted = response.ok && data != null && data.ok === true;
    if (!accepted) {
      let description = 'Telegram HTTP ' + response.status + ', part ' + (index + 1);
      if (data != null && typeof data.description === 'string') {
        description = data.description;
      }
      throw new Error(description);
    }

    const messageId = data.result?.message_id;
    messageIds.push(Number.isFinite(messageId) ? messageId : null);
    confirmedAt = new Date().toISOString();

    if (index < chunks.length - 1) {
      await sleep(250);
    }
  }

  return {
    sent: true,
    parts: chunks.length,
    messageIds,
    confirmedAt,
  };
}

function formatPrice(value) {
  if (!Number.isFinite(value) || !(value > 0)) return '—';
  return Number(value.toPrecision(8)).toString();
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function formatDirectionalPercent(side, entry, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !(entry > 0) || !(exit > 0)) {
    return '—';
  }
  const difference = side === 'LONG' ? exit - entry : entry - exit;
  const value = (difference / entry) * 100;
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

export function signalMessage(item, id, regime) {
  const isLong = item.side === 'LONG';
  const referenceEntry = isLong ? item.entryHigh : item.entryLow;
  const targets = Array.isArray(item.takeProfits) ? item.takeProfits : [];

  const t1 = targets[0]
    ? '🎯 TP1: ' +
      formatPrice(targets[0].price) +
      ' (' +
      formatDirectionalPercent(item.side, referenceEntry, targets[0].price) +
      ')'
    : '';
  const t2 = targets[1]
    ? '🎯 TP2: ' +
      formatPrice(targets[1].price) +
      ' (' +
      formatDirectionalPercent(item.side, referenceEntry, targets[1].price) +
      ')'
    : '';
  const t3 = targets[2]
    ? '🚀 TP3: ' +
      formatPrice(targets[2].price) +
      ' (' +
      formatDirectionalPercent(item.side, referenceEntry, targets[2].price) +
      ')'
    : '';

  const icon = isLong ? '🟢 LONG' : '🔴 SHORT';
  const grade = item.grade ?? (item.score >= 82 ? 'A+' : 'A');
  const ai = item.liveInsight;

  const lines = [
    icon + ' | #' + item.symbol + ' | درجه: ' + grade + ' (' + formatNumber(item.score, 0) + '/100)',
    ai ? '📌 ' + ai.entryInstruction : '📌 ورود در محدوده مشخص‌شده',
    '━━━━━━━━━━━━━━━━━━',
    '🎯 ورود: ' +
      formatPrice(item.entryLow) +
      ' تا ' +
      formatPrice(item.entryHigh) +
      ' (فعلی: ' +
      formatPrice(item.lastCheckedPrice ?? item.price) +
      ')',
    '🛑 حد ضرر: ' +
      formatPrice(item.stopLoss) +
      ' (' +
      formatDirectionalPercent(item.side, referenceEntry, item.stopLoss) +
      ')',
    [t1, t2].filter(Boolean).join(' | '),
    [t3, '⚖️ ریوارد: ' + formatNumber(item.riskRewardToTp2 ?? item.riskRewardToTp1) + 'R']
      .filter(Boolean)
      .join(' | '),
  ];

  return lines.filter(Boolean).join('\n');
}
