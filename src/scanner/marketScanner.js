/**
 * GATE.IO USDT PERPETUAL — HOURLY BULLISH BEHAVIOR SCANNER
 * -------------------------------------------------------
 * Single timeframe: CLOSED 1h candles only.
 * Finds early demand after an hourly rest/consolidation, including a new
 * accumulation phase after an earlier rally. Prior gains are not an exclusion.
 * Uses closed 1h candles and relative strength versus BTC.
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
  MOTOR2_MAX_RESULTS: 10,
  // Relative strength thresholds are applied adaptively in relativeStrength().
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

  const relativeMove = (bars) => {
    if (aligned.length < bars + 1) return 0;
    const current = aligned.at(-1);
    const previous = aligned.at(-(bars + 1));
    const coinMove = pct(current.coin.close, previous.coin.close);
    const btcMove = pct(current.btc.close, previous.btc.close);
    return {
      coinMove,
      btcMove,
      relative: coinMove - btcMove,
    };
  };

  const one = relativeMove(1);
  const three = relativeMove(3);
  const six = relativeMove(6);
  const twelve = relativeMove(12);

  const btcFalling = six.btcMove <= -0.45;
  const btcFlat = six.btcMove > -0.45 && six.btcMove < 0.45;
  const btcRising = six.btcMove >= 0.45;
  const resilience = btcFalling && six.relative >= 0.10 && six.coinMove >= -0.50;
  const independentDemand = btcFlat && six.coinMove >= 0.15 && six.relative >= 0.15;
  const outperformance = btcRising && six.relative >= 0.15 && six.coinMove > 0;

  // A quiet-base candidate may show only a small early relative-strength turn.
  // Require at least one positive short-term relative window, while preventing
  // a severely weak 12h structure from passing on a single green candle.
  const shortTermStrength =
    (one.relative >= 0.05 && six.relative >= -0.35) ||
    (three.relative >= 0.10 && six.relative >= -0.55) ||
    six.relative >= 0.10;
  const mediumTermNotBroken = twelve.relative >= -1.25;
  const confirmed = shortTermStrength && mediumTermNotBroken;
  const conditionalConfirmed = resilience || independentDemand || outperformance;

  return {
    coin1h: one.coinMove,
    btc1h: one.btcMove,
    relative1h: one.relative,
    coin3h: three.coinMove,
    btc3h: three.btcMove,
    relative3h: three.relative,
    coin6h: six.coinMove,
    btc6h: six.btcMove,
    coin12h: twelve.coinMove,
    btc12h: twelve.btcMove,
    relative6h: six.relative,
    relative12h: twelve.relative,
    btcCondition: btcFalling ? 'DOWN' : btcRising ? 'UP' : 'FLAT',
    confirmed,
    conditionalConfirmed,
    resilience,
    independentDemand,
    outperformance,
  };
}

/**
 * Detects the beginning of renewed demand after a quiet/resting base.
 * Prior rallies are allowed; the detector judges the current base and its
 * latest closed candles rather than applying a historical-gain ban.
 */
