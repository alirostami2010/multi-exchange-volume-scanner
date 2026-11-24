 
const BASE = 'https://api.gateio.ws/api/v4';
const TIMEOUT = 15000;
const SPACING = 120;
const RETRIES = 3;

let queue = Promise.resolve();
let lastRequestAt = 0;

export const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

export function number(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function positive(value) {
  return Number.isFinite(value) && value > 0;
}

export function round(value, digits = 2) {
  return Number.isFinite(value)
    ? Number(value.toFixed(digits))
    : null;
}

export function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(label + ': expected array');
  }
  return value;
}

async function reserveSlot() {
  const slot = queue.then(async () => {
    const wait = SPACING - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  queue = slot.catch(() => {});
  await slot;
}

export async function requestGate(endpoint, params = {}) {
  const url = new URL(BASE + '/futures/usdt/' + endpoint);

  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }

  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    await reserveSlot();

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT),
      });

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
          if (index >= items.length) return;

          try {
            output[index] = await worker(items[index], index);
          } catch (error) {
            console.error(
              '[ITEM ERROR]',
              items[index]?.symbol || '',
              error.message
            );

            output[index] = {
              __error: error.message,
              symbol: items[index]?.symbol,
            };
          }
        }
      }
    )
  );

  return output;
}
