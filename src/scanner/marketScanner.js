/**
 * GATE.IO USDT PERPETUAL — HOURLY BULLISH BEHAVIOR SCANNER
 * -------------------------------------------------------
 * Single timeframe: CLOSED 1h candles only.
 * Finds (1) fresh bullish trend starts and (2) bullish resumption after
 * a correction/pause. Requires hourly relative strength versus BTC and
 * several independent price/turnover confirmations.
 * Telegram: up to five symbols only; no message when none qualify.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1h',
  CANDLE_SECONDS: 3600,
  CANDLE_LIMIT: 72,
  MIN_CANDLES: 40,
  MIN_QUOTE_VOLUME_24H: 100000,
  // Gate.io leaves contract_type empty for ordinary crypto contracts;
  // non-crypto instruments are explicitly tagged (stocks, indices, etc.).
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,
  MAX_RESULTS: 5,
  // Conservative gates: a candidate must pass every hard gate below.
  MIN_RELATIVE_STRENGTH_6H: 0.35,
  MIN_RELATIVE_STRENGTH_12H: 0.10,
  MAX_RECENT_4H_GAIN: 5.5,
  MIN_RECENT_4H_GAIN: 0.25,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (current, previous) => previous > 0 ? (current / previous - 1) * 100 : 0;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const activity = (candle) => candle.turnover > 0 ? candle.turnover : candle.volume;

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

/**
 * Gate.io's Futures Contract schema makes contract_type optional. Ordinary
 * crypto contracts (including BTC_USDT) commonly omit it; non-crypto markets
 * are explicitly tagged, e.g. stocks, metals, indices, forex or commodities.
 * Therefore an empty classification is accepted only for a well-formed
 * BASE_USDT perpetual symbol with an active trading status. Any explicit
 * non-crypto/unknown classification is rejected.
 */
