/**
 * GATE.IO USDT PERPETUAL — DAILY BULLISH STRUCTURE SCANNER
 * ------------------------------------------------------------------
 * Independent daily-timeframe engine.
 * - Daily candles only; excludes the currently forming daily candle.
 * - Uses price structure and daily EMA/RSI context; no volume, no BTC comparison.
 * - Finds established bullish trends and early confirmed bullish transitions.
 * - Ranking score is a relative quality score, not a probability or trade signal.
 * - No entries, targets, or financial guarantees.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1d',
  CANDLE_SECONDS: 86400,
  PAGE_SIZE: 1000,
  HISTORY_DAYS: 420,
  MIN_CANDLES: 230,
  EMA_FAST: 50,
  EMA_SLOW: 200,
  RSI_PERIOD: 14,
  PIVOT_LEFT: 2,
  PIVOT_RIGHT: 2,
  CONCURRENCY: 5,
  REQUEST_TIMEOUT: 45000,
  RETRIES: 6,
  MARKET_HISTORY_RETRIES: 2,
  REQUEST_SPACING_MS: 180,
  MAX_RETRY_DELAY_MS: 60000,
  MAX_RESULTS: 15,
  MIN_SCORE: 55,
  MAX_DAILY_RISE_7D: 28,
  MAX_DAILY_RISE_30D: 75,
  MAX_DISTANCE_FROM_20D_LOW: 45,
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
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
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
    // A daily candle is accepted only after its UTC daily bucket has ended.
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

function ema(values, period) {
  if (values.length < period) return [];
  const alpha = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  const out = new Array(values.length).fill(null);
  out[period - 1] = value;
  for (let i = period; i < values.length; i++) {
    value = values[i] * alpha + value * (1 - alpha);
    out[i] = value;
  }
  return out;
}
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function findPivots(candles, type) {
  const out = [];
  const l = CONFIG.PIVOT_LEFT, r = CONFIG.PIVOT_RIGHT;
  for (let i = l; i < candles.length - r; i++) {
    const v = candles[i][type];
    let valid = true;
    for (let j = i - l; j <= i + r; j++) {
      if (j === i) continue;
      if (type === 'high' ? candles[j][type] >= v : candles[j][type] <= v) { valid = false; break; }
    }
    if (valid) out.push({ index: i, value: v });
  }
  return out;
}
function isRisingPair(points) {
  return points.length >= 2 && points.at(-1).value > points.at(-2).value;
}
function isFallingPair(points) {
  return points.length >= 2 && points.at(-1).value < points.at(-2).value;
}
function analyzeDaily(symbol, candles) {
  if (candles.length < CONFIG.MIN_CANDLES) return null;
  const closes = candles.map(c => c.close);
  const fast = ema(closes, CONFIG.EMA_FAST);
  const slow = ema(closes, CONFIG.EMA_SLOW);
  const i = candles.length - 1;
  const last = candles[i], prev = candles[i - 1];
  const e50 = fast[i], e200 = slow[i];
  const e50Prev10 = fast[i - 10], e200Prev20 = slow[i - 20];
  const rsiNow = rsi(closes, CONFIG.RSI_PERIOD);
  const highs = findPivots(candles.slice(-100), 'high');
  const lows = findPivots(candles.slice(-100), 'low');
  const highPair = highs.slice(-2), lowPair = lows.slice(-2);
  const higherHighs = isRisingPair(highPair);
  const higherLows = isRisingPair(lowPair);
  const lowerHighs = isFallingPair(highPair);
  const lowerLows = isFallingPair(lowPair);
  const closeAbove50 = last.close > e50;
  const closeAbove200 = last.close > e200;
  const emaBullStack = e50 > e200;
  const ema50Rising = e50 > e50Prev10;
  const ema200Rising = e200 > e200Prev20;
  const trendEstablished = emaBullStack && closeAbove50 && ema50Rising && (higherHighs || higherLows);

  // Early transition: require a meaningful close above a recent confirmed swing high,
  // with a rising/defended swing-low structure. Weakening sellers alone is not enough.
  const priorHighs = highs.filter(p => p.index < highs.at(-1)?.index);
  const lastConfirmedHigh = priorHighs.at(-1);
  const breakoutAboveSwing = Boolean(lastConfirmedHigh && last.close > lastConfirmedHigh.value && prev.close <= lastConfirmedHigh.value * 1.01);
  const recentLow = lows.at(-1);
  const priorLow = lows.at(-2);
  const lowStructureImproving = Boolean(recentLow && priorLow && recentLow.value > priorLow.value);
  const transition = breakoutAboveSwing && lowStructureImproving && closeAbove50 && ema50Rising;

  // A sustained close above the 30-day range ceiling is an alternate bullish confirmation.
  const range30 = candles.slice(-31, -1);
  const rangeHigh30 = Math.max(...range30.map(c => c.high));
  const rangeBreakout = last.close > rangeHigh30 && closeAbove50 && ema50Rising && rsiNow >= 52;

  const ret7 = pct(last.close, candles[i - 7].close);
  const ret30 = pct(last.close, candles[i - 30].close);
  const low20 = Math.min(...candles.slice(-20).map(c => c.low));
  const distanceFrom20Low = pct(last.close, low20);
  const dailyRangePct = (last.high - last.low) / last.close * 100;
  const notOverextended = ret7 <= CONFIG.MAX_DAILY_RISE_7D && ret30 <= CONFIG.MAX_DAILY_RISE_30D &&
    distanceFrom20Low <= CONFIG.MAX_DISTANCE_FROM_20D_LOW && dailyRangePct < 18;
  const bullishClose = last.close > last.open && (last.close - last.low) / Math.max(last.high - last.low, 1e-12) >= 0.55;

  let phase = 'NONE';
  if (transition) phase = 'EARLY_BULLISH_TRANSITION';
  else if (rangeBreakout) phase = 'DAILY_RANGE_BREAKOUT';
  else if (trendEstablished) phase = 'ESTABLISHED_UPTREND';

  const structuralQuality = (higherHighs ? 12 : 0) + (higherLows ? 14 : 0) +
    (emaBullStack ? 12 : 0) + (ema50Rising ? 8 : 0) + (ema200Rising ? 5 : 0) +
    (closeAbove50 ? 8 : 0) + (closeAbove200 ? 6 : 0);
  const momentumQuality = (rsiNow >= 52 && rsiNow <= 68 ? 8 : rsiNow > 68 && rsiNow <= 74 ? 3 : 0) +
    (bullishClose ? 5 : 0) + (rangeBreakout ? 8 : 0) + (transition ? 8 : 0);
  const freshnessPenalty = Math.max(0, ret7 - 12) * 0.8 + Math.max(0, ret30 - 35) * 0.25 + Math.max(0, distanceFrom20Low - 25) * 0.35;
  const score = Math.round(clamp(structuralQuality + momentumQuality - freshnessPenalty, 0, 100));
  const phaseMinimum = phase === 'EARLY_BULLISH_TRANSITION' ? 42 :
    phase === 'DAILY_RANGE_BREAKOUT' ? 50 : CONFIG.MIN_SCORE;
  const qualifies = phase !== 'NONE' && notOverextended && score >= phaseMinimum &&
    !(lowerHighs && lowerLows && !transition && !rangeBreakout);

  return {
    symbol,
    bullishCandidate: qualifies,
    bullishScore: qualifies ? score : 0,
    phase,
    metrics: {
      candles: candles.length, close: last.close, ema50: e50, ema200: e200, rsi: rsiNow,
      higherHighs, higherLows, lowerHighs, lowerLows, emaBullStack, ema50Rising, ema200Rising,
      closeAbove50, closeAbove200, ret7, ret30, distanceFrom20Low, dailyRangePct,
      rangeHigh30, breakoutAboveSwing, lowStructureImproving, notOverextended,
    },
  };
}
function formatCandidate(item, index) {
  const m = item.metrics;
  const label = {
    EARLY_BULLISH_TRANSITION: 'تغییر ساختار به صعودی',
    DAILY_RANGE_BREAKOUT: 'شکست سقف محدوده ۳۰روزه',
    ESTABLISHED_UPTREND: 'روند صعودی تثبیت‌شده',
  }[item.phase] || item.phase;
  return [
    `${index + 1}) ${item.symbol.replace(/_USDT$/, '')} | امتیاز ساختار: ${item.bullishScore}/100`,
    `وضعیت: ${label}`,
    `EMA50/200: ${m.ema50.toPrecision(7)} / ${m.ema200.toPrecision(7)} | RSI14: ${m.rsi.toFixed(1)}`,
    `سقف بالاتر: ${m.higherHighs ? 'بله' : 'خیر'} | کف بالاتر: ${m.higherLows ? 'بله' : 'خیر'} | EMA50 صعودی: ${m.ema50Rising ? 'بله' : 'خیر'}`,
    `بازده ۷روزه: ${m.ret7.toFixed(1)}% | ۳۰روزه: ${m.ret30.toFixed(1)}% | فاصله از کف ۲۰روزه: ${m.distanceFrom20Low.toFixed(1)}%`,
  ].join('\n');
}
async function sendTelegram(lines) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`);
}

async function main() {
  console.log('\nGATE.IO | DAILY BULLISH STRUCTURE SCANNER');
  console.log('Daily candles only | closed candles only | price structure + EMA/RSI | no volume | no BTC comparison');
  console.log('Detects early confirmed bullish transitions and established daily uptrends; not entry signals.');
  const contracts = await getContracts();
  if (!Array.isArray(contracts)) throw new Error('Invalid Gate.io contracts response.');
  const markets = contracts.filter(isSupportedCryptoContract).map(c => c.name).sort();
  let checked = 0, insufficient = 0, candleTotal = 0, failed = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async symbol => {
    const candles = await getDailyWithRetry(symbol);
    if (candles.length < CONFIG.MIN_CANDLES) { insufficient++; return null; }
    checked++; candleTotal += candles.length;
    return analyzeDaily(symbol, candles);
  });
  const errors = [];
  results.forEach((r, i) => { if (r?.error) { failed++; errors.push(`${markets[i]}: ${String(r.error.message || r.error).slice(0, 180)}`); } });
  const analyzed = results.filter(r => r && !r.error);
  const candidates = analyzed.filter(r => r.bullishCandidate).sort((a, b) =>
    b.bullishScore - a.bullishScore ||
    Number(b.metrics.higherLows) - Number(a.metrics.higherLows) ||
    a.metrics.ret7 - b.metrics.ret7 || a.symbol.localeCompare(b.symbol));
  const selected = candidates.slice(0, CONFIG.MAX_RESULTS);
  console.log(`Active crypto perpetuals: ${markets.length}`);
  console.log(`Markets analyzed: ${checked} | insufficient daily history: ${insufficient} | errors: ${failed}`);
  console.log(`Closed daily candles processed: ${candleTotal}`);
  console.log(`Bullish candidates: ${candidates.length} | selected: ${selected.length}`);
  const phaseCounts = analyzed.reduce((acc, r) => { acc[r.phase] = (acc[r.phase] || 0) + 1; return acc; }, {});
  console.log('Phase counts:', JSON.stringify(phaseCounts));
  for (const item of candidates) {
    const m = item.metrics;
    console.log(`${item.symbol} | score=${item.bullishScore} | phase=${item.phase} | HH=${m.higherHighs} HL=${m.higherLows} | EMA50>200=${m.emaBullStack} | RSI=${m.rsi.toFixed(1)} | 7d=${m.ret7.toFixed(1)}% | 30d=${m.ret30.toFixed(1)}%`);
  }
  if (errors.length) console.log('Market errors:', errors.join(' || '));
  if (selected.length) {
    await sendTelegram([
      'GATE.IO | DAILY BULLISH STRUCTURE SCANNER',
      'فقط تایم‌فریم روزانه و کندل‌های کاملاً بسته‌شده',
      'ساختار قیمت + EMA50/EMA200 + RSI | بدون حجم و بدون مقایسه با BTC',
      'امتیاز، رتبه نسبی کیفیت ساختار است؛ نه درصد احتمال و نه سیگنال ورود',
      '━━━━━━━━━━━━━━━━━━',
      ...selected.map(formatCandidate),
    ]);
    console.log('Telegram message sent.');
  } else console.log('No daily bullish structure met the configured quality and freshness filters; no Telegram sent.');
}

main().catch(error => { console.error('DAILY SCANNER FAILED:', error); process.exitCode = 1; });
