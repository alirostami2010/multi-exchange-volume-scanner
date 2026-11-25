import {
  requestGate,
  closedCandles,
  mapPool,
  number,
  positive,
  requireArray,
} from '../services/gate.js';

import {
  scanWaveSetup,
  WAVE_RIDER_VERSION,
} from './waveRider.js';

import {
  saveSignalState,
} from '../tracking/signalTracker.js';

import {
  sendTelegram,
  telegramConfigured,
} from '../services/telegram.js';

// WATCH is informational. It is not an entry signal.
// This module does not modify scanner scores or paper trade outcomes.

export const WAVE_WATCH_RULES = Object.freeze({
  MIN_QUOTE_VOLUME_24H: 1_000_000,
  HOUR_CANDLE_LIMIT: 120,
  MINUTE_15_CANDLE_LIMIT: 64,
  CONCURRENCY: 5,

  MAX_PER_RUN: 5,
  MAX_PER_UTC_DAY: 10,

  SENT_COOLDOWN_MS: 12 * 60 * 60 * 1000,
  UNCERTAIN_COOLDOWN_MS: 24 * 60 * 60 * 1000,

  MAX_EVENT_AGE_MS: 3 * 60 * 1000,
  MAX_DISTANCE_FROM_TRIGGER_PCT: 2,
  MIN_ROOM_TO_PREVIOUS_EXTREME_PCT: 0.5,
});

function isRecord(value) {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value);
}

function priceText(value) {
  return positive(value)
    ? Number(value.toPrecision(8)).toString()
    : '—';
}

function percentText(value) {
  return Number.isFinite(value)
    ? value.toFixed(1) + '%'
    : '—';
}

