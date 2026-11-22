/**
 * GATE.IO USDT PERPETUAL — CLOSED-CANDLE BEHAVIOR SCANNER
 * ------------------------------------------------------
 * Fresh implementation: price/volume behavior + reaction versus BTC.
 * Only 1h, 4h and 1d CLOSED candles are used.
 * Telegram output: up to five contract symbols, names only.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAMES: {
    '1h': { seconds: 3600, limit: 80 },
    '4h': { seconds: 14400, limit: 80 },
    '1d': { seconds: 86400, limit: 80 },
  },
  MIN_QUOTE_VOLUME_24H: 100000,
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,
  MAX_RESULTS: 5,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : 0);
const candleVolume = (c) => c.turnover > 0 ? c.turnover : c.volume;

async function fetchJSON(url) {
  let lastError;
  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });
      if (!response.ok) {
        const error = new Error(`Gate.io HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.RETRIES) {
        await sleep(error.status === 429 ? 1800 * attempt : 600 * attempt);
      }
    }
  }
  throw lastError;
}

async function getContracts() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contracts`);
}

async function getTickers() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/tickers`);
}

async function getClosedCandles(contract, interval) {
  const settings = CONFIG.TIMEFRAMES[interval];
  const params = new URLSearchParams({
    contract,
    interval,
    limit: String(settings.limit),
  });
  const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
  if (!Array.isArray(raw)) throw new Error(`Invalid candles: ${contract} ${interval}`);

  const currentBucket = Math.floor(Date.now() / 1000 / settings.seconds) * settings.seconds;
  return raw
    .map((c) => ({
      time: num(c.t),
      open: num(c.o),
      high: num(c.h),
      low: num(c.l),
      close: num(c.c),
      volume: num(c.v),
      turnover: num(c.sum),
    }))
    .filter((c) =>
      c.time > 0 && c.time < currentBucket &&
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
      c.high >= c.low
    )
    .sort((a, b) => a.time - b.time);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/*
 * Behavioral reading, not indicator/entry logic:
 * - price direction and sequence of lows/highs
 * - whether buyers defend recent lows and close near candle highs
 * - whether activity expands with upward movement
 * - whether the coin holds up better than BTC over identical closed bars
 */
function readBehavior(candles) {
  if (!Array.isArray(candles) || candles.length < 25) return null;

  const recent = candles.slice(-6);
  const prior = candles.slice(-18, -6);
  const first = recent[0];
  const last = recent.at(-1);
  const before = candles.at(-7);

  const change6 = pct(last.close, first.open);
  const change12 = pct(last.close, before.close);
  const priorChange = pct(before.close, candles.at(-19)?.close ?? before.close);

  const recentLow = Math.min(...recent.map((c) => c.low));
  const earlierLow = Math.min(...candles.slice(-18, -6).map((c) => c.low));
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const priorHigh = Math.max(...candles.slice(-18, -6).map((c) => c.high));

  const positiveCloses = recent.filter((c) => c.close > c.open).length;
  const defendedLows = recent.slice(1).filter((c, i) =>
    c.low >= recent[i].low || c.close > recent[i].low
  ).length;

  const recentActivity = recent.map(candleVolume);
  const priorActivity = prior.map(candleVolume);
  const recentAvgActivity = recentActivity.reduce((a, b) => a + b, 0) / Math.max(1, recentActivity.length);
  const priorAvgActivity = priorActivity.reduce((a, b) => a + b, 0) / Math.max(1, priorActivity.length);
  const activityExpanded = priorAvgActivity > 0 && recentAvgActivity > priorAvgActivity * 1.15;

  const closePosition = last.high > last.low
    ? (last.close - last.low) / (last.high - last.low)
    : 0.5;

  const demandBehavior =
    (change6 > 0.8 && positiveCloses >= 3) ||
    (recentLow > earlierLow && change12 > 0) ||
    (activityExpanded && change6 > 0 && closePosition >= 0.65);

  const sellerWeakening =
    priorChange < 0 && change12 > priorChange &&
    recentLow >= earlierLow * 0.995 && positiveCloses >= 2;

  const supplyAbsorption =
    recentLow >= earlierLow * 0.995 &&
    last.close >= last.open && closePosition >= 0.6 &&
    (activityExpanded || positiveCloses >= 3);

  const distributionBehavior =
    change6 < -1.5 && positiveCloses <= 2 &&
    activityExpanded && closePosition < 0.45;

  return {
    change6,
    change12,
    positiveCloses,
    demandBehavior,
    sellerWeakening,
    supplyAbsorption,
    distributionBehavior,
    activityExpanded,
    recentLow,
    earlierLow,
  };
}

