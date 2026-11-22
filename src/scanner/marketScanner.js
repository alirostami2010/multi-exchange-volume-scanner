/**
 * GATE.IO USDT PERPETUAL — HOURLY BEHAVIOR STAGE SCANNER
 * ----------------------------------------------------
 * Uses fully closed 1h candles only.
 * Each market is compared with its own preceding hourly behavior.
 * Volume is diagnostic only and is never a mandatory bullish condition.
 * BTC relative strength is contextual/ranking information, not a hard gate.
 * No entry, trade signal, or price target is produced.
 * Node.js 20+
 */

import 'dotenv/config';

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',
  TIMEFRAME: '1h',
  CANDLE_SECONDS: 3600,
  CANDLE_LIMIT: 96,
  MIN_CANDLES: 48,
  MIN_QUOTE_VOLUME_24H: 100000,
  ALLOWED_CRYPTO_CONTRACT_TYPES: new Set(['crypto', 'cryptocurrency']),
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,
  MAX_RESULTS: 5,
  // Comparison windows: latest 4 closed candles vs preceding 20 closed candles.
  RECENT_BARS: 4,
  HISTORY_BARS: 20,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const pct = (current, previous) => previous > 0 ? (current / previous - 1) * 100 : 0;
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const candleRangePct = (c) => c.close > 0 ? ((c.high - c.low) / c.close) * 100 : 0;

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
      if (attempt < CONFIG.RETRIES) await sleep(error.status === 429 ? 1800 * attempt : 600 * attempt);
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

