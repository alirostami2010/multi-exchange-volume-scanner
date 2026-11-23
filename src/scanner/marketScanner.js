
/**
 * GATE.IO USDT PERPETUAL — DAILY STRUCTURE TREND SCANNER
 * ------------------------------------------------------------
 * Finds all active USDT perpetual contracts showing:
 * 1) Established daily uptrend: higher swing highs + higher swing lows.
 * 2) Early bullish transition: higher swing low + breakout above
 *    the latest meaningful swing high.
 *
 * Historical analysis uses completed daily candles only.
 * Current daily candle and live ticker check whether structure holds.
 * A red live candle alone does not invalidate the trend.
 *
 * Price action only. No indicators, volume filters, entry signals,
 * lower timeframes, or result-count cap.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',
  INTERVAL: '1d',
  CANDLE_SECONDS: 86400,
  CANDLE_LIMIT: 160,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  MAX_PIVOT_AGE: 45,
  MIN_CLOSED_CANDLES: 35,
  CONCURRENCY: 5,
  REQUEST_TIMEOUT: 30000,
  RETRIES: 5,
  REQUEST_SPACING_MS: 120,
  MAX_RETRY_DELAY_MS: 30000,
  TELEGRAM_SAFE_LENGTH: 3800,
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let nextRequestAt = 0;

async function waitForRequestSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + CONFIG.REQUEST_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

function isRetryableError(error) {
  const status = Number(error?.status || 0);

  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  if (status >= 400 && status < 500) {
    return false;
  }

  return true;
}

function retryDelay(error, attempt) {
  if (Number(error?.status) === 429) {
    const retryAfter = Number(error?.retryAfterSeconds || 0) * 1000;

    if (retryAfter > 0) {
      return Math.min(retryAfter, CONFIG.MAX_RETRY_DELAY_MS);
    }
  }

  return Math.min(
    1000 * 2 ** (attempt - 1),
    CONFIG.MAX_RETRY_DELAY_MS
  );
}

async function fetchJSON(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      await waitForRequestSlot();

      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 240);

        const error = new Error(
          `Gate.io HTTP ${response.status}: ${body}`
        );

        error.status = response.status;
        error.retryAfterSeconds = Number(
          response.headers.get('retry-after') || 0
        );

        throw error;
      }

      return await response.json();

    } catch (error) {
      lastError = error;

      if (
        attempt >= CONFIG.RETRIES ||
        !isRetryableError(error)
      ) {
        break;
      }

      const delay = retryDelay(error, attempt);

      console.warn(
        `[API RETRY ${attempt}/${CONFIG.RETRIES - 1}] ` +
        `${error.message}; wait ${Math.ceil(delay / 1000)}s`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

const toNumber = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : NaN;
};

async function getContracts() {
  const data = await fetchJSON(
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/contracts`
  );

  if (!Array.isArray(data)) {
    throw new Error('Invalid Gate.io contracts response.');
  }

  return data
    .filter(contract => {
      const symbol = String(
        contract?.name ?? ''
      ).trim().toUpperCase();

      const status = String(
        contract?.status ?? ''
      ).trim().toLowerCase();

      return (
        /^[A-Z0-9]{2,40}_USDT$/.test(symbol) &&
        status === 'trading' &&
        contract?.in_delisting !== true
      );
    })
    .map(contract =>
      String(contract.name).trim().toUpperCase()
    )
    .sort();
}

async function getLiveTickers() {
  const data = await fetchJSON(
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/tickers`
  );

  if (!Array.isArray(data)) {
    throw new Error('Invalid Gate.io futures tickers response.');
  }

  const tickers = new Map();

  for (const ticker of data) {
    const symbol = String(
      ticker?.contract ?? ''
    ).trim().toUpperCase();

    const last = toNumber(ticker?.last);

    if (symbol && last > 0) {
      tickers.set(symbol, last);
    }
  }

  return tickers;
}

async function getDailyCandles(symbol) {
  const params = new URLSearchParams({
    contract: symbol,
    interval: CONFIG.INTERVAL,
    limit: String(CONFIG.CANDLE_LIMIT),
    timezone: 'utc0',
  });

  const data = await fetchJSON(
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/candlesticks?${params}`
  );

  if (!Array.isArray(data)) {
    throw new Error(`Invalid daily candle response: ${symbol}`);
  }

  return data
    .map(item => ({
      time: Number(item?.t),
      open: toNumber(item?.o),
      high: toNumber(item?.h),
      low: toNumber(item?.l),
      close: toNumber(item?.c),
    }))
    .filter(candle =>
      Number.isFinite(candle.time) &&
      candle.open > 0 &&
      candle.high > 0 &&
      candle.low > 0 &&
      candle.close > 0 &&
      candle.high >= candle.low
    )
    .sort((a, b) => a.time - b.time);
}

/**
 * Detect confirmed swing highs and swing lows.
 * A pivot is confirmed only after the configured right-side candles
 * have completed, so unfinished daily candles cannot create pivots.
 */
