if (response.ok) return await response.json();

      const body = await response.text().catch(() => '');
      const error = new Error(
        'Gate HTTP ' + response.status + ' ' + endpoint +
        ': ' + body.slice(0, 160)
      );

      error.status = response.status;

      const header = response.headers.get('retry-after');
      const seconds = Number(header);

      error.delay = header && Number.isFinite(seconds)
        ? seconds * 1000
        : header
          ? Math.max(0, Date.parse(header) - Date.now()) || 0
          : 0;

      throw error;
    } catch (error) {
      lastError = error;

      const retryable = [
        408, 425, 429, 500, 502, 503, 504,
      ].includes(error.status);

      if (
        attempt === RETRIES ||
        (error.status != null && !retryable)
      ) break;

      await sleep(
        error.delay > 0
          ? Math.min(error.delay, 30000)
          : Math.min(500 * (2 ** attempt), 8000)
      );
    }
  }

  throw lastError;
}

export function normalizeCandle(raw) {
  const time = number(raw?.t);
  const open = number(raw?.o);
  const high = number(raw?.h);
  const low = number(raw?.l);
  const close = number(raw?.c);

  if (
    !positive(time) ||
    ![open, high, low, close].every(positive) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    high < low
  ) return null;

  return {
    time,
    open,
    high,
    low,
    close,
    volumeContracts: number(raw.v),
    quoteTurnover: number(raw.sum),
  };
}

export function closedCandles(raw, seconds, asOf) {
  const unique = new Map();

  for (const row of requireArray(raw, 'candles')) {
    const candle = normalizeCandle(row);
    if (candle && candle.time + seconds <= asOf) {
      unique.set(candle.time, candle);
    }
  }

  return [...unique.values()].sort((a, b) => a.time - b.time);
}

export async function mapPool(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const index = cursor++;

import { sleep } from './gate.js';

const MAX_LENGTH = 3800;
const TIMEOUT = 15000;

export function telegramConfigured() {
  return Boolean(
    (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN) &&
    process.env.TELEGRAM_CHAT_ID
  );
}

function splitMessage(text) {
  const chunks = [];
  let current = '';

  for (const line of String(text).split('\n')) {
    const pieces = [];

    for (let i = 0; i < line.length; i += MAX_LENGTH) {
      pieces.push(line.slice(i, i + MAX_LENGTH));
    }

    if (!pieces.length) pieces.push('');

    for (const piece of pieces) {
      const next = current ? current + '\n' + piece : piece;

      if (next.length > MAX_LENGTH) {
        if (current) chunks.push(current);
        current = piece;
      } else {
        current = next;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function sendTelegram(text) {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.TELEGRAM_TOKEN;

  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }

  const chunks = splitMessage(text);
  const messageIds = [];

  for (let i = 0; i < chunks.length; i++) {
    let response;

try {
      response = await fetch(
        'https://api.telegram.org/bot' + token + '/sendMessage',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunks[i],
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        }
      );
    } catch {
      // Delivery can be uncertain after a timeout.
      throw new Error('Telegram network/timeout; delivery uncertain');
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(
        data?.description ||
        'Telegram HTTP ' + response.status
      );
    }

    messageIds.push(data.result?.message_id ?? null);
    await sleep(250);
  }

  return {
    sent: true,
    messageIds,
    confirmedAt: new Date().toISOString(),
  };
}

function price(value) {
  return Number.isFinite(value) && value > 0
    ? Number(value.toPrecision(8)).toString()
    : '—';
}

function pct(side, entry, exit) {
  if (!(entry > 0) || !(exit > 0)) return '—';

  const value = (
    side === 'LONG'
      ? (exit - entry) / entry
      : (entry - exit) / entry
  ) * 100;

  return (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
}

export function signalMessage(item, id, regime) {
  const entry = item.side === 'LONG'
    ? item.entryHigh
    : item.entryLow;

  const targetText = item.takeProfits.map(target =>
    'T' + target.level + ': ' + price(target.price) +
    ' (' + pct(item.side, entry, target.price) + ')'
  ).join(' | ');

  const lines = [
    '📊 Gate.io | ' + item.side + ' | ' + item.symbol,
    'شناسه: ' + id.slice(0, 12),
    'BTC: ' + regime + ' | امتیاز: ' + item.score + '/100',
    'ورود: ' + price(item.entryLow) + ' تا ' + price(item.entryHigh),
    'حد ضرر: ' + price(item.stopLoss) +
      ' (' + pct(item.side, entry, item.stopLoss) + ')',
    'اهداف تاریخی: ' + targetText,
    'RR خالص تخمینی T1: ' + item.riskRewardToTp1,
    'دلیل: ' + item.reasons.slice(0, 3).join(' • '),
    'اعتبار ورود: ' + item.validUntil,
  ];

  if (item.riskNote) lines.push('⚠️ ' + item.riskNote);

  lines.push(
    'این سیگنال برای ارزیابی فرضی ثبت می‌شود؛ سفارش اجرا نمی‌شود.',
    'منبع Gate است؛ قیمت LBank تأیید نشده. امتیاز، احتمال موفقیت نیست.'
  );

  return lines.join('\n');
}