function isSupportedCryptoContract(contract) {
  const name = String(contract?.name ?? '').trim().toUpperCase();
  const classification = String(contract?.contract_type ?? '')
    .trim().toLowerCase().replace(/[\s-]+/g, '_');
  const active = String(contract?.status ?? '').toLowerCase() === 'trading' &&
    contract?.in_delisting !== true;
  const validName = /^[A-Z0-9]{2,30}_USDT$/.test(name);
  if (!active || !validName) return false;
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

  // Gate.io t is the candle opening time. Exclude the currently forming hour.
  const currentBucket = Math.floor(Date.now() / CONFIG.CANDLE_SECONDS) * CONFIG.CANDLE_SECONDS;
  const byTime = new Map();
  for (const item of raw) {
    const candle = {
      time: num(item.t), open: num(item.o), high: num(item.h), low: num(item.l),
      close: num(item.c), volume: num(item.v), turnover: num(item.sum),
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
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function candleFacts(c) {
  const range = Math.max(c.high - c.low, Number.EPSILON);
  const body = c.close - c.open;
  const bodyRatio = body / range;
  const closePosition = clamp((c.close - c.low) / range, 0, 1);
  const lowerWick = clamp((Math.min(c.open, c.close) - c.low) / range, 0, 1);
  const upperWick = clamp((c.high - Math.max(c.open, c.close)) / range, 0, 1);
  return { bullish: body > 0, bearish: body < 0, bodyRatio, closePosition, lowerWick, upperWick, rangePct: candleRangePct(c) };
}

function alignCandles(coinCandles, btcCandles) {
  const btcByTime = new Map(btcCandles.map((c) => [c.time, c]));
  return coinCandles.filter((c) => btcByTime.has(c.time))
    .map((coin) => ({ coin, btc: btcByTime.get(coin.time) }))
    .sort((a, b) => a.coin.time - b.coin.time);
}

function relativeStrength(coinCandles, btcCandles) {
  const aligned = alignCandles(coinCandles, btcCandles);
  if (aligned.length < 14) return null;
  const move = (bars) => {
    if (aligned.length < bars + 1) return null;
    const now = aligned.at(-1);
    const before = aligned.at(-(bars + 1));
    const coinMove = pct(now.coin.close, before.coin.close);
    const btcMove = pct(now.btc.close, before.btc.close);
    return { coinMove, btcMove, relative: coinMove - btcMove };
  };
  const one = move(1);
  const three = move(3);
  const six = move(6);
  const twelve = move(12);
  return {
    relative1h: one?.relative ?? 0,
    relative3h: three?.relative ?? 0,
    relative6h: six?.relative ?? 0,
    relative12h: twelve?.relative ?? 0,
    coin6h: six?.coinMove ?? 0,
    btc6h: six?.btcMove ?? 0,
    btcCondition: (six?.btcMove ?? 0) <= -0.45 ? 'DOWN' : (six?.btcMove ?? 0) >= 0.45 ? 'UP' : 'FLAT',
  };
}

// A volume-neutral candle behavior measure: candle body direction + close location.
// It deliberately does not infer actual aggressive buyer/seller volume.
function directionalPressure(candles) {
  const facts = candles.map(candleFacts);
  return mean(facts.map((f) => (f.bodyRatio * 0.55) + ((f.closePosition - 0.5) * 0.9)));
}

function countHigherLowSteps(candles) {
  let count = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i].low > candles[i - 1].low) count++;
  return count;
}

function countLowerLowSteps(candles) {
  let count = 0;
  for (let i = 1; i < candles.length; i++) if (candles[i].low < candles[i - 1].low) count++;
  return count;
}

/**
 * Compare the latest four closed hourly candles with the preceding twenty
 * closed hourly candles of the SAME market. The latest candle is included in
 * the recent window; no unfinished candle or sub-hour data is used.
 */
function detectBehaviorStage(candles) {
  if (!Array.isArray(candles) || candles.length < CONFIG.MIN_CANDLES) return null;

  const recent = candles.slice(-CONFIG.RECENT_BARS);
  const history = candles.slice(-(CONFIG.RECENT_BARS + CONFIG.HISTORY_BARS), -CONFIG.RECENT_BARS);
  if (recent.length !== 4 || history.length !== 20) return null;

  const latest = recent.at(-1);
  const recentFacts = recent.map(candleFacts);
  const historyFacts = history.map(candleFacts);
  const recentRange = mean(recentFacts.map((f) => f.rangePct));
  const historyRange = mean(historyFacts.map((f) => f.rangePct));
  const recentPressure = directionalPressure(recent);
  const historyPressure = directionalPressure(history);
  const pressureChange = recentPressure - historyPressure;

  const historyLow = Math.min(...history.map((c) => c.low));
  const recentLow = Math.min(...recent.map((c) => c.low));
  const historyHigh = Math.max(...history.map((c) => c.high));
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentReturn = pct(latest.close, recent[0].open);
  const historyReturn = pct(history.at(-1).close, history[0].open);
  const recentHigherLows = countHigherLowSteps(recent);
  const recentLowerLows = countLowerLowSteps(recent);
  const recentBullish = recentFacts.filter((f) => f.bullish).length;
  const recentBearish = recentFacts.filter((f) => f.bearish).length;
  const averageRecentClose = mean(recentFacts.map((f) => f.closePosition));
  const averageHistoryClose = mean(historyFacts.map((f) => f.closePosition));
  const lowerWickRecent = mean(recentFacts.map((f) => f.lowerWick));
  const upperWickRecent = mean(recentFacts.map((f) => f.upperWick));

  // Is the market relatively quiet compared with its own preceding behavior?
  const quiet = historyRange > 0 && recentRange <= historyRange * 0.82 &&
    Math.abs(recentReturn) <= Math.max(historyRange * 2.2, 0.8);

  // Sellers lose effectiveness when downside attempts stop extending lows,
  // bearish closes weaken, and lower prices are rejected more often.
  const downsideContained = recentLow >= historyLow * 0.997 || recentLowerLows <= 1;
  const bearishPressureEasing = historyPressure <= -0.03 &&
    pressureChange >= 0.05 &&
    (averageRecentClose >= averageHistoryClose - 0.02 || lowerWickRecent >= 0.22);
  const sellersWeakening = downsideContained && bearishPressureEasing &&
    (recentLowerLows <= 1 || lowerWickRecent >= 0.28);

  // Buyers improve without requiring a breakout or volume spike.
  const buyersStrengthening = pressureChange >= 0.10 &&
    averageRecentClose >= 0.57 &&
    (recentHigherLows >= 1 || recentBullish >= 2);

  const buyerControl = sellersWeakening && buyersStrengthening &&
    recentReturn >= -1.2 && latest.close >= recentLow * 1.004;

  // A move is considered underway only when price has expanded beyond the
  // recent structure; this stage is reported separately from early transition.
  const breakout = latest.close > historyHigh * 1.002 &&
    recentReturn >= 1.0 && averageRecentClose >= 0.66 && upperWickRecent <= 0.38;

  let stage;
  let stageLabel;
  if (breakout) {
    stage = 'MOVE_STARTED';
    stageLabel = 'شروع حرکت';
  } else if (buyerControl) {
    stage = 'EARLY_BULLISH_TRANSITION';
    stageLabel = 'انتقال قدرت به خریداران';
  } else if (buyersStrengthening) {
    stage = 'BUYERS_STRENGTHENING';
    stageLabel = 'تقویت تدریجی خریداران';
  } else if (sellersWeakening) {
    stage = 'SELLERS_WEAKENING';
    stageLabel = 'ضعیف‌شدن فروشندگان';
  } else if (quiet) {
    stage = 'STAGNATION';
    stageLabel = 'سکون / تراکم';
  } else {
    stage = 'NO_CLEAR_STAGE';
    stageLabel = 'مرحله نامشخص';
  }

  // Simple explainable score for ordering within a stage, not a trade signal.
  const score = Math.round(
    (sellersWeakening ? 3 : 0) +
    (buyersStrengthening ? 3 : 0) +
    (buyerControl ? 2 : 0) +
    (quiet ? 1 : 0) +
    (recentHigherLows >= 2 ? 1 : 0) +
    (averageRecentClose >= 0.64 ? 1 : 0) +
    (pressureChange >= 0.18 ? 1 : 0)
  );

  // Turnover is returned for diagnostics only; it has no effect on stage/score.
  const avgTurnover = (bars) => mean(bars.map((c) => c.turnover > 0 ? c.turnover : c.volume));
  const historyActivity = avgTurnover(history);
  const recentActivity = avgTurnover(recent);
  const activityRatio = historyActivity > 0 ? recentActivity / historyActivity : null;

  return {
    stage, stageLabel, score, recentReturn, historyReturn,
    recentRange, historyRange, rangeRatio: historyRange > 0 ? recentRange / historyRange : null,
    recentPressure, historyPressure, pressureChange,
    recentHigherLows, recentLowerLows, recentBullish, recentBearish,
    averageRecentClose, averageHistoryClose,
    distanceFromHistoryHigh: pct(latest.close, historyHigh),
    activityRatio,
    evidence: { quiet, sellersWeakening, buyersStrengthening, buyerControl, breakout, downsideContained, bearishPressureEasing },
  };
}

function analyzeMarket(symbol, candles, btcCandles) {
  const stage = detectBehaviorStage(candles);
  if (!stage || stage.stage === 'NO_CLEAR_STAGE') return null;
  const relative = relativeStrength(candles, btcCandles);
  const relativeBonus = relative
    ? (relative.relative1h > 0.05 ? 1 : 0) + (relative.relative3h > 0.10 ? 1 : 0) +
      (relative.relative6h > 0.20 ? 1 : 0)
    : 0;
  // Early stages rank ahead of an already-running move; relative strength only breaks ties.
  const stagePriority = {
    EARLY_BULLISH_TRANSITION: 5,
    BUYERS_STRENGTHENING: 4,
    SELLERS_WEAKENING: 3,
    STAGNATION: 2,
    MOVE_STARTED: 1,
  }[stage.stage] ?? 0;
  return { symbol, stage, relative, rank: stagePriority * 100 + stage.score * 3 + relativeBonus };
}

function formatTelegram(item) {
  const relative = item.relative ? ` | قدرت نسبی ۶ساعته: ${item.relative.relative6h.toFixed(2)}٪` : '';
  return `${item.symbol.replace(/_USDT$/, '')} — ${item.stage.stageLabel} | امتیاز رفتاری: ${item.stage.score}${relative}`;
}

async function sendTelegram(lines) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`);
}

async function main() {
  console.log('\nGATE.IO HOURLY BEHAVIOR STAGE SCANNER');
  console.log('Mode: each market compared with its own prior CLOSED 1h candles; volume is diagnostic only.');

  const [contracts, tickers] = await Promise.all([getContracts(), getTickers()]);
  if (!Array.isArray(contracts) || !Array.isArray(tickers)) throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');

  const tickerMap = new Map(tickers.map((ticker) => [ticker.contract, ticker]));
  const namedContracts = contracts.filter((c) => c?.name);
  const cryptoContracts = namedContracts.filter(isSupportedCryptoContract);
  const rejectedNonCryptoOrInactive = namedContracts.length - cryptoContracts.length;
  const rejectedMissingTicker = cryptoContracts.filter((c) => !tickerMap.has(c.name)).length;
  const markets = cryptoContracts
    .filter((c) => c.name !== 'BTC_USDT' && tickerMap.has(c.name))
    .map((c) => ({ symbol: c.name, quoteVolume: num(tickerMap.get(c.name).volume_24h_quote) }))
    .filter((m) => m.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const btcContract = contracts.find((c) => c?.name === 'BTC_USDT');
  if (!btcContract || !isSupportedCryptoContract(btcContract)) throw new Error('قرارداد مرجع BTC_USDT در Gate.io تأیید نشد.');
  const btcCandles = await getClosedHourlyCandles('BTC_USDT');
  if (btcCandles.length < CONFIG.MIN_CANDLES) throw new Error('کندل بسته‌شده یک‌ساعته کافی برای بیت‌کوین دریافت نشد.');

  let checked = 0;
  let failed = 0;
  const results = await mapLimit(markets, CONFIG.CONCURRENCY, async (market) => {
    const candles = await getClosedHourlyCandles(market.symbol);
    if (candles.length < CONFIG.MIN_CANDLES) return null;
    checked++;
    return analyzeMarket(market.symbol, candles, btcCandles);
  });
  for (const result of results) if (result?.error) failed++;

  const candidates = results.filter((r) => r && !r.error)
    .sort((a, b) => b.rank - a.rank || b.stage.score - a.stage.score || a.symbol.localeCompare(b.symbol));
  const selected = candidates.slice(0, CONFIG.MAX_RESULTS);
  const telegramLines = selected.map(formatTelegram);

  const stageCounts = candidates.reduce((acc, item) => {
    acc[item.stage.stage] = (acc[item.stage.stage] || 0) + 1;
    return acc;
  }, {});

  console.log(`Gate.io contracts: ${contracts.length}`);
  console.log(`Active crypto contracts: ${cryptoContracts.length}`);
  console.log(`Rejected non-crypto/inactive/unknown: ${rejectedNonCryptoOrInactive}`);
  console.log(`Crypto contracts missing ticker: ${rejectedMissingTicker}`);
  console.log(`Markets eligible by minimum 24h liquidity: ${markets.length}`);
  console.log(`Markets analyzed with ${CONFIG.TIMEFRAME} closed candles: ${checked}`);
  console.log(`Markets with data errors: ${failed}`);
  console.log(`Classified candidates: ${candidates.length}`);
  console.log('Stage counts:', JSON.stringify(stageCounts));

  if (candidates.length) {
    console.log('Ranked behavioral stages:');
    for (const item of candidates) {
      const s = item.stage;
      console.log(
        `${item.symbol} | ${s.stage} | score=${s.score} | ` +
        `pressure=${s.historyPressure.toFixed(3)} -> ${s.recentPressure.toFixed(3)} | ` +
        `rangeRatio=${s.rangeRatio == null ? 'n/a' : s.rangeRatio.toFixed(2)} | ` +
        `higherLows=${s.recentHigherLows} | activityRatio(diagnostic)=${s.activityRatio == null ? 'n/a' : s.activityRatio.toFixed(2)}`
      );
    }
  }

  if (telegramLines.length) {
    await sendTelegram(telegramLines);
    console.log('Telegram message sent.');
  } else {
    console.log('No market showed a sufficiently clear behavioral stage; no Telegram message sent.');
  }
}

main().catch((error) => {
  console.error('SCANNER FAILED:', error);
  process.exitCode = 1;
});