function detectHourlyStructure(candles) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;

  // All windows use fully closed 1h candles only.
  // The 8-bar base is allowed to follow any earlier rally: prior performance
  // is context, never an automatic exclusion rule.
  const trigger = candles.at(-1);
  const recent = candles.slice(-4, -1);       // 3 closed candles before trigger
  const base = candles.slice(-12, -4);        // 8-candle rest / consolidation
  const priorContext = candles.slice(-32, -12); // volatility reference only
  if (recent.length !== 3 || base.length !== 8 || priorContext.length < 12) return null;

  const triggerFacts = candleFacts(trigger);
  const recentFacts = recent.map(candleFacts);
  const baseFacts = base.map(candleFacts);

  const baseHigh = Math.max(...base.map((c) => c.high));
  const baseLow = Math.min(...base.map((c) => c.low));
  const baseRangePct = pct(baseHigh, baseLow);
  const baseReturn = pct(base.at(-1).close, base[0].open);
  const baseAverageRangePct = mean(base.map((c) => pct(c.high, c.low)));
  const contextAverageRangePct = mean(priorContext.map((c) => pct(c.high, c.low)));
  const dynamicRangeLimit = clamp(contextAverageRangePct * 3.6, 2.2, 8.0);
  const maxRestCorrectionPct = clamp(contextAverageRangePct * 2.8, 4.5, 10.0);

  const baseActivity = mean(baseFacts.map((f) => f.activity));
  const recentActivity = mean(recentFacts.map((f) => f.activity));
  const triggerActivityRatio = baseActivity > 0 ? triggerFacts.activity / baseActivity : 0;
  const recentActivityRatio = baseActivity > 0 ? recentActivity / baseActivity : 0;

  // Candle-pressure proxy: combines signed body and close location, weighted
  // by turnover. Gate.io candle data does not expose aggressor-side buy volume,
  // so this is deliberately described as price/turnover pressure, not true
  // taker-buy volume.
  const pressure = (facts) => {
    const weighted = facts.reduce((acc, f) => {
      const bodyPressure = (f.bullish ? 1 : f.bearish ? -1 : 0) *
        Math.abs(f.closePosition - 0.5) * 0.7;
      const closePressure = (f.closePosition - 0.5) * 1.3;
      const weight = Math.max(f.activity, 0);
      acc.weighted += (bodyPressure + closePressure) * weight;
      acc.weight += weight;
      return acc;
    }, { weighted: 0, weight: 0 });
    return weighted.weight > 0 ? weighted.weighted / weighted.weight : 0;
  };

  const basePressure = pressure(baseFacts);
  const recentPressure = pressure(recentFacts);
  const pressureImproving = recentPressure >= basePressure + 0.035 || recentPressure >= 0.12;

  let higherLowSteps = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].low > recent[i - 1].low) higherLowSteps++;
  }

  const bullishRecent = recent.filter((c) => c.close > c.open).length;
  const averageRecentClosePosition = mean(recentFacts.map((f) => f.closePosition));
  const recentDemand =
    pressureImproving &&
    averageRecentClosePosition >= 0.55 &&
    bullishRecent >= 1 &&
    (higherLowSteps >= 1 || averageRecentClosePosition >= 0.64);

  // Quiet/rest phase: accepts a shallow correction after an earlier rally.
  // It rejects a still-active steep selloff, not the fact that a rally existed.
  const baseWasResting =
    baseRangePct <= dynamicRangeLimit &&
    baseAverageRangePct <= Math.max(contextAverageRangePct * 1.35, 0.35) &&
    baseReturn >= -maxRestCorrectionPct &&
    baseReturn <= 4.0 &&
    base.at(-1).close >= baseLow * 1.002;

  const triggerReturn = pct(trigger.close, trigger.open);
  const last4Return = pct(trigger.close, candles.at(-4).open);
  const distanceFromBaseHigh = pct(trigger.close, baseHigh);
  const nearBaseHigh = distanceFromBaseHigh >= -3.5 && distanceFromBaseHigh <= 2.0;

  // No single huge candle is required. A modest pickup is enough when the
  // preceding candles already show improving pressure and price behavior.
  const activityImproving =
    recentActivityRatio >= 0.88 &&
    triggerActivityRatio >= 0.78;
  const triggerNotExhausted =
    triggerReturn >= -0.65 &&
    triggerReturn <= 1.8 &&
    last4Return <= 3.5 &&
    triggerFacts.upperWick <= 0.38 &&
    triggerFacts.closePosition >= 0.52;

  // Type A: accumulation is strengthening just below the range ceiling.
  // Type B: the first small close above the ceiling after the same quiet base.
  const earlyAccumulation =
    baseWasResting &&
    recentDemand &&
    activityImproving &&
    nearBaseHigh &&
    trigger.close <= baseHigh * 1.002 &&
    triggerNotExhausted;

  const freshBaseBreakout =
    baseWasResting &&
    recentDemand &&
    activityImproving &&
    trigger.close > baseHigh * 1.0005 &&
    trigger.close <= baseHigh * 1.025 &&
    trigger.close > trigger.open &&
    triggerFacts.closePosition >= 0.68 &&
    triggerReturn <= 1.8 &&
    last4Return <= 3.5 &&
    triggerFacts.upperWick <= 0.28;

  if (!earlyAccumulation && !freshBaseBreakout) return null;

  const type = freshBaseBreakout ? 'FRESH_BASE_BREAKOUT' : 'EARLY_ACCUMULATION';
  const quality =
    (baseWasResting ? 3 : 0) +
    (recentDemand ? 3 : 0) +
    (pressureImproving ? 2 : 0) +
    (activityImproving ? 1 : 0) +
    (higherLowSteps >= 1 ? 1 : 0) +
    (higherLowSteps >= 2 ? 1 : 0) +
    (averageRecentClosePosition >= 0.62 ? 1 : 0) +
    (triggerFacts.closePosition >= 0.72 ? 1 : 0) +
    (triggerActivityRatio >= 1.15 ? 1 : 0) +
    (freshBaseBreakout ? 2 : 0);

  return {
    type,
    quality,
    confirmation: quality,
    recentReturn: last4Return,
    activityRatio: triggerActivityRatio,
    recentActivityRatio,
    directionalActivityRatio: recentActivityRatio,
    closeStrength: triggerFacts.closePosition,
    higherLowSteps,
    distanceFromBaseHigh,
    baseRangePct,
    baseReturn,
    basePressure,
    recentPressure,
    evidence: {
      baseWasResting,
      recentDemand,
      pressureImproving,
      activityImproving,
      nearBaseHigh,
      earlyAccumulation,
      freshBaseBreakout,
      higherLowSteps,
      bullishRecent,
      averageRecentClosePosition,
      triggerActivityRatio,
      recentActivityRatio,
      distanceFromBaseHigh,
      // Diagnostic only: historical growth is intentionally not a rejection.
      prior12hReturn: pct(candles.at(-1).close, candles.at(-13).close),
      prior24hReturn: pct(candles.at(-1).close, candles.at(-25).close),
    },
  };
}