function isSupportedCryptoContract(contract) {
  const name = String(contract?.name ?? '').trim().toUpperCase();
  const classification = String(contract?.contract_type ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const active = String(contract?.status ?? '').toLowerCase() === 'trading' &&
    contract?.in_delisting !== true;
  const validUsdtPerpetualName = /^[A-Z0-9]{2,30}_USDT$/.test(name);

  if (!active || !validUsdtPerpetualName) return false;
  if (!classification) return true;
  return CONFIG.ALLOWED_CRYPTO_CONTRACT_TYPES.has(classification);
}

async function getClosedHourlyCandles(contract) {
  const params = new URLSearchParams({
    contract,
    interval: CONFIG.TIMEFRAME,
    limit: String(CONFIG.CANDLE_LIMIT),
  });
  const raw = await fetchJSON(`${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`);
  if (!Array.isArray(raw)) throw new Error(`Invalid hourly candles: ${contract}`);

  // Gate.io t is the candle opening time. The currently forming hour is excluded.
  const currentBucket = Math.floor(Date.now() / CONFIG.CANDLE_SECONDS) * CONFIG.CANDLE_SECONDS;
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

function candleFacts(candle) {
  const range = Math.max(candle.high - candle.low, Number.EPSILON);
  const body = candle.close - candle.open;
  return {
    bullish: body > 0,
    bearish: body < 0,
    closePosition: clamp((candle.close - candle.low) / range, 0, 1),
    lowerWick: clamp((Math.min(candle.open, candle.close) - candle.low) / range, 0, 1),
    upperWick: clamp((candle.high - Math.max(candle.open, candle.close)) / range, 0, 1),
    activity: Math.max(activity(candle), 0),
  };
}

function alignCandles(coinCandles, btcCandles) {
  const btcByTime = new Map(btcCandles.map((candle) => [candle.time, candle]));
  return coinCandles
    .filter((candle) => btcByTime.has(candle.time))
    .map((coin) => ({ coin, btc: btcByTime.get(coin.time) }))
    .sort((a, b) => a.coin.time - b.coin.time);
}

function relativeStrength(coinCandles, btcCandles) {
  const aligned = alignCandles(coinCandles, btcCandles);
  if (aligned.length < 14) return null;

  const six = aligned.slice(-7);
  const twelve = aligned.slice(-13);
  const coin6h = pct(six.at(-1).coin.close, six[0].coin.close);
  const btc6h = pct(six.at(-1).btc.close, six[0].btc.close);
  const coin12h = pct(twelve.at(-1).coin.close, twelve[0].coin.close);
  const btc12h = pct(twelve.at(-1).btc.close, twelve[0].btc.close);
  const relative6h = coin6h - btc6h;
  const relative12h = coin12h - btc12h;

  const btcFalling = btc6h <= -0.45;
  const btcFlat = btc6h > -0.45 && btc6h < 0.45;
  const btcRising = btc6h >= 0.45;
  const resilience = btcFalling && relative6h >= 0.15 && coin6h >= -0.35;
  const independentDemand = btcFlat && coin6h >= 0.35 && relative6h >= 0.35;
  const outperformance = btcRising && relative6h >= 0.35 && coin6h > 0;

  return {
    coin6h,
    btc6h,
    coin12h,
    btc12h,
    relative6h,
    relative12h,
    btcCondition: btcFalling ? 'DOWN' : btcRising ? 'UP' : 'FLAT',
    confirmed: relative6h >= CONFIG.MIN_RELATIVE_STRENGTH_6H &&
      relative12h >= CONFIG.MIN_RELATIVE_STRENGTH_12H,
    conditionalConfirmed: resilience || independentDemand || outperformance,
    resilience,
    independentDemand,
    outperformance,
  };
}

/**
 * Detects only early, confirmed hourly structures.
 * Uses the last 4 closed bars for current behavior, the prior 8 for context,
 * and the preceding 8 to determine whether price was correcting or resting.
 */
function detectHourlyStructure(candles) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;

  const recent = candles.slice(-4);
  const prior = candles.slice(-12, -4);
  const earlier = candles.slice(-20, -12);
  if (recent.length !== 4 || prior.length !== 8 || earlier.length !== 8) return null;

  const rf = recent.map(candleFacts);
  const pf = prior.map(candleFacts);
  const ef = earlier.map(candleFacts);
  const last = recent.at(-1);
  const first = recent[0];
  const priorLast = prior.at(-1);
  const priorFirst = prior[0];
  const earlierLast = earlier.at(-1);
  const earlierFirst = earlier[0];

  const recentReturn = pct(last.close, first.open);
  const priorReturn = pct(priorLast.close, priorFirst.open);
  const earlierReturn = pct(earlierLast.close, earlierFirst.open);
  const recentLow = Math.min(...recent.map((c) => c.low));
  const priorLow = Math.min(...prior.map((c) => c.low));
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const earlierHigh = Math.max(...earlier.map((c) => c.high));
  const recentHigh = Math.max(...recent.map((c) => c.high));

  const bullishCount = rf.filter((f) => f.bullish).length;
  const bearishCount = rf.filter((f) => f.bearish).length;
  const closeStrength = mean(rf.map((f) => f.closePosition));
  const lowerWick = mean(rf.map((f) => f.lowerWick));
  const upperWick = mean(rf.map((f) => f.upperWick));
  const recentActivity = mean(rf.map((f) => f.activity));
  const priorActivity = mean(pf.map((f) => f.activity));
  const activityRatio = priorActivity > 0 ? recentActivity / priorActivity : 1;
  const bullishActivity = rf.filter((f) => f.bullish).reduce((sum, f) => sum + f.activity, 0);
  const bearishActivity = rf.filter((f) => f.bearish).reduce((sum, f) => sum + f.activity, 0);
  const directionalActivityRatio = bullishActivity / Math.max(bearishActivity, 1);

  let higherLowSteps = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low > recent[i - 1].low) higherLowSteps++;
  }
  const heldPriorLow = recentLow >= priorLow * 0.997;
  const reclaimedRecentHigh = last.close > Math.max(...recent.slice(0, -1).map((c) => c.high));
  const brokePriorHigh = last.close > priorHigh * 1.001;
  const closeAbovePriorMid = last.close > (priorHigh + priorLow) / 2;

  // Evidence that sellers are losing control and buyers are absorbing supply.
  const sellersFading =
    (priorReturn <= -0.35 || earlierReturn <= -0.65) &&
    recentReturn > priorReturn && heldPriorLow &&
    (higherLowSteps >= 2 || lowerWick >= 0.22) && closeStrength >= 0.55;

  const supplyAbsorption =
    activityRatio >= 1.08 && heldPriorLow &&
    closeStrength >= 0.56 && lowerWick >= 0.18 && recentReturn >= -0.25;

  const buyersTakingControl =
    bullishCount >= 3 && closeStrength >= 0.62 &&
    directionalActivityRatio >= 1.12 && bearishCount <= 1;

  const demandBuilding =
    buyersTakingControl && heldPriorLow &&
    (higherLowSteps >= 2 || reclaimedRecentHigh || lowerWick >= 0.22);

  const volumeConfirmation = activityRatio >= 1.10 || directionalActivityRatio >= 1.35;
  const priceConfirmation = closeAbovePriorMid &&
    (reclaimedRecentHigh || higherLowSteps >= 2 || brokePriorHigh);

  // Setup A: a new trend emerging from a flat/weak/downward base.
  const wasQuietOrWeak = Math.abs(priorReturn) <= 2.2 || priorReturn < -0.35 || earlierReturn < 0.2;
  const newTrendScore =
    (sellersFading ? 2 : 0) +
    (supplyAbsorption ? 2 : 0) +
    (demandBuilding ? 2 : 0) +
    (volumeConfirmation ? 1 : 0) +
    (priceConfirmation ? 1 : 0) +
    (higherLowSteps >= 2 ? 1 : 0) +
    (brokePriorHigh ? 1 : 0);
  const newTrend = wasQuietOrWeak &&
    recentReturn >= CONFIG.MIN_RECENT_4H_GAIN &&
    recentReturn <= CONFIG.MAX_RECENT_4H_GAIN &&
    buyersTakingControl && demandBuilding &&
    (sellersFading || supplyAbsorption) && volumeConfirmation &&
    priceConfirmation && newTrendScore >= 7;

  // Setup B: correction/pause is defended, then buyers regain control.
  const correctionOrPause =
    priorReturn <= -0.55 ||
    (Math.abs(priorReturn) <= 1.35 && Math.abs(earlierReturn) <= 2.8) ||
    (earlierReturn < -0.8 && priorReturn > earlierReturn);
  const correctionHeld = recentLow >= priorLow * 0.995 && closeAbovePriorMid;
  const resumedDemand = buyersTakingControl && demandBuilding &&
    (reclaimedRecentHigh || last.close > priorLast.close) && volumeConfirmation;
  const resumptionScore =
    (correctionHeld ? 2 : 0) +
    (resumedDemand ? 2 : 0) +
    (sellersFading ? 1 : 0) +
    (supplyAbsorption ? 1 : 0) +
    (higherLowSteps >= 2 ? 1 : 0) +
    (closeStrength >= 0.66 ? 1 : 0) +
    (reclaimedRecentHigh ? 1 : 0);
  const resumption = correctionOrPause && correctionHeld && resumedDemand &&
    recentReturn >= CONFIG.MIN_RECENT_4H_GAIN &&
    recentReturn <= CONFIG.MAX_RECENT_4H_GAIN &&
    (sellersFading || supplyAbsorption || higherLowSteps >= 2) &&
    resumptionScore >= 7;

  // Reject late/unstable moves, heavy rejection at highs and renewed selling.
  const distribution = recentReturn < -0.35 && bearishCount >= 3 &&
    closeStrength < 0.43 && (recentLow < priorLow * 0.995 || upperWick >= 0.32);
  const exhaustion = recentReturn > CONFIG.MAX_RECENT_4H_GAIN ||
    (upperWick >= 0.42 && closeStrength < 0.55) ||
    (bearishCount >= 3 && closeStrength < 0.48);

  if ((!newTrend && !resumption) || distribution || exhaustion) return null;

  const type = newTrend && resumption ? 'NEW_TREND_AND_RESUMPTION' :
    newTrend ? 'NEW_TREND' : 'RESUMPTION_AFTER_PAUSE';
  const quality = Math.max(newTrend ? newTrendScore : 0, resumption ? resumptionScore : 0);
  const confirmation =
    (buyersTakingControl ? 2 : 0) +
    (volumeConfirmation ? 1 : 0) +
    (priceConfirmation ? 1 : 0) +
    (heldPriorLow ? 1 : 0) +
    (closeStrength >= 0.66 ? 1 : 0);

  return {
    type,
    quality,
    confirmation,
    recentReturn,
    activityRatio,
    directionalActivityRatio,
    closeStrength,
    higherLowSteps,
    evidence: {
      sellersFading,
      supplyAbsorption,
      buyersTakingControl,
      demandBuilding,
      volumeConfirmation,
      priceConfirmation,
      heldPriorLow,
      reclaimedRecentHigh,
      brokePriorHigh,
    },
  };
}