function utcDay(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

export function waveWatchKey(event) {
  return event.symbol + ':' + event.side;
}

function distanceFromTriggerPct(event, currentPrice) {
  const trigger = number(event.triggerLevel);

  if (!positive(trigger) || !positive(currentPrice)) {
    return null;
  }

  const distance = event.side === 'LONG'
    ? trigger - currentPrice
    : currentPrice - trigger;

  return distance / currentPrice * 100;
}

function roomToPreviousExtremePct(event) {
  const trigger = number(event.triggerLevel);
  const previousExtreme = number(event.priorExtreme);

  if (!positive(trigger) || !positive(previousExtreme)) {
    return null;
  }

  const room = event.side === 'LONG'
    ? previousExtreme - trigger
    : trigger - previousExtreme;

  return room / trigger * 100;
}

export function eligibleWaveWatch(event, nowMs = Date.now()) {
  if (!isRecord(event)) return false;

  if (event.stage !== 'WATCH') return false;
  if (event.reason !== 'WAITING_FOR_BASE_BREAK') return false;

  if (
    typeof event.symbol !== 'string' ||
    !event.symbol.endsWith('_USDT')
  ) {
    return false;
  }

  if (!['LONG', 'SHORT'].includes(event.side)) {
    return false;
  }

  const observedMs = Date.parse(event.observedAt);

  if (!Number.isFinite(observedMs)) return false;
  if (observedMs > nowMs) return false;

  if (
    nowMs - observedMs >
    WAVE_WATCH_RULES.MAX_EVENT_AGE_MS
  ) {
    return false;
  }

  // At least one independent clue that the correction is weakening.
  if (
    event.correctionVolumeContracting !== true &&
    event.correctionMacdFading !== true
  ) {
    return false;
  }

  const baseHigh = number(event.baseHigh);
  const baseLow = number(event.baseLow);
  const currentPrice = number(event.currentPrice);

  if (
    !positive(baseHigh) ||
    !positive(baseLow) ||
    baseHigh <= baseLow ||
    !positive(currentPrice)
  ) {
    return false;
  }

  const distance = distanceFromTriggerPct(
    event,
    currentPrice
  );

  if (
    distance == null ||
    distance < 0 ||
    distance >
      WAVE_WATCH_RULES.MAX_DISTANCE_FROM_TRIGGER_PCT
  ) {
    return false;
  }

  const room = roomToPreviousExtremePct(event);

  if (
    room == null ||
    room <
      WAVE_WATCH_RULES.MIN_ROOM_TO_PREVIOUS_EXTREME_PCT
  ) {
    return false;
  }

  return true;
}

function watchPriority(event) {
  const distance = distanceFromTriggerPct(
    event,
    event.currentPrice
  );

  let priority = 0;

  if (event.correctionVolumeContracting === true) {
    priority += 10;
  }

  if (event.correctionMacdFading === true) {
    priority += 10;
  }

  if (
    Number.isFinite(event.correctionDepthPct) &&
    event.correctionDepthPct >= 30 &&
    event.correctionDepthPct <= 65
  ) {
    priority += 4;
  }

  if (Number.isFinite(distance)) {
    priority += Math.max(
      0,
      WAVE_WATCH_RULES.MAX_DISTANCE_FROM_TRIGGER_PCT -
        distance
    ) * 4;
  }

  // Modest LONG preference; this is NOT a probability estimate.
  if (event.side === 'LONG') {
    priority += 2;
  }

  return priority;
}

function activePaperPosition(state, event) {
  const signals = isRecord(state?.signals)
    ? Object.values(state.signals)
    : [];

  return signals.some(signal =>
    signal.symbol === event.symbol &&
    [
      'PENDING_DELIVERY',
      'PENDING_ENTRY',
      'OPEN',
    ].includes(signal.status)
  );
}

function recentlyAttempted(state, event, nowMs) {
  const records = isRecord(state?.waveWatches)
    ? state.waveWatches
    : {};

  const record = records[waveWatchKey(event)];

  if (!record) return false;

  const lastAttempt = Date.parse(record.lastAttemptAt);

  // Existing malformed record: fail closed rather than risk spam.
  if (!Number.isFinite(lastAttempt)) return true;
  if (lastAttempt > nowMs) return true;

  const cooldown = record.status === 'SENT'
    ? WAVE_WATCH_RULES.SENT_COOLDOWN_MS
    : WAVE_WATCH_RULES.UNCERTAIN_COOLDOWN_MS;

  return nowMs - lastAttempt < cooldown;
}

function dailyAttempts(state, nowMs) {
  const daily = state?.waveWatchDaily;

  if (!isRecord(daily)) return 0;
  if (daily.day !== utcDay(nowMs)) return 0;

  const attempts = number(daily.attempts);

  return attempts != null && attempts > 0
    ? Math.floor(attempts)
    : 0;
}

// Pure selector: does not change persistent state.
export function selectWaveWatchEvents(
  events,
  state,
  nowMs = Date.now()
) {
  if (!Array.isArray(events)) return [];

  const remainingToday = Math.max(
    0,
    WAVE_WATCH_RULES.MAX_PER_UTC_DAY -
      dailyAttempts(state, nowMs)
  );

  const limit = Math.min(
    WAVE_WATCH_RULES.MAX_PER_RUN,
    remainingToday
  );

  if (limit === 0) return [];

  const eligible = events
    .filter(event => eligibleWaveWatch(event, nowMs))
    .filter(event => !activePaperPosition(state, event))
    .filter(event => !recentlyAttempted(state, event, nowMs))
    .map(event => ({
      ...event,
      watchPriority: watchPriority(event),
    }));

  eligible.sort((a, b) => {
    const difference =
      b.watchPriority - a.watchPriority;

    if (difference !== 0) return difference;

    const volumeDifference =
      (number(b.quoteVolume24h) ?? 0) -
      (number(a.quoteVolume24h) ?? 0);

    if (volumeDifference !== 0) {
      return volumeDifference;
    }

    return waveWatchKey(a).localeCompare(
      waveWatchKey(b)
    );
  });

  return eligible.slice(0, limit);
}

function prepareState(state) {
  if (!isRecord(state)) {
    throw new TypeError('Wave watch requires signal state');
  }

  if (state.waveWatches == null) {
    state.waveWatches = {};
  } else if (!isRecord(state.waveWatches)) {
    throw new Error('Invalid waveWatches state');
  }

  if (state.waveWatchDaily == null) {
    state.waveWatchDaily = {
      day: null,
      attempts: 0,
    };
  } else if (!isRecord(state.waveWatchDaily)) {
    throw new Error('Invalid waveWatchDaily state');
  }
}

async function watchMarkets() {
  const [rawContracts, rawTickers] = await Promise.all([
    requestGate('contracts'),
    requestGate('tickers'),
  ]);

  const contracts = requireArray(
    rawContracts,
    'wave watch contracts'
  );

  const tickers = requireArray(
    rawTickers,
    'wave watch tickers'
  );

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

  return tickers
    .map(ticker => {
      const volume = number(ticker.volume_24h_quote);

      if (!active.has(ticker.contract)) return null;
      if (!positive(number(ticker.last))) return null;

      if (
        volume == null ||
        volume <
          WAVE_WATCH_RULES.MIN_QUOTE_VOLUME_24H
      ) {
        return null;
      }

      return {
        symbol: ticker.contract,
        quoteVolume24h: volume,
      };
    })
    .filter(Boolean)
    .sort((a, b) =>
      b.quoteVolume24h - a.quoteVolume24h
    );
}

async function checkOneMarket(market, asOf) {
  const [raw1h, raw15m] = await Promise.all([
    requestGate('candlesticks', {
      contract: market.symbol,
      interval: '1h',
      limit: WAVE_WATCH_RULES.HOUR_CANDLE_LIMIT,
    }),

    requestGate('candlesticks', {
      contract: market.symbol,
      interval: '15m',
      limit: WAVE_WATCH_RULES.MINUTE_15_CANDLE_LIMIT,
    }),
  ]);

  const candles1h = closedCandles(
    raw1h,
    3600,
    asOf
  );

  const candles15m = closedCandles(
    raw15m,
    900,
    asOf
  );

  const last15m = candles15m.at(-1);
  const currentPrice = last15m?.close ?? null;

  return ['LONG', 'SHORT'].map(side => {
    const assessment = scanWaveSetup({
      symbol: market.symbol,
      side,
      candles1h,
      candles15m,
      asOf,
    });

    return {
      ...assessment,
      symbol: market.symbol,
      side,
      currentPrice,
      quoteVolume24h: market.quoteVolume24h,
    };
  });
}

function watchDigest(events, regime) {
  const regimeNames = {
    BULLISH: 'صعودی',
    BEARISH: 'نزولی',
    NEUTRAL: 'خنثی',
  };

  const lines = [
    '👀 موج‌های زیر نظر Gate — هنوز سیگنال ورود نیست',
    'BTC 4H: ' + (regimeNames[regime] ?? 'نامشخص'),
    'زمان بررسی: ' + new Date().toISOString(),
    '━━━━━━━━━━━━━━━━━━',
  ];

  events.forEach((event, index) => {
    const icon = event.side === 'LONG'
      ? '🟢'
      : '🔴';

    const correctionEvidence = [
      event.correctionVolumeContracting
        ? 'حجم اصلاح کمتر شده'
        : null,

      event.correctionMacdFading
        ? 'فشار اصلاح در MACD کمتر شده'
        : null,
    ].filter(Boolean).join(' • ');

    lines.push(
      (index + 1) + '. ' +
        event.symbol + ' ' +
        icon + ' ' +
        event.side,

      'پایه Gate: ' +
        priceText(event.baseLow) +
        ' تا ' +
        priceText(event.baseHigh),

      'قیمت مرجع: ' +
        priceText(event.currentPrice) +
        ' | سطح زیر نظر: ' +
        priceText(event.triggerLevel),

      'عمق اصلاح 1H: ' +
        percentText(event.correctionDepthPct) +
        ' | ' +
        correctionEvidence,

      '━━━━━━━━━━━━━━━━━━'
    );
  });

  lines.push(
    'عبور از سطح به‌تنهایی ورود نیست؛ تأیید کندل بسته‌شده، حجم و ریسک لازم است.',
    'قیمت LBank بررسی نشده؛ این فهرست در آمار برد/باخت معاملات ثبت نمی‌شود.'
  );

  return lines.join('\n');
}

export async function runWaveWatch(state, regime) {
  prepareState(state);

  if (!telegramConfigured()) {
    return {
      scanned: 0,
      found: 0,
      sent: 0,
      reason: 'MISSING_TELEGRAM_CREDENTIALS',
    };
  }

  if (!['BULLISH', 'BEARISH', 'NEUTRAL'].includes(regime)) {
    return {
      scanned: 0,
      found: 0,
      sent: 0,
      reason: 'BTC_REGIME_UNKNOWN',
    };
  }

  const markets = await watchMarkets();
  const asOf = Math.floor(Date.now() / 1000);

  const results = await mapPool(
    markets,
    WAVE_WATCH_RULES.CONCURRENCY,
    market => checkOneMarket(market, asOf)
  );

  const events = [];
  const stageCounts = {};
  let failedMarkets = 0;

  for (const result of results) {
    if (result?.__error) {
      failedMarkets++;
      continue;
    }

    if (!Array.isArray(result)) continue;

    for (const event of result) {
      const label = event.stage + ':' +
        (event.reason ?? 'NO_REASON');

      stageCounts[label] =
        (stageCounts[label] ?? 0) + 1;

      events.push(event);
    }
  }

  const possible = selectWaveWatchEvents(
    events,
    state,
    Date.now()
  );

  console.log(
    '[WAVE WATCH SCAN]',
    JSON.stringify({
      scanned: markets.length,
      failedMarkets,
      stageCounts,
      watchCandidates: possible.length,
    })
  );

  if (possible.length === 0) {
    return {
      scanned: markets.length,
      failedMarkets,
      found: 0,
      sent: 0,
      reason: 'NO_NEW_WATCH',
    };
  }

  // Recheck price so an already broken level is not called "waiting".
  const freshTickers = requireArray(
    await requestGate('tickers'),
    'fresh wave watch tickers'
  );

  const priceMap = new Map(
    freshTickers.map(ticker => [
      ticker.contract,
      number(ticker.last),
    ])
  );

  const freshEvents = possible.map(event => ({
    ...event,
    currentPrice: priceMap.get(event.symbol),
  }));

  const selected = selectWaveWatchEvents(
    freshEvents,
    state,
    Date.now()
  );

  if (selected.length === 0) {
    return {
      scanned: markets.length,
      failedMarkets,
      found: possible.length,
      sent: 0,
      reason: 'PRICE_MOVED_OR_WATCH_EXPIRED',
    };
  }

  const attemptedAt = new Date().toISOString();
  const day = attemptedAt.slice(0, 10);

  const previousAttempts =
    state.waveWatchDaily.day === day
      ? dailyAttempts(state, Date.now())
      : 0;

  state.waveWatchDaily = {
    day,
    attempts: previousAttempts + selected.length,
  };

  for (const event of selected) {
    state.waveWatches[waveWatchKey(event)] = {
      symbol: event.symbol,
      side: event.side,
      version: WAVE_RIDER_VERSION,
      status: 'PREPARED',
      lastAttemptAt: attemptedAt,
      lastSentAt: null,
      triggerLevel: event.triggerLevel,
      reason: event.reason,
    };
  }

  // Save intent before contacting Telegram.
  await saveSignalState(state);

  let delivery;

  try {
    delivery = await sendTelegram(
      watchDigest(selected, regime)
    );

    for (const event of selected) {
      const record =
        state.waveWatches[waveWatchKey(event)];

      if (delivery.sent) {
        record.status = 'SENT';
        record.lastSentAt = delivery.confirmedAt;
        record.messageIds = delivery.messageIds;
      } else {
        record.status = 'DELIVERY_UNKNOWN';
        record.deliveryNote =
          delivery.reason ?? 'NOT_CONFIRMED';
      }
    }
  } catch (error) {
    for (const event of selected) {
      const record =
        state.waveWatches[waveWatchKey(event)];

      record.status = 'DELIVERY_UNKNOWN';
      record.deliveryNote = error.message;
    }

    console.error(
      '[WAVE WATCH TELEGRAM]',
      error.message
    );

    delivery = {
      sent: false,
      reason: 'DELIVERY_UNKNOWN',
    };
  }

  await saveSignalState(state);

  return {
    scanned: markets.length,
    failedMarkets,
    found: possible.length,
    selected: selected.length,
    sent: delivery.sent ? selected.length : 0,
    reason: delivery.sent
      ? 'SENT'
      : delivery.reason,
  };
  }
