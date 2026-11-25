import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  requireArray,
} from '../services/gate.js';

import { scanWaveSetup } from './waveRider.js';

import {
  saveWaveState,
  waveTradeId,
  createWaveTrade,
  markWaveDelivered,
} from './waveTracker.js';

import {
  sendTelegram,
  telegramConfigured,
} from '../services/telegram.js';

export const WAVE_ENTRY_RULES = Object.freeze({
  MIN_QUOTE_VOLUME_24H: 1000000,
  CONCURRENCY: 5,
  HOUR_LIMIT: 120,
  MINUTE_LIMIT: 64,
  MAX_PER_RUN: 2,
  MAX_PER_DAY: 6,
  MAX_OPEN: 3,
  COOLDOWN_MS: 6 * 60 * 60 * 1000,
  MAX_EVENT_AGE_MS: 3 * 60 * 1000,
});

function isRecord(value) {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function activeStatus(status) {
  return [
    'PENDING_DELIVERY',
    'PENDING_ENTRY',
    'OPEN',
  ].includes(status);
}

export function selectWaveEntries(
  events,
  waveState,
  signalState,
  nowMs
) {
  if (!Array.isArray(events)) return [];

  const day = new Date(nowMs).toISOString().slice(0, 10);
  const usedToday = waveState?.daily?.day === day
    ? Math.max(0, Math.floor(Number(waveState.daily.attempts) || 0))
    : 0;

  const trades = isRecord(waveState?.trades)
    ? Object.values(waveState.trades)
    : [];

  const openCount = trades.filter(trade =>
    activeStatus(trade.status)
  ).length;

  const remaining = Math.min(
    WAVE_ENTRY_RULES.MAX_PER_RUN,
    WAVE_ENTRY_RULES.MAX_PER_DAY - usedToday,
    WAVE_ENTRY_RULES.MAX_OPEN - openCount
  );

  if (remaining <= 0) return [];

  const signals = isRecord(signalState?.signals)
    ? Object.values(signalState.signals)
    : [];

  const eligible = events.filter(event => {
    if (!isRecord(event) || event.stage !== 'ENTRY') return false;
    if (!['LONG', 'SHORT'].includes(event.side)) return false;

    const observed = Date.parse(event.observedAt);
    const validUntil = Date.parse(event.validUntil);

    if (!Number.isFinite(observed) || !Number.isFinite(validUntil)) {
      return false;
    }

    if (nowMs < observed || nowMs - observed > WAVE_ENTRY_RULES.MAX_EVENT_AGE_MS) {
      return false;
    }

    if (nowMs >= validUntil) return false;

    const price = Number(event.currentPrice);

    if (
      !positive(price) ||
      price < Number(event.entryLow) ||
      price > Number(event.entryHigh)
    ) {
      return false;
    }

    if (trades.some(trade =>
      trade.symbol === event.symbol &&
      activeStatus(trade.status)
    )) return false;

    if (signals.some(signal =>
      signal.symbol === event.symbol &&
      activeStatus(signal.status)
    )) return false;

    const attempt = waveState?.attempts?.[event.symbol + ':' + event.side];
    const lastAttempt = Date.parse(attempt?.lastAttemptAt);

    if (Number.isFinite(lastAttempt)) {
      if (lastAttempt > nowMs) return false;
      if (nowMs - lastAttempt < WAVE_ENTRY_RULES.COOLDOWN_MS) return false;
    }

    return !trades.some(trade => trade.id === waveTradeId(event));
  });

  eligible.sort((a, b) => {
    if (a.side !== b.side) return a.side === 'LONG' ? -1 : 1;

    const rrDifference =
      Number(b.netRRToPriorExtreme) - Number(a.netRRToPriorExtreme);

    if (rrDifference !== 0) return rrDifference;

    return a.symbol.localeCompare(b.symbol);
  });

  return eligible.slice(0, remaining);
}

function priceText(value) {
  return positive(Number(value))
    ? Number(Number(value).toPrecision(8)).toString()
    : '—';
}

function entryMessage(event) {
  return [
    '🧪 ورود آزمایشی موج‌سوار | جدا از اسکنر اصلی',
    event.symbol + ' | ' + event.side,
    'شناسه: ' + waveTradeId(event).slice(0, 12),
    'ورود مرجع Gate: ' + priceText(event.entryLow) +
      ' تا ' + priceText(event.entryHigh),
    'حد ضرر اولیه: ' + priceText(event.stopLoss),
    'هدف تاریخی نخست: ' + priceText(event.priorExtremeTarget),
    'RR خالص تخمینی تا هدف نخست: ' + event.netRRToPriorExtreme,
    'اعتبار: ' + event.validUntil,
    'خروج آزمایشی با حد ضرر، تریل یا شکست ساختار ۱۵دقیقه‌ای بررسی می‌شود.',
    'ربات سفارش اجرا نمی‌کند؛ حد ضرر واقعی باید در LBank ثبت شود.',
    'سودآوری این مدل هنوز اثبات نشده است.',
  ].join('\n');
}

async function collectEntries() {
  const [rawContracts, rawTickers] = await Promise.all([
    requestGate('contracts'),
    requestGate('tickers'),
  ]);

  const contracts = requireArray(rawContracts, 'wave entry contracts');
  const tickers = requireArray(rawTickers, 'wave entry tickers');

  const active = new Set(
    contracts
      .filter(contract =>
        typeof contract.name === 'string' &&
        contract.name.endsWith('_USDT') &&
        contract.status === 'trading' &&
        contract.in_delisting === false &&
        positive(number(contract.quanto_multiplier))
      )
      .map(contract => contract.name)
  );

  const markets = tickers
    .map(ticker => {
      const volume = number(ticker.volume_24h_quote);
      if (!active.has(ticker.contract)) return null;
      if (!positive(number(ticker.last))) return null;
      if (volume == null || volume < WAVE_ENTRY_RULES.MIN_QUOTE_VOLUME_24H) {
        return null;
      }
      return {
        symbol: ticker.contract,
        quoteVolume24h: volume,
      };
    })
    .filter(Boolean);

  const asOf = Math.floor(Date.now() / 1000);

  const results = await mapPool(
    markets,
    WAVE_ENTRY_RULES.CONCURRENCY,
    async market => {
      const [raw1h, raw15m] = await Promise.all([
        requestGate('candlesticks', {
          contract: market.symbol,
          interval: '1h',
          limit: WAVE_ENTRY_RULES.HOUR_LIMIT,
        }),
        requestGate('candlesticks', {
          contract: market.symbol,
          interval: '15m',
          limit: WAVE_ENTRY_RULES.MINUTE_LIMIT,
        }),
      ]);

      return ['LONG', 'SHORT'].map(side => ({
        ...scanWaveSetup({
          symbol: market.symbol,
          side,
          candles1h: closedCandles(raw1h, 3600, asOf),
          candles15m: closedCandles(raw15m, 900, asOf),
          asOf,
        }),
        currentPrice: closedCandles(raw15m, 900, asOf).at(-1)?.close,
        quoteVolume24h: market.quoteVolume24h,
      }));
    }
  );

  return results
    .filter(result => Array.isArray(result))
    .flat();
}

export async function runWaveEntries(
  waveState,
  signalState,
  regime
) {
  if (!telegramConfigured()) {
    return { found: 0, sent: 0, reason: 'MISSING_TELEGRAM_CREDENTIALS' };
  }

  if (!['BULLISH', 'BEARISH', 'NEUTRAL'].includes(regime)) {
    return { found: 0, sent: 0, reason: 'BTC_REGIME_UNKNOWN' };
  }

  const events = await collectEntries();
  const fresh = requireArray(
    await requestGate('tickers'),
    'fresh wave entry tickers'
  );

  const prices = new Map(
    fresh.map(ticker => [ticker.contract, number(ticker.last)])
  );

  const selected = selectWaveEntries(
    events.map(event => ({
      ...event,
      currentPrice: prices.get(event.symbol),
    })),
    waveState,
    signalState,
    Date.now()
  );

  console.log('[WAVE ENTRY SCAN]', JSON.stringify({
    found: events.filter(event => event.stage === 'ENTRY').length,
    selected: selected.length,
  }));

  if (selected.length === 0) {
    return { found: 0, sent: 0, reason: 'NO_NEW_ENTRY' };
  }

  const attemptedAt = new Date().toISOString();
  const day = attemptedAt.slice(0, 10);
  const previous = waveState.daily?.day === day
    ? Number(waveState.daily.attempts) || 0
    : 0;

  waveState.daily = {
    day,
    attempts: previous + selected.length,
  };

  let sent = 0;

  for (const event of selected) {
    const key = event.symbol + ':' + event.side;

    waveState.attempts[key] = {
      lastAttemptAt: attemptedAt,
      status: 'PREPARED',
    };

    const trade = createWaveTrade(event);
    waveState.trades[trade.id] = trade;
    await saveWaveState(waveState);

    try {
      const delivery = await sendTelegram(entryMessage(event));

      if (delivery.sent) {
        markWaveDelivered(trade, delivery);
        waveState.attempts[key].status = 'SENT';
        sent++;
      } else {
        trade.status = 'NOT_SENT';
        waveState.attempts[key].status = 'UNKNOWN';
      }
    } catch (error) {
      trade.status = 'DELIVERY_UNKNOWN';
      trade.deliveryNote = error.message;
      waveState.attempts[key].status = 'UNKNOWN';
      console.error('[WAVE ENTRY TELEGRAM]', error.message);
    }

    await saveWaveState(waveState);
    if (trade.status === 'DELIVERY_UNKNOWN') break;
  }

  return {
    found: events.filter(event => event.stage === 'ENTRY').length,
    selected: selected.length,
    sent,
    reason: sent > 0 ? 'SENT' : 'NOT_CONFIRMED',
  };
      }
