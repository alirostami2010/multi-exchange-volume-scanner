/**
 * GATE.IO USDT PERPETUAL — CLOSED-CANDLE BEHAVIOR SCANNER
 * ------------------------------------------------------
 * Behavioral scanner only (not a trading-signal generator).
 * Uses CLOSED 1h / 4h / 1d candles, price/turnover behavior and
 * timestamp-aligned relative behavior versus BTC.
 * Telegram output: up to five symbols, names only.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAMES: {
    '1h': { seconds: 3600, limit: 90 },
    '4h': { seconds: 14400, limit: 90 },
    '1d': { seconds: 86400, limit: 90 },
  },
  MIN_QUOTE_VOLUME_24H: 100000,
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,
  MAX_RESULTS: 5,
  MIN_CANDLES: 30,
};

const TIMEFRAMES = Object.keys(CONFIG.TIMEFRAMES);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (current, previous) => previous > 0 ? ((current / previous) - 1) * 100 : 0;
const activity = (candle) => candle.turnover > 0 ? candle.turnover : candle.volume;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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

  // Gate.io candle t is the candle opening timestamp. Exclude the current bucket.
  const currentBucket = Math.floor(Date.now() / 1000 / settings.seconds) * settings.seconds;
  const byTime = new Map();
  for (const item of raw) {
    const candle = {
      time: num(item.t),
      open: num(item.o),
      high: num(item.h),
      low: num(item.l),
      close: num(item.c),
      volume: num(item.v),
      turnover: num(item.sum),
    };
    if (
      candle.time > 0 && candle.time < currentBucket &&
      candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 &&
      candle.high >= candle.low && candle.high >= candle.open && candle.high >= candle.close &&
      candle.low <= candle.open && candle.low <= candle.close
    ) byTime.set(candle.time, candle);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function candleFacts(candle) {
  const range = Math.max(candle.high - candle.low, Number.EPSILON);
  const body = candle.close - candle.open;
  const volume = Math.max(activity(candle), 0);
  return {
    closePosition: clamp((candle.close - candle.low) / range, 0, 1),
    lowerWick: clamp((Math.min(candle.open, candle.close) - candle.low) / range, 0, 1),
    upperWick: clamp((candle.high - Math.max(candle.open, candle.close)) / range, 0, 1),
    bullish: body > 0,
    bearish: body < 0,
    bodyPct: Math.abs(body) / candle.open * 100,
    volume,
  };
}

/*
 * Read price/turnover behavior, not indicator crossings.
 * Recent six closed bars are compared with the preceding twelve.
 */
