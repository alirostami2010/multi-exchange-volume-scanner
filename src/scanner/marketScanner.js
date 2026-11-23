/**
 * GATE.IO USDT PERPETUAL — DAILY PRICE-ACTION TREND SCANNER
 * ------------------------------------------------------------------
 * Independent daily-only engine.
 * Uses ONLY OHLC from fully closed daily candles.
 * Detects the current/latest price-action trend, whether newly bullish
 * or an established uptrend. No indicators, volume, BTC comparison,
 * fixed analysis lookback window, or fixed result cap.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1d',
  CANDLE_SECONDS: 86400,
  HISTORY_DAYS: 1000,
  MIN_CANDLES: 12,
  CONCURRENCY: 5,
  REQUEST_TIMEOUT: 45000,
  RETRIES: 6,
  MARKET_HISTORY_RETRIES: 2,
  REQUEST_SPACING_MS: 180,
  MAX_RETRY_DELAY_MS: 60000,
  TELEGRAM_SAFE_LENGTH: 3800,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
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
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}
function retryDelay(error, attempt) {
  if (Number(error?.status) === 429) {
    const retryAfter = Number(error?.retryAfterSeconds || 0) * 1000;
    if (retryAfter > 0) return Math.min(retryAfter, CONFIG.MAX_RETRY_DELAY_MS);
  }
  return Math.min((Number(error?.status) >= 500 ? 2500 : 1500) * 2 ** (attempt - 1), CONFIG.MAX_RETRY_DELAY_MS);
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
        const error = new Error(`Gate.io HTTP ${response.status}: ${body}`);
        error.status = response.status;
        error.retryAfterSeconds = Number(response.headers.get('retry-after') || 0);
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= CONFIG.RETRIES || !isRetryableError(error)) break;
      const delay = retryDelay(error, attempt);
      console.warn(`[API RETRY ${attempt}/${CONFIG.RETRIES - 1}] ${error.message}; wait ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastError;
}
const n = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const pct = (a, b) => b > 0 ? (a / b - 1) * 100 : 0;
const round = (v, digits = 2) => Number(v.toFixed(digits));

async function getContracts() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contracts`);
}
function isSupportedCryptoContract(contract) {
  const name = String(contract?.name ?? '').trim().toUpperCase();
  const type = String(contract?.contract_type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const active = String(contract?.status ?? '').toLowerCase() === 'trading' && contract?.in_delisting !== true;
  if (!active || !/^[A-Z0-9]{2,30}_USDT$/.test(name)) return false;
  return !type || CONFIG.ALLOWED_CRYPTO_CONTRACT_TYPES.has(type);
}
function normalizeCandle(x) {
  return { time: n(x.t), open: n(x.o), high: n(x.h), low: n(x.l), close: n(x.c) };
}
function validCandle(c) {
  return c.time > 0 && c.open > 0 && c.high >= c.low && c.low > 0 && c.close > 0 &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}
async function getClosedDailyCandles(symbol) {
  const currentDay = Math.floor(Date.now() / 1000 / CONFIG.CANDLE_SECONDS) * CONFIG.CANDLE_SECONDS;
  const oldest = currentDay - CONFIG.HISTORY_DAYS * CONFIG.CANDLE_SECONDS;
  const params = new URLSearchParams({
    contract: symbol,
    interval: CONFIG.TIMEFRAME,
    from: String(oldest),
    to: String(currentDay - 1),
  });
  const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
  if (!Array.isArray(raw)) throw new Error(`Invalid daily candle response: ${symbol}`);
  const byTime = new Map();
  for (const item of raw) {
    const c = normalizeCandle(item);
    if (validCandle(c) && c.time < currentDay && c.time >= oldest) byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
async function getDailyWithRetry(symbol) {
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.MARKET_HISTORY_RETRIES; attempt++) {
    try { return await getClosedDailyCandles(symbol); }
    catch (error) {
      lastError = error;
      if (attempt >= CONFIG.MARKET_HISTORY_RETRIES || !isRetryableError(error)) break;
      const delay = Math.min(3000 * 2 ** attempt, CONFIG.MAX_RETRY_DELAY_MS);
      console.warn(`[HISTORY RETRY] ${symbol} ${attempt + 1}/${CONFIG.MARKET_HISTORY_RETRIES}: ${error.message}`);
      await sleep(delay);
    }
  }
  throw lastError;
}
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = await worker(items[i], i); }
      catch (error) { out[i] = { error }; }
    }
  }));
  return out;
}

/*
 * Adaptive swing extraction:
 * - No fixed N-candle pivot window and no fixed percentage reversal threshold.
 * - Track the most extreme wick during the active leg.
 * - Confirm a turn when a later CLOSED candle closes beyond the immediately
 *   preceding candle's opposite extreme. The confirmed extreme becomes a swing.
 * - All available chronological history is processed; no trailing slice is used.
 */
