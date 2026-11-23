/**
 * GATE.IO USDT PERPETUAL — LIVE BUY-VOLUME ACCELERATION RADAR
 * ---------------------------------------------------------
 * Destination in the existing project: src/scanner/marketScanner.js
 * Node.js 20+ | Public Gate.io API | No order execution
 *
 * Volume-only engine:
 * - Scans active USDT perpetual contracts with sufficient 24h quote turnover.
 * - Reads signed public futures trades for the CURRENT, still-open 1h candle.
 * - Positive trade size is treated as buyer-initiated; negative as seller-initiated.
 * - Converts contract size to quote notional with quanto_multiplier.
 * - Measures buy/sell notional, buy share, net delta, recent buy velocity,
 *   acceleration and minute-by-minute persistence.
 * - Does not use candle direction, trend, RSI, moving averages, price structure,
 *   BTC direction, order book, or entry/target calculations.
 * - Stores reports through the existing marketStorage interface.
 *
 * Important data limitation:
 * The REST trades endpoint returns at most the requested recent records (1000 here).
 * If a contract trades more than 1000 times during the current hour, the report
 * marks the sample as truncated and does not pretend the sampled totals represent
 * the complete hour. Recent 3-minute velocity remains the primary live measure.
 */

import 'dotenv/config';
import { saveMarketSnapshot } from '../storage/marketStorage.js';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  SETTLE: 'usdt',
  MIN_QUOTE_VOLUME_24H: Number(process.env.MIN_QUOTE_VOLUME_24H ?? 75000),
  TRADE_LIMIT: 1000,
  TOP_COUNT: 25,
  CONCURRENCY: 6,
  REQUEST_SPACING_MS: 100,
  REQUEST_TIMEOUT_MS: 15000,
  RETRIES: 4,
  TELEGRAM_MAX_LENGTH: 3800,
  // A report needs actual recent activity, not only a high percentage on tiny volume.
  MIN_RECENT_BUY_NOTIONAL: Number(process.env.MIN_RECENT_BUY_NOTIONAL ?? 1500),
  MIN_BUY_SHARE: Number(process.env.MIN_BUY_SHARE ?? 56),
  MIN_BUY_RATE_MULTIPLE: Number(process.env.MIN_BUY_RATE_MULTIPLE ?? 1.35),
  MIN_SCORE_TO_REPORT: Number(process.env.MIN_SCORE_TO_REPORT ?? 48),
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const num = value => {
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
};
const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round = (x, d = 2) => Number.isFinite(x) ? Number(x.toFixed(d)) : null;
const fmt = (x, d = 2) => Number.isFinite(x) ? x.toFixed(d) : '—';
const positive = x => Number.isFinite(x) && x > 0;

let lastRequestAt = 0;
let requestQueue = Promise.resolve();

