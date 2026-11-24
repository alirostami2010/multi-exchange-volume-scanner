import { sleep } from './gate.js';

// File: src/services/telegram.js
// Telegram notifications only. No order execution.

const MAX_LENGTH = 3800;
const TIMEOUT_MS = 15000;

function getCredentials() {
  let token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    token = process.env.TELEGRAM_TOKEN;
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;

  return {
    token,
    chatId,
  };
}

export function telegramConfigured() {
  const credentials = getCredentials();

  return Boolean(
    credentials.token && credentials.chatId
  );
}

function splitMessage(text) {
  const chunks = [];
  let current = '';

  for (const line of String(text).split('\n')) {
    const pieces = [];
    let piece = '';

    // Iterate by Unicode code point to avoid splitting emoji surrogates.
    for (const character of line) {
      if (piece.length + character.length > MAX_LENGTH) {
        pieces.push(piece);
        piece = '';
      }

      piece += character;
    }

    pieces.push(piece);

    for (const part of pieces) {
      const combined = current
        ? current + '\n' + part
        : part;

      if (combined.length > MAX_LENGTH) {
        if (current) {
          chunks.push(current);
        }

        current = part;
      } else {
        current = combined;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

export async function sendTelegram(text) {
  const { token, chatId } = getCredentials();

  if (!token) {
    return {
      sent: false,
      reason: 'MISSING_CREDENTIALS',
    };
  }

  if (!chatId) {
    return {
      sent: false,
      reason: 'MISSING_CREDENTIALS',
    };
  }

  const chunks = splitMessage(text);

  if (chunks.length === 0) {
    return {
      sent: false,
      reason: 'EMPTY_MESSAGE',
    };
  }

  const messageIds = [];
  let confirmedAt = null;

  for (let index = 0; index < chunks.length; index++) {
    let response;

    try {
      response = await fetch(
        'https://api.telegram.org/bot' + token + '/sendMessage',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            chat_id: chatId,
            text: chunks[index],
            disable_web_page_preview: true,
          }),

          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      );
    } catch {
      // Do not expose the token-containing request URL.
      // A timeout does not prove the message was not delivered.
      throw new Error(
        'Telegram network/timeout on part ' +
        (index + 1) +
        '; delivery uncertain'
      );
    }

    let data = null;

    try {
      data = await response.json();
    } catch {
      data = null;
    }

    let accepted = false;

    if (response.ok && data != null) {
      accepted = data.ok === true;
    }

    if (!accepted) {
      let description =
        'Telegram HTTP ' + response.status +
        ', part ' + (index + 1);

      if (
        data != null &&
        typeof data.description === 'string'
      ) {
        description = data.description;
      }

      throw new Error(description);
    }

    const messageId = data.result?.message_id;

    messageIds.push(
      Number.isFinite(messageId) ? messageId : null
    );

    // Conservative timestamp: after successful API acknowledgement.
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
  if (!Number.isFinite(value)) return '—';
  if (!(value > 0)) return '—';

  return Number(value.toPrecision(8)).toString();
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';

  return value.toFixed(digits);
}

function formatDirectionalPercent(side, entry, exit) {
  if (!Number.isFinite(entry)) return '—';
  if (!Number.isFinite(exit)) return '—';
  if (!(entry > 0)) return '—';
  if (!(exit > 0)) return '—';

  const difference = side === 'LONG'
    ? exit - entry
    : entry - exit;

  const value = difference / entry * 100;
  const sign = value >= 0 ? '+' : '';

  return sign + value.toFixed(2) + '%';
}

export function signalMessage(item, id, regime) {
  const isLong = item.side === 'LONG';

  const referenceEntry = isLong
    ? item.entryHigh
    : item.entryLow;

  const targets = Array.isArray(item.takeProfits)
    ? item.takeProfits
    : [];

  const targetText = targets.map(target =>
    'T' + target.level +
    ': ' + formatPrice(target.price) +
    ' (' +
    formatDirectionalPercent(
      item.side,
      referenceEntry,
      target.price
    ) +
    ')'
  ).join(' | ');

  const reasons = Array.isArray(item.reasons)
    ? item.reasons.slice(0, 3).join(' • ')
    : '—';

  const regimeNames = {
    BULLISH: 'صعودی',
    BEARISH: 'نزولی',
    NEUTRAL: 'خنثی',
    UNKNOWN: 'نامشخص',
  };

  const regimeText = regimeNames[regime] ?? String(regime);
  const icon = isLong ? '🟢' : '🔴';

  const lines = [
    '📊 Gate.io | ' + icon + ' ' + item.side +
      ' | ' + item.symbol,

    'شناسه: ' + String(id).slice(0, 12),

    'BTC: ' + regimeText +
      ' | امتیاز: ' + formatNumber(item.score, 0) + '/100',

    'ورود: ' + formatPrice(item.entryLow) +
      ' تا ' + formatPrice(item.entryHigh),

    'حد ضرر: ' + formatPrice(item.stopLoss) +
      ' (' +
      formatDirectionalPercent(
        item.side,
        referenceEntry,
        item.stopLoss
      ) +
      ')',

    'اهداف تاریخی: ' + (targetText ? targetText : 'نامشخص'),

    'RR خالص تخمینی T1: ' +
      formatNumber(item.riskRewardToTp1),

    'دلیل: ' + reasons,

    'اعتبار ورود: ' + item.validUntil,
  ];

  if (item.riskNote) {
    lines.push('⚠️ ' + item.riskNote);
  }

  lines.push(
    'این سیگنال برای ارزیابی فرضی ثبت می‌شود؛ سفارش اجرا نمی‌شود.',
    'منبع Gate است؛ قیمت LBank تأیید نشده.',
    'درصدها بدون اهرم‌اند؛ امتیاز، احتمال موفقیت نیست.'
  );

  return lines.join('\n');
}