function analyzeMarket(symbol, candles, btcCandles) {
  const relative = relativeStrength(candles, btcCandles);
  if (!relative) return null;
  // Relative strength is a hard requirement, not a soft ranking bonus.
  if (!relative.confirmed && !relative.conditionalConfirmed) return null;

  const structure = detectHourlyStructure(candles);
  if (!structure) return null;

  const relativeQuality =
    (relative.relative6h >= 0.8 ? 2 : relative.relative6h >= 0.35 ? 1 : 0) +
    (relative.relative12h >= 0.5 ? 1 : 0) +
    (relative.resilience || relative.independentDemand || relative.outperformance ? 1 : 0);
  const totalQuality = structure.quality * 2 + structure.confirmation + relativeQuality;

  return { symbol, structure, relative, totalQuality };
}

async function sendTelegram(symbols) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: symbols.join('\n'),
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
  console.log('\nGATE.IO HOURLY BULLISH BEHAVIOR SCANNER');
  console.log('Timeframe: CLOSED 1h candles only | relative strength vs BTC | max 5 symbols');

  const [contracts, tickers] = await Promise.all([getContracts(), getTickers()]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
    throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');
  }

  const tickerMap = new Map(tickers.map((ticker) => [ticker.contract, ticker]));
  const namedContracts = contracts.filter((contract) => contract?.name);
  const cryptoContracts = namedContracts.filter(isSupportedCryptoContract);
  const rejectedNonCryptoOrUnknown = namedContracts.length - cryptoContracts.length;
  const rejectedMissingTicker = cryptoContracts.filter((contract) => !tickerMap.has(contract.name)).length;

  const markets = cryptoContracts
    .filter((contract) => contract.name !== 'BTC_USDT' && tickerMap.has(contract.name))
    .map((contract) => ({
      symbol: contract.name,
      quoteVolume: num(tickerMap.get(contract.name).volume_24h_quote),
    }))
    .filter((market) => market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const btcContract = contracts.find((contract) => contract?.name === 'BTC_USDT');
  if (!btcContract || !isSupportedCryptoContract(btcContract)) {
    throw new Error('قرارداد مرجع BTC_USDT در Gate.io صراحتاً به‌عنوان رمزارز فعال تأیید نشد.');
  }

  const btcCandles = await getClosedHourlyCandles('BTC_USDT');
  if (btcCandles.length < CONFIG.MIN_CANDLES) {
    throw new Error('کندل بسته‌شده یک‌ساعته کافی برای مقایسه بیت‌کوین دریافت نشد.');
  }

  let checked = 0;
  let failed = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const candles = await getClosedHourlyCandles(market.symbol);
    if (candles.length < CONFIG.MIN_CANDLES) return null;
    checked++;
    return analyzeMarket(market.symbol, candles, btcCandles);
  });

  for (const result of results) {
    if (result?.error) failed++;
  }

  const candidates = results
    .filter((result) => result && !result.error)
    .sort((a, b) =>
      b.totalQuality - a.totalQuality ||
      b.relative.relative6h - a.relative.relative6h ||
      b.structure.confirmation - a.structure.confirmation ||
      a.symbol.localeCompare(b.symbol)
    );

  const selected = candidates.slice(0, CONFIG.MAX_RESULTS);
  const telegramSymbols = selected.map((item) => item.symbol.replace(/_USDT$/, ''));

  console.log(`Contracts received from Gate.io: ${contracts.length}`);
  console.log(`Contracts explicitly classified as active crypto: ${cryptoContracts.length}`);
  console.log(`Contracts rejected (non-crypto, unknown type, or inactive): ${rejectedNonCryptoOrUnknown}`);
  console.log(`Crypto contracts missing ticker data: ${rejectedMissingTicker}`);
  console.log(`Crypto markets eligible by 24h liquidity: ${markets.length}`);
  console.log(`Markets analyzed with sufficient hourly candles: ${checked}`);
  console.log(`Markets with data errors: ${failed}`);
  console.log(`Qualified hourly bullish structures: ${candidates.length}`);
  console.log(`Selected symbols: ${telegramSymbols.length}`);

  if (candidates.length) {
    console.log('Ranked candidates (diagnostic only):');
    for (const item of candidates) {
      console.log(
        `${item.symbol} | ${item.structure.type} | quality=${item.totalQuality} | ` +
        `relative6h=${item.relative.relative6h.toFixed(2)}% | ` +
        `relative12h=${item.relative.relative12h.toFixed(2)}% | ` +
        `1h-structure=${item.structure.recentReturn.toFixed(2)}%`
      );
    }
  }

  if (telegramSymbols.length) {
    await sendTelegram(telegramSymbols);
    console.log('Telegram message sent:', telegramSymbols.join(', '));
  } else {
    console.log('No symbol met all hourly bullish behavior requirements; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