function analyzeMarket(symbol, candles, btcCandles) {
  const relative = relativeStrength(candles, btcCandles);
  if (!relative) return null;
  if (!relative.confirmed && !relative.conditionalConfirmed) return null;

  const structure = detectHourlyStructure(candles);
  if (!structure) return null;

  const relativeQuality =
    (relative.relative1h >= 0.10 ? 1 : 0) +
    (relative.relative3h >= 0.20 ? 1 : 0) +
    (relative.relative6h >= 0.35 ? 2 : relative.relative6h >= 0.10 ? 1 : 0) +
    (relative.relative12h >= 0.25 ? 1 : 0) +
    (relative.resilience || relative.independentDemand || relative.outperformance ? 1 : 0);
  const totalQuality = structure.quality * 2 + relativeQuality;

  return { symbol, structure, relative, totalQuality };
}

/**
 * MOTOR 2 — independent ranking layer.
 * It consumes Motor 1 candidates and their already-closed hourly candles.
 * It never changes Motor 1 detection, qualification, or scoring.
 * Its report prioritizes gradual early advances while price remains below
 * the local base ceiling; post-breakout candidates are not reported here.
 */
function rankEarlyMoveCandidates(candidates, candlesBySymbol) {
  const ranked = [];

  for (const candidate of candidates) {
    const candles = candlesBySymbol.get(candidate.symbol);
    if (!Array.isArray(candles) || candles.length < 8) continue;

    const structure = candidate.structure;
    const evidence = structure.evidence || {};
    const last = candles.at(-1);

    // Motor 2 only reports pre-breakout behavior. This is a reporting-layer
    // decision; the candidate remains intact in Motor 1's results/logs.
    if (evidence.freshBaseBreakout || structure.distanceFromBaseHigh >= 0) continue;

    const recent = candles.slice(-6);
    let higherLowSteps = 0;
    let risingCloseSteps = 0;
    let bullishBars = 0;
    let closePositionTotal = 0;
    let totalAbsoluteChange = 0;

    for (let i = 0; i < recent.length; i++) {
      const candle = recent[i];
      const range = Math.max(candle.high - candle.low, Number.EPSILON);
      closePositionTotal += clamp((candle.close - candle.low) / range, 0, 1);
      if (candle.close > candle.open) bullishBars++;
      if (i > 0) {
        if (candle.low > recent[i - 1].low) higherLowSteps++;
        if (candle.close > recent[i - 1].close) risingCloseSteps++;
        totalAbsoluteChange += Math.abs(pct(candle.close, recent[i - 1].close));
      }
    }

    const netMove = pct(last.close, recent[0].open);
    const efficiency = totalAbsoluteChange > 0 ? Math.max(0, netMove) / totalAbsoluteChange : 0;
    const averageClosePosition = closePositionTotal / recent.length;

    // A candidate must already be progressing, not merely sitting under
    // resistance with a promising-looking pressure reading.
    if (netMove <= 0 || (risingCloseSteps < 2 && higherLowSteps < 1)) continue;
    const recentPressureGain = structure.recentPressure - structure.basePressure;
    const relative6h = candidate.relative.relative6h ?? 0;
    const headroom = Math.abs(structure.distanceFromBaseHigh);

    // Score favors a measured upward progression, repeated higher lows,
    // improving buyer pressure and a still-unbroken nearby ceiling.
    const progressionScore =
      clamp(risingCloseSteps / 5, 0, 1) * 18 +
      clamp(higherLowSteps / 5, 0, 1) * 17 +
      clamp(bullishBars / 6, 0, 1) * 8 +
      clamp((averageClosePosition - 0.45) / 0.35, 0, 1) * 10;

    // Prefer a real but still modest advance. Flat/no-progress and already
    // extended moves score lower; a single oversized candle is not rewarded.
    let moveScore = 0;
    if (netMove >= 0.10 && netMove <= 2.20) {
      moveScore = 20 * (1 - Math.abs(netMove - 0.85) / 1.55);
      moveScore = clamp(moveScore, 0, 20);
    } else if (netMove > 2.20 && netMove <= 3.00) {
      moveScore = clamp(8 * (3.00 - netMove) / 0.80, 0, 8);
    }

    const pressureScore = clamp(recentPressureGain / 0.25, 0, 1) * 12;
    const persistenceScore = clamp(efficiency / 0.65, 0, 1) * 8;
    const headroomScore =
      headroom >= 0.15 && headroom <= 3.5
        ? 10 * (1 - Math.abs(headroom - 1.4) / 2.1)
        : 0;
    const relativeScore = clamp((relative6h + 1.0) / 3.0, 0, 1) * 7;

    const rankScore = progressionScore + moveScore + pressureScore +
      persistenceScore + headroomScore + relativeScore;

    ranked.push({ ...candidate, rankScore, motor2Metrics: {
      netMove, higherLowSteps, risingCloseSteps, bullishBars,
      averageClosePosition, recentPressureGain, headroom,
    }});
  }

  return ranked.sort((a, b) =>
    b.rankScore - a.rankScore ||
    b.motor2Metrics.higherLowSteps - a.motor2Metrics.higherLowSteps ||
    b.motor2Metrics.risingCloseSteps - a.motor2Metrics.risingCloseSteps ||
    a.symbol.localeCompare(b.symbol)
  );
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
  console.log('Mode: CLOSED 1h behavior detection (Motor 1) + independent pre-breakout early-move ranking (Motor 2) | max 10 symbols');

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
  const candidateCandles = new Map();
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const candles = await getClosedHourlyCandles(market.symbol);
    if (candles.length < CONFIG.MIN_CANDLES) return null;
    checked++;
    const analysis = analyzeMarket(market.symbol, candles, btcCandles);
    // Preserve closed candles for Motor 2 without changing Motor 1's result.
    if (analysis) candidateCandles.set(market.symbol, candles);
    return analysis;
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

  // Motor 2 ranks Motor 1's candidates independently. Its ranking and
  // pre-breakout report do not feed back into Motor 1.
  const motor2Ranked = rankEarlyMoveCandidates(candidates, candidateCandles);
  const selected = motor2Ranked.slice(0, CONFIG.MOTOR2_MAX_RESULTS);
  const telegramSymbols = selected.map((item, index) =>
    `${index + 1} — ${item.symbol.replace(/_USDT$/, '')}`
  );

  console.log(`Contracts received from Gate.io: ${contracts.length}`);
  console.log(`Contracts explicitly classified as active crypto: ${cryptoContracts.length}`);
  console.log(`Contracts rejected (non-crypto, unknown type, or inactive): ${rejectedNonCryptoOrUnknown}`);
  console.log(`Crypto contracts missing ticker data: ${rejectedMissingTicker}`);
  console.log(`Crypto markets eligible by 24h liquidity: ${markets.length}`);
  console.log(`Markets analyzed with sufficient hourly candles: ${checked}`);
  console.log(`Markets with data errors: ${failed}`);
  console.log(`Qualified hourly bullish structures: ${candidates.length}`);
  console.log(`Motor 1 qualified candidates: ${candidates.length}`);
  console.log(`Motor 2 pre-breakout ranked candidates: ${motor2Ranked.length}`);
  console.log(`Motor 2 selected symbols: ${telegramSymbols.length}`);

  if (candidates.length) {
    console.log('Motor 1 candidates (diagnostic only; unchanged detection order):');
    for (const item of candidates) {
      console.log(
        `${item.symbol} | ${item.structure.type} | quality=${item.totalQuality} | ` +
        `relative1h=${item.relative.relative1h.toFixed(2)}% | ` +
        `relative3h=${item.relative.relative3h.toFixed(2)}% | ` +
        `relative6h=${item.relative.relative6h.toFixed(2)}% | ` +
        `baseRange=${item.structure.baseRangePct.toFixed(2)}% | ` +
        `pressure=${item.structure.basePressure.toFixed(3)}>${item.structure.recentPressure.toFixed(3)}`
      );
    }
  }

  if (telegramSymbols.length) {
    await sendTelegram(telegramSymbols);
    console.log('Telegram message sent:', telegramSymbols.join(', '));
  } else {
    console.log('No pre-breakout candidate qualified for Motor 2 ranking; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