function findSwingPoints(candles) {
  const highs = [];
  const lows = [];

  const left = CONFIG.PIVOT_LEFT;
  const right = CONFIG.PIVOT_RIGHT;

  for (
    let i = left;
    i < candles.length - right;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (
      let j = i - left;
      j <= i + right;
      j++
    ) {
      if (j === i) continue;

      if (
        j < i
          ? current.high <= candles[j].high
          : current.high < candles[j].high
      ) {
        isHigh = false;
      }

      if (
        j < i
          ? current.low >= candles[j].low
          : current.low > candles[j].low
      ) {
        isLow = false;
      }

      if (!isHigh && !isLow) break;
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: current.high,
        time: current.time,
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: current.low,
        time: current.time,
      });
    }
  }

  return { highs, lows };
}

function lastTwoRecent(points, lastIndex) {
  const recent = points.filter(
    point =>
      lastIndex - point.index <= CONFIG.MAX_PIVOT_AGE
  );

  return recent.length >= 2
    ? recent.slice(-2)
    : null;
}

/**
 * Main daily structure analysis.
 *
 * Historical candles: completed daily candles only.
 * Current candle: used for live condition and intraday wick warning.
 * Live ticker: final check against the structural floor.
 */
function analyzeStructure(
  closedCandles,
  liveLast,
  currentCandle
) {
  if (
    closedCandles.length <
    CONFIG.MIN_CLOSED_CANDLES
  ) {
    return {
      qualifies: false,
      reason: 'تاریخچه روزانه کافی نیست',
    };
  }

  const { highs, lows } =
    findSwingPoints(closedCandles);

  const lastIndex = closedCandles.length - 1;

  const recentHighs =
    lastTwoRecent(highs, lastIndex);

  const recentLows =
    lastTwoRecent(lows, lastIndex);

  if (!recentHighs || !recentLows) {
    return {
      qualifies: false,
      reason: 'سقف/کف ساختاری کافی پیدا نشد',
    };
  }

  const [
    previousHigh,
    latestHigh,
  ] = recentHighs;

  const [
    previousLow,
    latestLow,
  ] = recentLows;

  const lastClosed = closedCandles.at(-1);

  const higherHighs =
    latestHigh.price > previousHigh.price;

  const higherLows =
    latestLow.price > previousLow.price;

  const aboveStructuralFloor =
    lastClosed.close > latestLow.price;

  let type = null;
  let explanation = '';
  let breakoutLevel = null;

  // ----------------------------------------------------------
  // 1. Established bullish trend
  // ----------------------------------------------------------

  if (
    higherHighs &&
    higherLows &&
    aboveStructuralFloor
  ) {
    type = 'ادامه روند صعودی';

    explanation =
      'سقف‌های بالاتر و کف‌های بالاتر حفظ شده‌اند؛ ' +
      'اصلاح تا این لحظه کف ساختاری را نشکسته است.';
  }

  // ----------------------------------------------------------
  // 2. Early bullish structural transition
  // ----------------------------------------------------------

  if (!type && higherLows) {
    const highBeforeHigherLow = highs
      .filter(point =>
        point.index < latestLow.index
      )
      .at(-1);

    if (
      highBeforeHigherLow &&
      lastClosed.close > highBeforeHigherLow.price
    ) {
      type = 'شروع ساختار صعودی';

      breakoutLevel =
        highBeforeHigherLow.price;

      explanation =
        'کف بالاتر شکل گرفته و قیمت با کندل بسته‌شده ' +
        'از سقف ساختاری قبلی عبور کرده است.';
    }
  }

  if (!type) {
    return {
      qualifies: false,
      reason: 'ساختار صعودی کافی تأیید نشد',
    };
  }

  // A completed daily candle closing below the latest
  // structural low means the historical structure is broken.

  if (!(lastClosed.close > latestLow.price)) {
    return {
      qualifies: false,
      reason:
        'آخرین کندل بسته‌شده زیر کف ساختاری بسته شده است',
    };
  }

  // The live price must still hold the structural floor.
  // A red daily candle alone is NOT a reason for rejection.

  if (!(liveLast > latestLow.price)) {
    return {
      qualifies: false,
      reason:
        'قیمت لحظه‌ای زیر کف ساختاری قرار دارد',
    };
  }

  const liveOpen = currentCandle?.open;
  const liveLow = currentCandle?.low;

  const liveChangePct =
    liveOpen > 0
      ? ((liveLast - liveOpen) / liveOpen) * 100
      : null;

  const floorDistancePct =
    ((liveLast - latestLow.price) / latestLow.price) * 100;

  // A wick below the floor is a warning only if price
  // has recovered above the structural floor.

  const sweptFloorIntraday =
    Number.isFinite(liveLow) &&
    liveLow < latestLow.price;

  return {
    qualifies: true,
    type,
    explanation,
    liveLast,
    liveOpen,
    liveChangePct,
    structuralFloor: latestLow.price,
    floorDistancePct,
    sweptFloorIntraday,
    breakoutLevel,
    latestHigh: latestHigh.price,
    latestLowTime: latestLow.time,
  };
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (true) {
          const index = cursor++;

          if (index >= items.length) return;

          try {
            output[index] = await worker(
              items[index],
              index
            );
          } catch (error) {
            output[index] = { error };
          }
        }
      }
    )
  );

  return output;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '—';

  return new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: 10,
  }).format(value);
}