function readBehavior(candles) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;

  const recent = candles.slice(-6);
  const prior = candles.slice(-18, -6);
  const older = candles.slice(-24, -18);
  if (prior.length !== 12 || older.length !== 6) return null;

  const recentFacts = recent.map(candleFacts);
  const priorFacts = prior.map(candleFacts);
  const recentFirst = recent[0];
  const recentLast = recent.at(-1);
  const priorLast = prior.at(-1);
  const priorFirst = prior[0];

  const recentReturn = pct(recentLast.close, recentFirst.open);
  const priorReturn = pct(priorLast.close, priorFirst.open);
  const olderReturn = pct(older.at(-1).close, older[0].open);

  const recentLow = Math.min(...recent.map((c) => c.low));
  const priorLow = Math.min(...prior.map((c) => c.low));
  const priorHigh = Math.max(...prior.map((c) => c.high));

  const recentBullish = recentFacts.filter((f) => f.bullish).length;
  const recentBearish = recentFacts.filter((f) => f.bearish).length;
  const recentCloseStrength = mean(recentFacts.map((f) => f.closePosition));
  const recentLowerWick = mean(recentFacts.map((f) => f.lowerWick));
  const recentUpperWick = mean(recentFacts.map((f) => f.upperWick));

  const recentActivity = mean(recentFacts.map((f) => f.volume));
  const priorActivity = mean(priorFacts.map((f) => f.volume));
  const activityRatio = priorActivity > 0 ? recentActivity / priorActivity : 1;
  const bullishActivity = recentFacts.filter((f) => f.bullish).reduce((s, f) => s + f.volume, 0);
  const bearishActivity = recentFacts.filter((f) => f.bearish).reduce((s, f) => s + f.volume, 0);
  const directionalActivityRatio = bullishActivity / Math.max(bearishActivity, 1);

  let higherLowSteps = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low > recent[i - 1].low) higherLowSteps++;
  }

  const heldPriorLow = recentLow >= priorLow * 0.997;
  const reclaimedPriorRange = recentLast.close > priorHigh;
  const higherLowStructure = higherLowSteps >= 3 && heldPriorLow;
  const volumeExpanded = activityRatio >= 1.15;
  const buyersActive = recentBullish >= 4 && recentCloseStrength >= 0.60 && directionalActivityRatio >= 1.05;

  // New demand after a quiet/declining stretch, or a fresh recovery from selling.
  const demandAfterPause =
    Math.abs(olderReturn) <= 4.5 && recentReturn > 0.8 &&
    recentBullish >= 4 && recentCloseStrength >= 0.60;

  const recoveryAfterSelling =
    (priorReturn < -1.0 || olderReturn < -1.0) &&
    recentReturn > priorReturn + 0.8 && heldPriorLow &&
    recentBullish >= 3 && recentCloseStrength >= 0.56;

  const sellerWeakening =
    (priorReturn < -0.8 || olderReturn < -0.8) &&
    recentReturn > priorReturn && heldPriorLow &&
    (higherLowStructure || recentLowerWick >= 0.25) &&
    recentCloseStrength >= 0.52;

  // Selling is being absorbed when activity is elevated but price refuses to
  // extend lower and closes away from candle lows.
  const supplyAbsorption =
    volumeExpanded && heldPriorLow &&
    recentCloseStrength >= 0.55 &&
    recentLowerWick >= 0.22 &&
    recentReturn >= -0.5;

  const freshUpsideExpansion =
    reclaimedPriorRange && buyersActive &&
    (volumeExpanded || directionalActivityRatio >= 1.35);

  const distribution =
    recentReturn < -1.0 && recentBearish >= 4 &&
    recentCloseStrength < 0.42 &&
    (recentLow < priorLow * 0.997 || (volumeExpanded && recentUpperWick >= 0.28));

  const freshBehavior =
    demandAfterPause || recoveryAfterSelling || sellerWeakening ||
    supplyAbsorption || freshUpsideExpansion;

  return {
    recentReturn,
    priorReturn,
    recentBullish,
    recentBearish,
    recentCloseStrength,
    activityRatio,
    directionalActivityRatio,
    higherLowSteps,
    heldPriorLow,
    demandAfterPause,
    recoveryAfterSelling,
    sellerWeakening,
    supplyAbsorption,
    freshUpsideExpansion,
    freshBehavior,
    distribution,
  };
}

function alignCandles(coinCandles, btcCandles) {
  const btcByTime = new Map(btcCandles.map((c) => [c.time, c]));
  return coinCandles
    .filter((c) => btcByTime.has(c.time))
    .map((coin) => ({ coin, btc: btcByTime.get(coin.time) }))
    .sort((a, b) => a.coin.time - b.coin.time);
}

function compareWithBitcoin(coinCandles, btcCandles) {
  if (!coinCandles || !btcCandles) return null;
  const aligned = alignCandles(coinCandles, btcCandles);
  if (aligned.length < 7) return null;

  const window = aligned.slice(-7);
  const coinReturn = pct(window.at(-1).coin.close, window[0].coin.close);
  const btcReturn = pct(window.at(-1).btc.close, window[0].btc.close);
  const relative = coinReturn - btcReturn;

  let btcCondition = 'flat';
  if (btcReturn <= -0.7) btcCondition = 'down';
  else if (btcReturn >= 0.7) btcCondition = 'up';

  return {
    coinReturn,
    btcReturn,
    relative,
    btcCondition,
    strength: relative >= 0.5,
    resilience: btcCondition === 'down' && relative >= 0.5 && coinReturn >= -0.5,
    independentDemand: btcCondition === 'flat' && coinReturn >= 0.7,
    outperformance: btcCondition === 'up' && relative >= 0.5,
  };
}