async function requestGate(path, params = {}) {
  const url = new URL(`${CONFIG.API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const slot = requestQueue.then(async () => {
    const wait = CONFIG.REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  requestQueue = slot.catch(() => {});
  await slot;

  let lastError;
  for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      const body = await response.text().catch(() => '');
      const error = new Error(`Gate ${response.status} ${path}: ${body.slice(0, 160)}`);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after') || 0);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === CONFIG.RETRIES || (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status))) break;
    }
    const delay = lastError?.status === 429 && lastError.retryAfter > 0
      ? Math.min(lastError.retryAfter * 1000, 30000)
      : Math.min(600 * (2 ** attempt), 10000);
    await sleep(delay);
  }
  throw lastError || new Error(`Gate request failed: ${path}`);
}

async function mapPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { out[index] = await worker(items[index], index); }
      catch (error) { out[index] = { __error: error?.message || String(error) }; }
    }
  }));
  return out;
}

function tradeNotional(trade, multiplier) {
  const size = num(trade.size);
  const price = num(trade.price);
  if (size == null || price == null || !positive(price)) return null;
  // Gate USDT linear contracts: one contract represents quanto_multiplier units
  // of the base asset; multiplying by trade price gives quote-currency notional.
  const contractMultiplier = positive(multiplier) ? multiplier : 1;
  return { signedSize: size, notional: Math.abs(size) * contractMultiplier * price, time: num(trade.create_time_ms) != null ? num(trade.create_time_ms) : num(trade.create_time) };
}

function aggregateTrades(trades, multiplier, hourStart, nowSeconds) {
  const buckets = new Map();
  let buyHour = 0, sellHour = 0, validTrades = 0;
  let oldestTime = Infinity;
  for (const trade of trades || []) {
    const item = tradeNotional(trade, multiplier);
    if (!item || item.time == null) continue;
    if (item.time < hourStart || item.time > nowSeconds + 2) continue;
    validTrades++;
    oldestTime = Math.min(oldestTime, item.time);
    const minute = Math.floor(item.time / 60) * 60;
    const bucket = buckets.get(minute) || { buy: 0, sell: 0, count: 0 };
    if (item.signedSize > 0) {
      buyHour += item.notional;
      bucket.buy += item.notional;
    } else if (item.signedSize < 0) {
      sellHour += item.notional;
      bucket.sell += item.notional;
    }
    bucket.count++;
    buckets.set(minute, bucket);
  }

  const currentMinute = Math.floor(nowSeconds / 60) * 60;
  const minuteValue = minute => buckets.get(minute) || { buy: 0, sell: 0, count: 0 };
  const sumWindow = (start, end, key) => {
    let total = 0;
    for (let t = start; t < end; t += 60) total += minuteValue(t)[key];
    return total;
  };
  const last3Start = currentMinute - 2 * 60;
  const prev3Start = currentMinute - 5 * 60;
  const prior3Start = currentMinute - 8 * 60;
  const buyLast3 = sumWindow(last3Start, currentMinute + 60, 'buy');
  const sellLast3 = sumWindow(last3Start, currentMinute + 60, 'sell');
  const buyPrev3 = sumWindow(prev3Start, last3Start, 'buy');
  const sellPrev3 = sumWindow(prev3Start, last3Start, 'sell');
  const buyPrior3 = sumWindow(prior3Start, prev3Start, 'buy');

  const buyRateLast = buyLast3 / 3;
  const buyRatePrev = buyPrev3 / 3;
  const buyRatePrior = buyPrior3 / 3;
  const rateMultiple = buyRatePrev > 0 ? buyRateLast / buyRatePrev : (buyRateLast > 0 ? Infinity : 0);
  const priorMultiple = buyRatePrior > 0 ? buyRatePrev / buyRatePrior : 0;
  const acceleration = Number.isFinite(rateMultiple) && priorMultiple > 0 ? rateMultiple - priorMultiple : null;
  const totalHour = buyHour + sellHour;
  const recentTotal = buyLast3 + sellLast3;
  const buyShareHour = totalHour > 0 ? buyHour / totalHour * 100 : 0;
  const buyShareRecent = recentTotal > 0 ? buyLast3 / recentTotal * 100 : 0;
  const deltaHour = buyHour - sellHour;
  const deltaRecent = buyLast3 - sellLast3;

  const activeRecentMinutes = [];
  for (let t = last3Start; t <= currentMinute; t += 60) {
    const b = minuteValue(t);
    activeRecentMinutes.push({ buy: b.buy, sell: b.sell, total: b.buy + b.sell });
  }
  const positiveBuyMinutes = activeRecentMinutes.filter(x => x.buy > 0).length;
  const persistence = positiveBuyMinutes / activeRecentMinutes.length * 100;
  const elapsedSeconds = Math.max(1, nowSeconds - hourStart);
  const coverageSeconds = Number.isFinite(oldestTime) ? Math.max(0, nowSeconds - oldestTime) : 0;
  const truncated = (trades || []).length >= CONFIG.TRADE_LIMIT;
  const coveragePct = truncated
    ? Math.min(100, coverageSeconds / elapsedSeconds * 100)
    : (Number.isFinite(oldestTime) ? Math.min(100, (nowSeconds - hourStart) / elapsedSeconds * 100) : 0);

  return {
    buyHour, sellHour, totalHour, buyShareHour, deltaHour,
    buyLast3, sellLast3, recentTotal, buyShareRecent, deltaRecent,
    buyRateLast, buyRatePrev, buyRatePrior, rateMultiple, acceleration,
    persistence, positiveBuyMinutes, validTrades, oldestTime,
    truncated, coveragePct: round(coveragePct, 0),
  };
}

function scoreVolume(m) {
  let score = 0;
  score += clamp((m.buyShareRecent - 50) * 1.25, 0, 25);
  score += clamp((m.buyShareHour - 50) * 0.45, 0, 12);
  if (Number.isFinite(m.rateMultiple)) score += clamp((m.rateMultiple - 1) * 18, 0, 27);
  else if (m.buyRateLast > 0) score += 12;
  if (Number.isFinite(m.acceleration)) score += clamp((m.acceleration + 0.15) * 18, 0, 12);
  score += clamp(m.persistence * 0.18, 0, 12);
  if (m.deltaRecent > 0) score += 6;
  return clamp(score, 0, 100);
}

function classify(m, score) {
  const buyShareStrong = m.buyShareRecent >= CONFIG.MIN_BUY_SHARE;
  const buyFlowStrong = m.buyLast3 >= CONFIG.MIN_RECENT_BUY_NOTIONAL;
  const accelerationStrong = m.rateMultiple >= CONFIG.MIN_BUY_RATE_MULTIPLE || (m.rateMultiple === Infinity && m.buyLast3 > 0);
  const deltaPositive = m.deltaRecent > 0;
  if (buyShareStrong && buyFlowStrong && accelerationStrong && deltaPositive && score >= CONFIG.MIN_SCORE_TO_REPORT) {
    return { status: 'BUY_ACCELERATING', label: 'شتاب ورود خرید تهاجمی' };
  }
  if (m.buyShareRecent >= 53 && m.buyLast3 >= CONFIG.MIN_RECENT_BUY_NOTIONAL * 0.5 && m.deltaRecent > 0) {
    return { status: 'BUY_BUILDING', label: 'افزایش اولیه فعالیت خریداران؛ نیازمند تداوم' };
  }
  return null;
}

function analyzeMarket(market, trades, nowSeconds) {
  const multiplier = num(market.contract.quanto_multiplier);
  if (!positive(multiplier)) return { symbol: market.symbol, __error: 'quanto_multiplier نامعتبر است' };
  const hourStart = Math.floor(nowSeconds / 3600) * 3600;
  const metrics = aggregateTrades(trades, multiplier, hourStart, nowSeconds);
  if (!metrics.validTrades || metrics.recentTotal <= 0) return null;
  const score = scoreVolume(metrics);
  const classification = classify(metrics, score);
  if (!classification) return null;
  const ticker = market.ticker;
  const result = {
    symbol: market.symbol,
    contract: market.symbol,
    score: round(score, 1),
    rankScore: round(score, 1),
    status: classification.status,
    statusLabel: classification.label,
    price: num(ticker.last),
    change24h: num(ticker.change_percentage),
    quoteVolume24h: num(ticker.volume_24h_quote),
    currentHour: {
      buyNotional: round(metrics.buyHour, 2),
      sellNotional: round(metrics.sellHour, 2),
      buySharePct: round(metrics.buyShareHour, 1),
      netDelta: round(metrics.deltaHour, 2),
      sampleCoveragePct: metrics.coveragePct,
      sampleTruncated: metrics.truncated,
    },
    recent3m: {
      buyNotional: round(metrics.buyLast3, 2),
      sellNotional: round(metrics.sellLast3, 2),
      buySharePct: round(metrics.buyShareRecent, 1),
      netDelta: round(metrics.deltaRecent, 2),
      buyNotionalPerMinute: round(metrics.buyRateLast, 2),
      previousBuyNotionalPerMinute: round(metrics.buyRatePrev, 2),
      buyRateMultiple: Number.isFinite(metrics.rateMultiple) ? round(metrics.rateMultiple, 2) : null,
      buyAcceleration: Number.isFinite(metrics.acceleration) ? round(metrics.acceleration, 2) : null,
      persistencePct: round(metrics.persistence, 0),
      activeBuyMinutes: metrics.positiveBuyMinutes,
    },
    tradesObserved: metrics.validTrades,
    dataQuality: metrics.truncated ? 'LIMIT_REACHED_RECENT_SAMPLE' : 'REST_SAMPLE',
    reasons: [
      metrics.buyShareRecent >= CONFIG.MIN_BUY_SHARE ? `سهم خرید تهاجمی سه دقیقه اخیر ${fmt(metrics.buyShareRecent, 1)}٪` : null,
      metrics.rateMultiple >= CONFIG.MIN_BUY_RATE_MULTIPLE ? `سرعت خرید ${fmt(metrics.rateMultiple, 2)} برابر بازه سه دقیقه قبل` : null,
      metrics.deltaRecent > 0 ? 'دلتا خرید سه دقیقه اخیر مثبت است' : null,
      metrics.persistence >= 60 ? `خرید در ${fmt(metrics.persistence, 0)}٪ دقایق اخیر فعال بوده` : null,
      metrics.truncated ? 'توجه: سقف ۱۰۰۰ معامله دریافت‌شده؛ جمع کل ساعت ممکن است ناقص باشد' : null,
    ].filter(Boolean),
    _sort: { score, rateMultiple: metrics.rateMultiple, buyLast3: metrics.buyLast3 },
  };
  return result;
}

function rankCandidates(items) {
  return items.sort((a, b) =>
    (b.score - a.score) ||
    ((Number.isFinite(b._sort?.rateMultiple) ? b._sort.rateMultiple : 999) - (Number.isFinite(a._sort?.rateMultiple) ? a._sort.rateMultiple : 999)) ||
    ((b._sort?.buyLast3 || 0) - (a._sort?.buyLast3 || 0))
  ).map((item, index) => ({ ...item, rank: index + 1 }));
}

function reportLine(item, index) {
  const m = item.recent3m;
  const h = item.currentHour;
  const speed = m.buyRateMultiple == null ? 'داده مبنا ناکافی' : `${fmt(m.buyRateMultiple)}x`;
  const quality = h.sampleTruncated ? 'نمونه محدود به ۱۰۰۰ معامله اخیر' : 'نمونه معاملات دریافت‌شده';
  return [
    `${index + 1}. ${item.symbol} | امتیاز حجم ${item.score}/100 | ${item.statusLabel}`,
    `قیمت لحظه‌ای: ${item.price ?? '—'} | گردش ۲۴ساعت: ${fmt(item.quoteVolume24h, 0)} USDT`,
    `کندل جاری ۱س: خرید ${fmt(h.buyNotional, 0)} / فروش ${fmt(h.sellNotional, 0)} USDT | سهم خرید ${fmt(h.buySharePct, 1)}٪ | دلتا ${fmt(h.netDelta, 0)}`,
    `۳ دقیقه اخیر: خرید ${fmt(m.buyNotional, 0)} / فروش ${fmt(m.sellNotional, 0)} USDT | سهم خرید ${fmt(m.buySharePct, 1)}٪ | دلتا ${fmt(m.netDelta, 0)}`,
    `سرعت خرید: ${fmt(m.buyNotionalPerMinute, 0)} USDT/دقیقه | نسبت به ۳ دقیقه قبل: ${speed} | تداوم: ${fmt(m.persistencePct, 0)}٪`,
    `کیفیت داده: ${quality} | معاملات بررسی‌شده: ${item.tradesObserved}`,
    `شواهد: ${item.reasons.join('؛ ') || item.statusLabel}`,
  ].join('\n');
}

function buildReport(output) {
  const lines = [
    '📊 GATE.IO | رادار شتاب حجم خرید — تایم‌فریم ۱ساعته',
    '━━━━━━━━━━━━━━━━━━',
    `زمان اسکن: ${output.scannedAt}`,
    `قرارداد فعال: ${output.stats.active} | بازار نقدشونده: ${output.stats.liquid} | بررسی موفق: ${output.stats.success} | خطا: ${output.stats.failed}`,
    `نامزدهای افزایش حجم خرید: ${output.stats.candidates}`,
    'مبنای جهت: علامت حجم معاملات واقعی؛ مثبت=خرید، منفی=فروش. کندل یک‌ساعته جاری نیز بررسی می‌شود.',
    '━━━━━━━━━━━━━━━━━━',
  ];
  if (!output.candidates.length) lines.push('در این اسکن افزایش حجم خرید با معیارهای فعلی پیدا نشد.');
  else output.candidates.forEach((item, index) => lines.push(reportLine(item, index), '━━━━━━━━━━━━━━━━━━'));
  lines.push('⚠️ حجم خرید تهاجمی به‌تنهایی تضمین رشد قیمت نیست؛ ممکن است خریدها جذب فروش شوند یا صرفاً بستن موقعیت شورت باشند.');
  return lines.join('\n');
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[TELEGRAM] Credentials missing; report printed locally only.');
    return false;
  }
  const chunks = [];
  let current = '';
  for (const line of message.split('\n')) {
    if ((current + '\n' + line).length > CONFIG.TELEGRAM_MAX_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram HTTP ${response.status}`);
    await sleep(300);
  }
  return true;
}