function formatCandidate(item, index) {
  const symbol = item.symbol.replace(/_USDT$/, '');

  const liveSign =
    Number.isFinite(item.liveChangePct) &&
    item.liveChangePct >= 0
      ? '+'
      : '';

  const liveChange =
    Number.isFinite(item.liveChangePct)
      ? `${liveSign}${item.liveChangePct.toFixed(2)}%`
      : 'نامشخص';

  const warning =
    item.sweptFloorIntraday
      ? ' | ⚠️ نفوذ زیر کف و بازگشت'
      : '';

  const breakout =
    Number.isFinite(item.breakoutLevel)
      ? ` | سقف شکسته‌شده: ${formatPrice(item.breakoutLevel)}`
      : '';

  return (
    `${index + 1}) ${symbol}` +
    ` | ${item.type}` +
    ` | روز جاری: ${liveChange}` +
    ` | قیمت: ${formatPrice(item.liveLast)}` +
    ` | کف ساختاری: ${formatPrice(item.structuralFloor)}` +
    ` | فاصله تا کف: ${item.floorDistancePct.toFixed(2)}%` +
    breakout +
    warning
  );
}

async function sendTelegram(lines) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.'
    );
  }

  const messages = [];
  let current = '';

  for (const line of lines) {
    const next = current
      ? `${current}\n${line}`
      : line;

    if (
      next.length > CONFIG.TELEGRAM_SAFE_LENGTH &&
      current
    ) {
      messages.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) messages.push(current);

  for (const message of messages) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(
          CONFIG.REQUEST_TIMEOUT
        ),
      }
    );

    const result = await response
      .json()
      .catch(() => null);

    if (!response.ok || !result?.ok) {
      throw new Error(
        result?.description ||
        `Telegram HTTP ${response.status}`
      );
    }
  }
}