function compareWithBitcoin(coinCandles, btcCandles) {
  if (!coinCandles || !btcCandles || coinCandles.length < 13 || btcCandles.length < 13) return null;
  const coinLast = coinCandles.at(-1);
  const coinThen = coinCandles.at(-7);
  const btcLast = btcCandles.at(-1);
  const btcThen = btcCandles.at(-7);
  const coinReturn = pct(coinLast.close, coinThen.close);
  const btcReturn = pct(btcLast.close, btcThen.close);
  return {
    coinReturn,
    btcReturn,
    relative: coinReturn - btcReturn,
    resilientDuringBtcDrop: btcReturn < -0.5 && coinReturn > btcReturn && coinReturn >= -0.5,
  };
}

function analyzeCoin(symbol, candles, btcCandles) {
  const behaviors = {};
  const relative = {};
  for (const timeframe of Object.keys(CONFIG.TIMEFRAMES)) {
    behaviors[timeframe] = readBehavior(candles[timeframe]);
    relative[timeframe] = compareWithBitcoin(candles[timeframe], btcCandles[timeframe]);
    if (!behaviors[timeframe] || !relative[timeframe]) return null;
  }

  const frames = Object.keys(CONFIG.TIMEFRAMES);
  const demandFrames = frames.filter((tf) => behaviors[tf].demandBehavior).length;
  const weakeningFrames = frames.filter((tf) => behaviors[tf].sellerWeakening).length;
  const absorptionFrames = frames.filter((tf) => behaviors[tf].supplyAbsorption).length;
  const relativeFrames = frames.filter((tf) => relative[tf].relative > 0.5).length;
  const resilientFrames = frames.filter((tf) => relative[tf].resilientDuringBtcDrop).length;
  const distributionFrames = frames.filter((tf) => behaviors[tf].distributionBehavior).length;

  // A coin must show actual buyer/seller behavior and relative strength.
  // Distribution on most frames disqualifies it.
  const hasBehavior = demandFrames >= 1 || weakeningFrames >= 2 || absorptionFrames >= 2;
  const hasRelativeStrength = relativeFrames >= 2 || resilientFrames >= 1;
  if (!hasBehavior || !hasRelativeStrength || distributionFrames >= 2) return null;

  // Lightweight ordering only: count independent observed behaviors, no synthetic score.
  const evidenceCount = demandFrames + weakeningFrames + absorptionFrames + relativeFrames + resilientFrames;
  return { symbol, evidenceCount, relative, behaviors };
}

async function sendTelegram(names) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');

  const message = names.join('\n');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram HTTP ${response.status}`);
  }
}

async function main() {
  console.log('\nGATE.IO CLOSED-CANDLE BEHAVIOR SCANNER');
  console.log('Timeframes: 1h, 4h, 1d | BTC relative behavior | max 5 names');

  const [contracts, tickers] = await Promise.all([getContracts(), getTickers()]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
    throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');
  }

  const tickerMap = new Map(tickers.map((t) => [t.contract, t]));
  const markets = contracts
    .filter((c) => c?.name && c.name !== 'BTC_USDT' && c.in_delisting !== true && tickerMap.has(c.name))
    .map((c) => ({
      symbol: c.name,
      quoteVolume: num(tickerMap.get(c.name).volume_24h_quote),
    }))
    .filter((m) => m.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const btcResults = await Promise.all(
    Object.keys(CONFIG.TIMEFRAMES).map((tf) => getClosedCandles('BTC_USDT', tf))
  );
  const btcCandles = Object.fromEntries(Object.keys(CONFIG.TIMEFRAMES).map((tf, i) => [tf, btcResults[i]]));
  if (Object.values(btcCandles).some((arr) => arr.length < 25)) {
    throw new Error('کندل بسته‌شده کافی برای مقایسه بیت‌کوین دریافت نشد.');
  }

  let successful = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const entries = await Promise.all(
      Object.keys(CONFIG.TIMEFRAMES).map(async (tf) => [tf, await getClosedCandles(market.symbol, tf)])
    );
    const candles = Object.fromEntries(entries);
    if (Object.values(candles).some((arr) => arr.length < 25)) return null;
    const result = analyzeCoin(market.symbol, candles, btcCandles);
    if (result) successful++;
    return result;
  });

  const selected = results
    .filter((r) => r && !r.error)
    .sort((a, b) => b.evidenceCount - a.evidenceCount)
    .slice(0, CONFIG.MAX_RESULTS)
    .map((r) => r.symbol.replace(/_USDT$/, ''));

  console.log(`Markets checked: ${markets.length}`);
  console.log(`Behavior candidates: ${selected.length}`);

  if (selected.length === 0) {
    console.log('No coin met the behavior conditions. No Telegram message sent.');
    return;
  }

  await sendTelegram(selected);
  console.log('Telegram message sent:', selected.join(', '));
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