function extractAdaptiveSwings(candles) {
  if (candles.length < 3) return [];
  const swings = [];
  let direction = 0; // 1 rising leg, -1 falling leg, 0 not established
  let extremeIndex = 0;
  let extremePrice = candles[0].high;
  let previousExtremeIndex = -1;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];

    if (direction === 0) {
      if (c.high > extremePrice) { extremePrice = c.high; extremeIndex = i; }
      if (c.low < candles[extremeIndex].low) {
        direction = -1;
        extremePrice = c.low;
        extremeIndex = i;
      } else if (c.close > prev.high) {
        direction = 1;
        extremePrice = c.high;
        extremeIndex = i;
      } else if (c.close < prev.low) {
        direction = -1;
        extremePrice = c.low;
        extremeIndex = i;
      }
      continue;
    }

    if (direction === 1) {
      if (c.high > extremePrice) { extremePrice = c.high; extremeIndex = i; }
      if (c.close < prev.low) {
        if (extremeIndex > previousExtremeIndex) {
          swings.push({ type: 'high', index: extremeIndex, value: extremePrice });
          previousExtremeIndex = extremeIndex;
        }
        direction = -1;
        extremePrice = c.low;
        extremeIndex = i;
      }
    } else {
      if (c.low < extremePrice) { extremePrice = c.low; extremeIndex = i; }
      if (c.close > prev.high) {
        if (extremeIndex > previousExtremeIndex) {
          swings.push({ type: 'low', index: extremeIndex, value: extremePrice });
          previousExtremeIndex = extremeIndex;
        }
        direction = 1;
        extremePrice = c.high;
        extremeIndex = i;
      }
    }
  }

  // Include the currently developing leg's extreme for context, but mark it unconfirmed.
  if (extremeIndex > previousExtremeIndex) {
    swings.push({ type: direction === 1 ? 'high' : 'low', index: extremeIndex, value: extremePrice, developing: true });
  }
  return swings.sort((a, b) => a.index - b.index);
}
function getAlternatingSwings(swings) {
  const out = [];
  for (const swing of swings) {
    const last = out.at(-1);
    if (!last || last.type !== swing.type) out.push(swing);
    else if ((swing.type === 'high' && swing.value > last.value) || (swing.type === 'low' && swing.value < last.value)) out[out.length - 1] = swing;
  }
  return out;
}
function analyzeDaily(symbol, candles) {
  if (candles.length < CONFIG.MIN_CANDLES) return null;
  const swings = getAlternatingSwings(extractAdaptiveSwings(candles));
  const confirmed = swings.filter(s => !s.developing);
  const highs = confirmed.filter(s => s.type === 'high');
  const lows = confirmed.filter(s => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHighs = highs.slice(-3);
  const lastLows = lows.slice(-3);
  const higherHighs = lastHighs.length >= 2 && lastHighs.at(-1).value > lastHighs.at(-2).value;
  const higherLows = lastLows.length >= 2 && lastLows.at(-1).value > lastLows.at(-2).value;
  const lowerHighs = lastHighs.length >= 2 && lastHighs.at(-1).value < lastHighs.at(-2).value;
  const lowerLows = lastLows.length >= 2 && lastLows.at(-1).value < lastLows.at(-2).value;

  const last = candles.at(-1);
  const previousHigh = highs.at(-1);
  const previousLow = lows.at(-1);
  const closeAboveLastSwingHigh = last.close > previousHigh.value;
  const closeBelowLastSwingLow = last.close < previousLow.value;
  const latestSwingIndex = Math.max(previousHigh.index, previousLow.index);
  const barsSinceLatestSwing = candles.length - 1 - latestSwingIndex;

  // The last price-action leg must be bullish, not merely contain old higher pivots.
  const bullishStructure = higherHighs && higherLows;
  const newlyBullish = closeAboveLastSwingHigh && higherLows && !closeBelowLastSwingLow;
  const establishedBullish = bullishStructure && !closeBelowLastSwingLow;

  let state = 'NOT_BULLISH';
  if (newlyBullish && !bullishStructure) state = 'NEWLY_BULLISH';
  else if (bullishStructure && establishedBullish) state = 'ESTABLISHED_BULLISH';
  else if (newlyBullish) state = 'NEWLY_BULLISH';

  // A pullback remains inside an uptrend only while the latest confirmed swing low holds.
  const activeUptrend = state !== 'NOT_BULLISH' && last.close >= previousLow.value;
  if (!activeUptrend) state = 'NOT_BULLISH';

  const recentMovePct = pct(last.close, candles[Math.max(0, latestSwingIndex)].close);
  const lastHighValue = previousHigh.value;
  const lastLowValue = previousLow.value;
  const structureText = `${higherHighs ? 'HH' : lowerHighs ? 'LH' : 'H?'} / ${higherLows ? 'HL' : lowerLows ? 'LL' : 'L?'}`;

  return {
    symbol,
    bullish: state !== 'NOT_BULLISH',
    state,
    metrics: {
      candleCount: candles.length,
      close: last.close,
      structureText,
      higherHighs,
      higherLows,
      lowerHighs,
      lowerLows,
      lastSwingHigh: lastHighValue,
      lastSwingLow: lastLowValue,
      barsSinceLatestSwing,
      closeAboveLastSwingHigh,
      closeBelowLastSwingLow,
      recentMovePct,
      lastCandleTime: last.time,
      latestSwingType: swings.at(-1)?.type || 'unknown',
    },
  };
}
function formatCandidate(item, index) {
  const m = item.metrics;
  const label = item.state === 'NEWLY_BULLISH' ? 'تازه وارد ساختار صعودی شده' : 'روند صعودی ادامه‌دار';
  return [
    `${index + 1}) ${item.symbol.replace(/_USDT$/, '')}`,
    `وضعیت: ${label}`,
    `ساختار آخرین سقف/کف‌ها: ${m.structureText}`,
    `آخرین سقف تأییدشده: ${m.lastSwingHigh} | آخرین کف تأییدشده: ${m.lastSwingLow}`,
    `کندل از آخرین چرخش تأییدشده: ${m.barsSinceLatestSwing} | نوع آخرین چرخش: ${m.latestSwingType === 'high' ? 'سقف' : 'کف'}`,
    `بسته‌شدن بالای آخرین سقف: ${m.closeAboveLastSwingHigh ? 'بله' : 'خیر'} | شکست آخرین کف: ${m.closeBelowLastSwingLow ? 'بله' : 'خیر'}`,
  ].join('\n');
}
async function sendTelegram(lines) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
  const messages = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > CONFIG.TELEGRAM_SAFE_LENGTH && current) {
      messages.push(current);
      current = line;
    } else current = next;
  }
  if (current) messages.push(current);
  for (const message of messages) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`);
  }
}

async function main() {
  console.log('\nGATE.IO | DAILY PRICE-ACTION TREND SCANNER');
  console.log('Only closed daily OHLC candles | adaptive swing detection | no indicators, volume, BTC comparison, or fixed analysis window');
  const contracts = await getContracts();
  if (!Array.isArray(contracts)) throw new Error('Invalid Gate.io contracts response.');
  const markets = contracts.filter(isSupportedCryptoContract).map(c => c.name).sort();
  let analyzedCount = 0, insufficient = 0, candleTotal = 0, failed = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async symbol => {
    const candles = await getDailyWithRetry(symbol);
    if (candles.length < CONFIG.MIN_CANDLES) { insufficient++; return null; }
    analyzedCount++;
    candleTotal += candles.length;
    return analyzeDaily(symbol, candles);
  });
  const errors = [];
  results.forEach((r, i) => { if (r?.error) { failed++; errors.push(`${markets[i]}: ${String(r.error.message || r.error).slice(0, 180)}`); } });
  const analyzed = results.filter(r => r && !r.error);
  const newlyBullish = analyzed.filter(r => r.bullish && r.state === 'NEWLY_BULLISH');
  const established = analyzed.filter(r => r.bullish && r.state === 'ESTABLISHED_BULLISH');
  const candidates = [...newlyBullish, ...established].sort((a, b) => {
    if (a.state !== b.state) return a.state === 'NEWLY_BULLISH' ? -1 : 1;
    return b.metrics.barsSinceLatestSwing - a.metrics.barsSinceLatestSwing || a.symbol.localeCompare(b.symbol);
  });

  console.log(`Active crypto perpetuals: ${markets.length}`);
  console.log(`Markets analyzed: ${analyzedCount} | insufficient daily history: ${insufficient} | errors: ${failed}`);
  console.log(`Closed daily candles processed: ${candleTotal}`);
  console.log(`Newly bullish: ${newlyBullish.length} | established bullish: ${established.length} | total bullish: ${candidates.length}`);
  for (const item of candidates) console.log(`${item.symbol} | ${item.state} | ${item.metrics.structureText} | barsSinceSwing=${item.metrics.barsSinceLatestSwing}`);
  if (errors.length) console.log('Market errors:', errors.join(' || '));

  const header = [
    'GATE.IO | DAILY PRICE-ACTION TREND SCANNER',
    'فقط کندل‌های روزانه کاملاً بسته‌شده | فقط OHLC',
    'بدون اندیکاتور، حجم، مقایسه با BTC یا محدودیت پنجره تحلیل',
    `بازارهای بررسی‌شده: ${analyzedCount} از ${markets.length} | خطا: ${failed}`,
    `تازه صعودی‌شده: ${newlyBullish.length} | صعودی ادامه‌دار: ${established.length} | مجموع: ${candidates.length}`,
    '━━━━━━━━━━━━━━━━━━',
  ];
  const body = candidates.length ? candidates.map(formatCandidate) : ['در این بررسی ساختار صعودی تأییدشده‌ای پیدا نشد.'];
  await sendTelegram([...header, ...body]);
  console.log('Telegram message(s) sent.');
}

main().catch(error => { console.error('DAILY SCANNER FAILED:', error); process.exitCode = 1; });