async function main() {
  const scanTime = Math.floor(Date.now() / 1000);

  const currentDayStart =
    Math.floor(
      scanTime / CONFIG.CANDLE_SECONDS
    ) * CONFIG.CANDLE_SECONDS;

  const scanDate =
    new Date(scanTime).toISOString();

  console.log(
    '\nGATE.IO | DAILY STRUCTURE TREND SCANNER'
  );

  console.log(`Scan time (UTC): ${scanDate}`);

  console.log(
    'Rule: completed daily structure + live price holding the latest structural low'
  );

  const [markets, tickers] = await Promise.all([
    getContracts(),
    getLiveTickers(),
  ]);

  let missingTicker = 0;
  let missingHistory = 0;
  let missingCurrentCandle = 0;
  let failed = 0;

  const results = await mapLimit(
    markets,
    CONFIG.CONCURRENCY,
    async symbol => {
      const liveLast = tickers.get(symbol);

      if (!(liveLast > 0)) {
        missingTicker++;
        return null;
      }

      const candles =
        await getDailyCandles(symbol);

      // Only fully completed daily candles are used
      // to establish the historical trend.

      const closedCandles = candles.filter(
        candle =>
          candle.time < currentDayStart
      );

      // The current UTC daily candle is kept separate.

      const currentCandle = candles.find(
        candle =>
          candle.time >= currentDayStart &&
          candle.time <
            currentDayStart + CONFIG.CANDLE_SECONDS
      ) || null;

      if (
        closedCandles.length <
        CONFIG.MIN_CLOSED_CANDLES
      ) {
        missingHistory++;
        return null;
      }

      if (!currentCandle) {
        missingCurrentCandle++;
        return null;
      }

      const analysis = analyzeStructure(
        closedCandles,
        liveLast,
        currentCandle
      );

      if (!analysis.qualifies) {
        return null;
      }

      return {
        symbol,
        ...analysis,
      };
    }
  );

  const errors = [];

  results.forEach((result, index) => {
    if (result?.error) {
      failed++;

      errors.push(
        `${markets[index]}: ` +
        String(
          result.error.message || result.error
        ).slice(0, 160)
      );
    }
  });

  const candidates = results
    .filter(
      result =>
        result &&
        !result.error &&
        result.qualifies
    )
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'ادامه روند صعودی'
          ? -1
          : 1;
      }

      return (
        a.floorDistancePct -
        b.floorDistancePct
      );
    });

  const continuationCount =
    candidates.filter(
      item =>
        item.type === 'ادامه روند صعودی'
    ).length;

  const emergingCount =
    candidates.length - continuationCount;

  console.log(
    `Active USDT perpetual markets: ${markets.length}`
  );

  console.log(
    `Live tickers received: ${tickers.size}`
  );

  console.log(
    `Bullish structures found: ${candidates.length}`
  );

  console.log(
    `Continuation: ${continuationCount} | ` +
    `New bullish structure: ${emergingCount}`
  );

  console.log(
    `Missing ticker: ${missingTicker} | ` +
    `insufficient history: ${missingHistory} | ` +
    `missing current candle: ${missingCurrentCandle} | ` +
    `errors: ${failed}`
  );

  candidates.forEach(
    (item, index) =>
      console.log(formatCandidate(item, index))
  );

  if (errors.length) {
    console.log(
      'Market errors:',
      errors.join(' || ')
    );
  }

  const header = [
    'GATE.IO | اسکنر ساختار روند صعودی روزانه',
    '━━━━━━━━━━━━━━━━━━',
    `زمان بررسی: ${scanDate}`,
    'مبنای بررسی: ساختار سقف‌ها و کف‌های روزانه بسته‌شده + حفظ کف ساختاری با قیمت لحظه‌ای',
    'کندل قرمز روز جاری به‌تنهایی باعث حذف ارز نمی‌شود.',
    '━━━━━━━━━━━━━━━━━━',
    `بازارهای فعال: ${markets.length} | ساختارهای صعودی: ${candidates.length}`,
    `ادامه روند: ${continuationCount} | شروع ساختار جدید: ${emergingCount}`,
    `فاقد تیکر: ${missingTicker} | تاریخچه ناکافی: ${missingHistory} | فاقد کندل جاری: ${missingCurrentCandle} | خطا: ${failed}`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  const body = candidates.length
    ? candidates.map(formatCandidate)
    : [
        'در زمان بررسی ساختار صعودی واجد شرایطی پیدا نشد.',
      ];

  await sendTelegram([
    ...header,
    ...body,
  ]);

  console.log('Telegram message(s) sent.');
}

main().catch(error => {
  console.error(
    'DAILY STRUCTURE SCANNER FAILED:',
    error
  );

  process.exitCode = 1;
});