export async function scanGateMarkets() {
  const started = Date.now();
  const nowSeconds = Date.now() / 1000;
  console.log('\n📊 GATE.IO BUY-VOLUME ACCELERATION RADAR');

  const [contracts, tickers] = await Promise.all([
    requestGate(`/futures/${CONFIG.SETTLE}/contracts`),
    requestGate(`/futures/${CONFIG.SETTLE}/tickers`),
  ]);
  const tickerMap = new Map((tickers || []).map(ticker => [ticker.contract, ticker]));
  const active = (contracts || []).filter(contract =>
    typeof contract.name === 'string' && contract.name.endsWith('_USDT') &&
    contract.status === 'trading' && contract.in_delisting === false &&
    positive(num(contract.quanto_multiplier))
  );
  const markets = active.map(contract => {
    const ticker = tickerMap.get(contract.name);
    const quoteVolume = num(ticker?.volume_24h_quote) ?? 0;
    return ticker && positive(num(ticker.last)) && quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
      ? { symbol: contract.name, contract, ticker, quoteVolume }
      : null;
  }).filter(Boolean).sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log(`Active contracts: ${active.length} | Liquid markets: ${markets.length}`);
  let success = 0, failed = 0, completed = 0;
  const results = await mapPool(markets, CONFIG.CONCURRENCY, async market => {
    const hourStart = Math.floor(nowSeconds / 3600) * 3600;
    const trades = await requestGate(`/futures/${CONFIG.SETTLE}/trades`, {
      contract: market.symbol,
      from: hourStart,
      to: Math.floor(nowSeconds),
      limit: CONFIG.TRADE_LIMIT,
    });
    const candidate = analyzeMarket(market, trades, nowSeconds);
    success++;
    completed++;
    if (completed % 50 === 0) console.log(`[PROGRESS] ${completed}/${markets.length}`);
    return candidate;
  });

  const candidates = [];
  for (const item of results) {
    if (item?.__error) failed++;
    else if (item) candidates.push(item);
  }
  const rankedAll = rankCandidates(candidates);
  const ranked = rankedAll.slice(0, CONFIG.TOP_COUNT).map((item, index) => {
    const clean = { ...item, rank: index + 1 };
    delete clean._sort;
    return clean;
  });

  const output = {
    success: true,
    exchange: 'GATE.IO',
    market: 'USDT PERPETUAL',
    strategy: 'ONE-HOUR LIVE BUY-VOLUME ACCELERATION RADAR',
    scannedAt: new Date().toISOString(),
    stats: {
      active: active.length,
      liquid: markets.length,
      success,
      failed,
      candidates: candidates.length,
      durationMs: Date.now() - started,
    },
    candidates: ranked,
    rankedCandidates: ranked,
  };

  try {
    const stored = await saveMarketSnapshot(rankedAll.map(item => {
      const copy = { ...item };
      delete copy._sort;
      return copy;
    }));
    output.historyCount = stored?.historyCount ?? 0;
    output.summaryCount = stored?.summaryCount ?? rankedAll.length;
    output.rankChanges = stored?.rankChanges ?? {};
  } catch (error) {
    console.error('[STORAGE] Snapshot save failed:', error.message);
  }

  const report = buildReport(output);
  console.log(report);
  console.log(`\nFinished in ${(output.stats.durationMs / 1000).toFixed(1)}s | scanned ${markets.length} | success ${success} | failed ${failed}`);
  await sendTelegram(report);
  return output;
}

// src/index.js imports this module to start the scanner.
try {
  const result = await scanGateMarkets();
  console.log('[SCANNER RESULT]', JSON.stringify({
    success: result.success,
    active: result.stats.active,
    liquid: result.stats.liquid,
    successful: result.stats.success,
    failed: result.stats.failed,
    candidates: result.stats.candidates,
    durationMs: result.stats.durationMs,
  }, null, 2));
} catch (error) {
  console.error('[SCANNER FATAL ERROR]', error);
  process.exitCode = 1;
}