function analyzeCoin(symbol, candles, btcCandles) {
  const behavior = {};
  const relative = {};
  for (const timeframe of TIMEFRAMES) {
    behavior[timeframe] = readBehavior(candles[timeframe]);
    relative[timeframe] = compareWithBitcoin(candles[timeframe], btcCandles[timeframe]);
    if (!behavior[timeframe] || !relative[timeframe]) return null;
  }

  const freshFrames = TIMEFRAMES.filter((tf) => behavior[tf].freshBehavior);
  const relativeFrames = TIMEFRAMES.filter((tf) => relative[tf].strength);
  const conditionalStrengthFrames = TIMEFRAMES.filter((tf) =>
    relative[tf].resilience || relative[tf].independentDemand || relative[tf].outperformance
  );
  const distributionFrames = TIMEFRAMES.filter((tf) => behavior[tf].distribution);

  // The change must be recent on 1h/4h. Daily is context/confirmation,
  // not a requirement that would hide early behavior changes.
  const freshOnShortFrames = behavior['1h'].freshBehavior || behavior['4h'].freshBehavior;
  const relativeConfirmed = relativeFrames.length >= 2 || conditionalStrengthFrames.length >= 1;
  const dangerousDistribution = behavior['1h'].distribution && behavior['4h'].distribution;

  if (!freshOnShortFrames || !relativeConfirmed || dangerousDistribution) return null;

  // Lexicographic evidence ranking: fresh 1h behavior, then 4h, then daily;
  // then BTC-relative evidence and the quality of the observed price action.
  const freshnessRank =
    (behavior['1h'].freshBehavior ? 3 : 0) +
    (behavior['4h'].freshBehavior ? 2 : 0) +
    (behavior['1d'].freshBehavior ? 1 : 0);
  const btcRank =
    (relative['1h'].strength ? 3 : 0) +
    (relative['4h'].strength ? 2 : 0) +
    (relative['1d'].strength ? 1 : 0) +
    conditionalStrengthFrames.length;
  const qualityRank =
    (behavior['1h'].freshUpsideExpansion ? 2 : 0) +
    (behavior['1h'].recoveryAfterSelling ? 2 : 0) +
    (behavior['1h'].supplyAbsorption ? 1 : 0) +
    (behavior['4h'].freshBehavior ? 2 : 0) +
    (behavior['4h'].distribution ? -2 : 0) +
    (behavior['1d'].distribution ? -1 : 0);

  return { symbol, freshnessRank, btcRank, qualityRank };
}

async function sendTelegram(names) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: names.join('\n'),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) {
    throw new Error(result?.description || `Telegram HTTP ${response.status}`);
  }
}

async function main() {
  console.log('\nGATE.IO CLOSED-CANDLE BEHAVIOR SCANNER');
  console.log('Timeframes: 1h, 4h, 1d | aligned BTC comparison | max 5 symbols');

  const [contracts, tickers] = await Promise.all([getContracts(), getTickers()]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
    throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');
  }

  const tickerMap = new Map(tickers.map((ticker) => [ticker.contract, ticker]));
  const markets = contracts
    .filter((contract) =>
      contract?.name && contract.name !== 'BTC_USDT' &&
      contract.in_delisting !== true && tickerMap.has(contract.name)
    )
    .map((contract) => ({
      symbol: contract.name,
      quoteVolume: num(tickerMap.get(contract.name).volume_24h_quote),
    }))
    .filter((market) => market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const btcEntries = await Promise.all(
    TIMEFRAMES.map(async (timeframe) => [timeframe, await getClosedCandles('BTC_USDT', timeframe)])
  );
  const btcCandles = Object.fromEntries(btcEntries);
  if (Object.values(btcCandles).some((bars) => bars.length < CONFIG.MIN_CANDLES)) {
    throw new Error('کندل بسته‌شده کافی برای مقایسه بیت‌کوین دریافت نشد.');
  }

  let checked = 0;
  let failed = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const entries = await Promise.all(
      TIMEFRAMES.map(async (timeframe) => [timeframe, await getClosedCandles(market.symbol, timeframe)])
    );
    const candles = Object.fromEntries(entries);
    if (Object.values(candles).some((bars) => bars.length < CONFIG.MIN_CANDLES)) return null;
    checked++;
    return analyzeCoin(market.symbol, candles, btcCandles);
  });

  for (const result of results) {
    if (result?.error) failed++;
  }

  const selected = results
    .filter((result) => result && !result.error)
    .sort((a, b) =>
      b.freshnessRank - a.freshnessRank ||
      b.btcRank - a.btcRank ||
      b.qualityRank - a.qualityRank ||
      a.symbol.localeCompare(b.symbol)
    )
    .slice(0, CONFIG.MAX_RESULTS)
    .map((result) => result.symbol.replace(/_USDT$/, ''));

  console.log(`Markets eligible by liquidity: ${markets.length}`);
  console.log(`Markets analyzed: ${checked}`);
  console.log(`Markets with data errors: ${failed}`);
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
