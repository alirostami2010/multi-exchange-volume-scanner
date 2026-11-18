
/**
 * GATE.IO USDT PERPETUAL — EARLY BULLISH TREND SCANNER
 * ---------------------------------------------------
 * هدف: شناسایی ارزهایی که در وضعیت فعلی بازار در ابتدای
 * روند صعودی قرار دارند.
 *
 * بدون منطق انباشت، جذب عرضه یا تحلیل چرخه تاریخی.
 *
 * File: src/scanner/marketScanner.js
 * Node.js 20+
 */

import 'dotenv/config';

import { saveMarketSnapshot } from '../storage/marketStorage.js';

// ========================
// CONFIG
// ========================

const CONFIG = {
  API_BASE: 'https://api.gateio.ws/api/v4',

  TIMEFRAMES: {
    '15m': { seconds: 900, limit: 100 },
    '1h': { seconds: 3600, limit: 100 },
    '4h': { seconds: 14400, limit: 100 },
  },

  TOP_COUNT: 20,
  MIN_QUOTE_VOLUME_24H: 100000,
  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3500,
  TELEGRAM_DELAY: 400,

  MIN_SCORE: 58,

  // سقف رشد برای جلوگیری از انتخاب حرکت‌های دیرهنگام
  MAX_RETURN_15M: 4,
  MAX_RETURN_1H: 6,
  MAX_RETURN_4H: 12,
};

// ========================
// HELPERS
// ========================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const average = (values) =>
  values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;

const median = (values) => {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pctChange = (current, previous) => {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
};

const formatPrice = (value) => {
  if (!Number.isFinite(value)) return '-';
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(5);
  if (value >= 0.001) return value.toFixed(7);
  return value.toPrecision(5);
};

// ========================
// HTTP
// ========================

async function fetchJSON(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT),
      });

      if (!response.ok) {
        const body = await response.text();
        const error = new Error(
          `HTTP ${response.status}: ${body.slice(0, 200)}`
        );

        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;

      if (attempt < CONFIG.RETRIES) {
        await sleep(
          error.status === 429 ? 2500 * attempt : 700 * attempt
        );
      }
    }
  }

  throw lastError;
}

// ========================
// GATE.IO DATA
// ========================

async function getContracts() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/contracts`);
}

async function getTickers() {
  return fetchJSON(`${CONFIG.API_BASE}/futures/usdt/tickers`);
}

async function getCandles(contract, interval, limit) {
  const params = new URLSearchParams({
    contract,
    interval,
    limit: String(limit),
  });

  const raw = await fetchJSON(
    `${CONFIG.API_BASE}/futures/usdt/candlesticks?${params}`
  );

  if (!Array.isArray(raw)) {
    throw new Error(`Invalid candle response: ${contract} ${interval}`);
  }

  const candles = raw
    .map((c) => ({
      time: number(c.t),
      open: number(c.o),
      high: number(c.h),
      low: number(c.l),
      close: number(c.c),
      volume: number(c.v),
      turnover: number(c.sum),
    }))
    .filter((c) =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    )
    .sort((a, b) => a.time - b.time);

  // فقط کندل‌های بسته‌شده
  const intervalSeconds = CONFIG.TIMEFRAMES[interval].seconds;
  const currentBucket =
    Math.floor(Date.now() / 1000 / intervalSeconds) * intervalSeconds;

  return candles.filter((c) => c.time < currentBucket);
}

// ========================
// CONCURRENCY
// ========================

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = {
          error: error.message,
          item: items[index],
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => runner()
    )
  );

  return results;
}

// ========================
// INDICATORS
// ========================

function calculateEMA(values, period) {
  if (values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const result = [];

  let ema = average(values.slice(0, period));
  result.push(ema);

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result.push(ema);
  }

  return result;
}

function getVolumeRatio(candles) {
  if (candles.length < 25) return 0;

  const recent = candles.slice(-3);
  const baseline = candles.slice(-23, -3);

  const valueOf = (c) =>
    c.turnover > 0 ? c.turnover : c.volume;

  const recentAverage = average(recent.map(valueOf));
  const baselineMedian = median(baseline.map(valueOf));

  if (baselineMedian <= 0) return 0;

  return recentAverage / baselineMedian;
}

function getCandleStrength(candle) {
  const range = candle.high - candle.low;

  if (range <= 0) {
    return {
      closeLocation: 0,
      bodyRatio: 0,
      bullish: false,
    };
  }

  return {
    closeLocation: clamp(
      (candle.close - candle.low) / range,
      0,
      1
    ),

    bodyRatio: clamp(
      Math.abs(candle.close - candle.open) / range,
      0,
      1
    ),

    bullish: candle.close > candle.open,
  };
}

// ========================
// PRICE STRUCTURE
// ========================

function findSwingPoints(candles, radius = 2) {
  const highs = [];
  const lows = [];

  for (
    let i = radius;
    i < candles.length - radius;
    i++
  ) {
    const current = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= radius; j++) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) highs.push(current.high);
    if (isLow) lows.push(current.low);
  }

  return { highs, lows };
}

function analyzeStructure(candles) {
  if (candles.length < 25) {
    return {
      higherHigh: false,
      higherLow: false,
      breakout: false,
      bullishStructure: false,
      score: 0,
    };
  }

  const recent = candles.slice(-35);
  const swings = findSwingPoints(recent, 2);

  const highs = swings.highs;
  const lows = swings.lows;

  const higherHigh =
    highs.length >= 2 &&
    highs[highs.length - 1] > highs[highs.length - 2];

  const higherLow =
    lows.length >= 2 &&
    lows[lows.length - 1] > lows[lows.length - 2];

  const previous = candles.slice(-13, -1);
  const resistance = Math.max(
    ...previous.map((c) => c.high)
  );

  const last = candles[candles.length - 1];

  const breakout =
    resistance > 0 &&
    last.close > resistance &&
    last.close > last.open;

  const bullishStructure =
    (higherHigh && higherLow) ||
    (breakout && higherLow);

  let score = 0;
  if (higherHigh) score += 30;
  if (higherLow) score += 30;
  if (breakout) score += 40;

  return {
    higherHigh,
    higherLow,
    breakout,
    bullishStructure,
    resistance,
    score,
  };
}

// ========================
// TIMEFRAME ANALYSIS
// ========================

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 30) return null;

  const closes = candles.map((c) => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);

  if (ema9.length < 3 || ema21.length < 3) return null;

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 2];

  const currentEma9 = ema9[ema9.length - 1];
  const currentEma21 = ema21[ema21.length - 1];
  const previousEma21 = ema21[ema21.length - 2];

  const emaBullish =
    last.close > currentEma9 &&
    currentEma9 > currentEma21;

  const emaSlope =
    currentEma21 > previousEma21;

  const structure = analyzeStructure(candles);
  const volumeRatio = getVolumeRatio(candles);
  const strength = getCandleStrength(last);

  return {
    price: last.close,
    emaBullish,
    emaSlope,
    structure,
    volumeRatio,
    strength,

    returns: {
      return1: pctChange(last.close, previous.close),
      return4: pctChange(
        last.close,
        candles[candles.length - 5].close
      ),
      return16: pctChange(
        last.close,
        candles[candles.length - 17].close
      ),
    },
  };
}

// ========================
// EARLY BULLISH SCORING
// ========================

function analyzeCoin(data) {
  const { symbol, candles } = data;

  const tf15 = analyzeTimeframe(candles['15m']);
  const tf1h = analyzeTimeframe(candles['1h']);
  const tf4h = analyzeTimeframe(candles['4h']);

  if (!tf15 || !tf1h || !tf4h) return null;

  let score = 0;
  const evidence = [];
  const warnings = [];

  // ساختار صعودی یک‌ساعته
  if (tf1h.structure.higherHigh) {
    score += 10;
    evidence.push('سقف بالاتر 1H');
  }

  if (tf1h.structure.higherLow) {
    score += 12;
    evidence.push('کف بالاتر 1H');
  }

  if (tf1h.structure.breakout) {
    score += 12;
    evidence.push('شکست سقف اخیر 1H');
  }

  // شروع حرکت در ۱۵ دقیقه
  if (tf15.structure.higherLow) {
    score += 7;
    evidence.push('کف بالاتر 15M');
  }

  if (tf15.structure.breakout) {
    score += 8;
    evidence.push('شکست کوتاه‌مدت 15M');
  }

  if (
    tf15.strength.bullish &&
    tf15.strength.closeLocation >= 0.75
  ) {
    score += 5;
    evidence.push('بسته‌شدن قدرتمند کندل 15M');
  }

  // وضعیت چهار ساعته
  if (tf4h.emaBullish) {
    score += 7;
    evidence.push('وضعیت مثبت EMA در 4H');
  }

  if (tf4h.structure.higherLow) {
    score += 5;
    evidence.push('حفظ کف بالاتر 4H');
  }

  // EMA کوتاه‌مدت
  if (tf1h.emaBullish) {
    score += 7;
    evidence.push('EMA صعودی 1H');
  }

  if (tf1h.emaSlope) {
    score += 4;
    evidence.push('شیب مثبت EMA 1H');
  }

  if (tf15.emaBullish) {
    score += 4;
    evidence.push('EMA صعودی 15M');
  }

  // افزایش حجم
  if (tf1h.volumeRatio >= 1.5) {
    score += 7;
    evidence.push(
      `افزایش حجم 1H (${tf1h.volumeRatio.toFixed(2)}x)`
    );
  } else if (tf1h.volumeRatio >= 1.15) {
    score += 4;
    evidence.push(
      `بهبود حجم 1H (${tf1h.volumeRatio.toFixed(2)}x)`
    );
  }

  if (tf15.volumeRatio >= 1.5) {
    score += 5;
    evidence.push(
      `افزایش حجم 15M (${tf15.volumeRatio.toFixed(2)}x)`
    );
  } else if (tf15.volumeRatio >= 1.15) {
    score += 3;
  }

  // قدرت کندل یک‌ساعته
  if (
    tf1h.strength.bullish &&
    tf1h.strength.closeLocation >= 0.70
  ) {
    score += 5;
    evidence.push('قدرت خریداران در کندل 1H');
  }

  // بازده درست هر بازه زمانی
  const return15m = tf15.returns.return1;
  const return1h = tf15.returns.return4;
  const return4h = tf1h.returns.return4;

  // جریمه رشد بیش از حد
  if (return15m > CONFIG.MAX_RETURN_15M) {
    score -= 12;
    warnings.push('رشد بیش از حد 15M');
  }

  if (return1h > CONFIG.MAX_RETURN_1H) {
    score -= 15;
    warnings.push('رشد بیش از حد 1H');
  }

  if (return4h > CONFIG.MAX_RETURN_4H) {
    score -= 18;
    warnings.push('رشد بیش از حد 4H');
  }

  // ساختار فعلی باید نشانه صعود داشته باشد
  const hasStructure =
    tf1h.structure.higherLow ||
    tf1h.structure.breakout ||
    tf1h.structure.higherHigh;

  if (!hasStructure) {
    score -= 15;
    warnings.push('ساختار صعودی تأیید نشده');
  }

  // حجم پایین در هر دو تایم‌فریم
  if (
    tf1h.volumeRatio < 0.8 &&
    tf15.volumeRatio < 0.8
  ) {
    score -= 10;
    warnings.push('حجم معاملات ضعیف');
  }

  const shortTermPositive =
    tf15.emaBullish ||
    tf15.structure.breakout ||
    tf15.structure.higherLow;

  const hourlyPositive =
    tf1h.emaBullish ||
    tf1h.structure.breakout ||
    tf1h.structure.higherLow;

  if (!shortTermPositive || !hourlyPositive) {
    return null;
  }

  score = Math.round(clamp(score, 0, 100));

  if (score < CONFIG.MIN_SCORE) return null;

  let stage = 'شروع روند صعودی';

  if (
    tf1h.structure.breakout &&
    tf15.structure.breakout
  ) {
    stage = 'شکست اولیه و تأیید صعود';
  } else if (
    tf1h.structure.higherLow &&
    tf15.structure.higherLow
  ) {
    stage = 'تشکیل ساختار صعودی';
  } else if (tf15.structure.breakout) {
    stage = 'اولین نشانه‌های حرکت';
  }

  return {
    symbol,
    score,
    stage,
    price: tf1h.price,

    returns: {
      '15m': return15m,
      '1h': return1h,
      '4h': return4h,
    },

    volume: {
      '15m': tf15.volumeRatio,
      '1h': tf1h.volumeRatio,
    },

    evidence,
    warnings,
  };
}

// ========================
// TELEGRAM
// ========================

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN یا TELEGRAM_CHAT_ID تنظیم نشده است.'
    );
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    const error = new Error(
      result.description || `Telegram HTTP ${response.status}`
    );

    error.retryAfter = result.parameters?.retry_after;
    throw error;
  }
}

function splitTelegramMessage(text, maxLength) {
  const blocks = text.split('\n');
  const messages = [];
  let current = '';

  for (const block of blocks) {
    const candidate = current
      ? `${current}\n${block}`
      : block;

    if (candidate.length > maxLength && current) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }

  if (current) messages.push(current);

  return messages;
}

async function sendReports(report) {
  const messages = splitTelegramMessage(
    report,
    CONFIG.TELEGRAM_MAX_LENGTH
  );

  for (let i = 0; i < messages.length; i++) {
    const header = `📄 گزارش ${i + 1}/${messages.length}\n\n`;

    try {
      await sendTelegram(header + messages[i]);
    } catch (error) {
      if (!error.retryAfter) throw error;

      await sleep(error.retryAfter * 1000 + 500);
      await sendTelegram(header + messages[i]);
    }

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_DELAY);
    }
  }
}

// ========================
// REPORT
// ========================

function buildReport(candidates, stats, duration) {
  const lines = [
    '🚀 GATE.IO | EARLY BULLISH TREND RADAR',
    '━━━━━━━━━━━━━━━━━━',
    '🎯 هدف: شناسایی شروع روند صعودی',
    '⏱ تایم‌فریم‌ها: 15M / 1H / 4H',
    `📊 قراردادهای فعال: ${stats.active}`,
    `💧 واجد شرایط نقدشوندگی: ${stats.liquid}`,
    `🔍 بررسی موفق: ${stats.success}`,
    `⚠️ خطاهای دریافت داده: ${stats.errors}`,
    `🎯 کاندیدهای تأییدشده: ${candidates.length}`,
    `🏆 ارسال به تلگرام: ${Math.min(candidates.length, CONFIG.TOP_COUNT)}`,
    `⏱ زمان اسکن: ${(duration / 1000).toFixed(1)} ثانیه`,
    '━━━━━━━━━━━━━━━━━━',
  ];

  const selected = candidates.slice(0, CONFIG.TOP_COUNT);

  if (!selected.length) {
    lines.push('❌ در این اسکن هیچ ارزی شرایط لازم را نداشت.');
    return lines.join('\n');
  }

  selected.forEach((coin, index) => {
    lines.push('');
    lines.push(
      `${index + 1}. ${coin.symbol} | امتیاز: ${coin.score}/100`
    );
    lines.push(`💰 قیمت: ${formatPrice(coin.price)}`);
    lines.push(`🧭 وضعیت: ${coin.stage}`);

    lines.push(
      `📈 بازده اخیر: 15M ${coin.returns['15m'].toFixed(2)}% | ` +
      `1H ${coin.returns['1h'].toFixed(2)}% | ` +
      `4H ${coin.returns['4h'].toFixed(2)}%`
    );

    lines.push(
      `📊 حجم نسبی: 15M ${coin.volume['15m'].toFixed(2)}x | ` +
      `1H ${coin.volume['1h'].toFixed(2)}x`
    );

    lines.push('🔎 شواهد:');

    for (const item of coin.evidence.slice(0, 5)) {
      lines.push(`  • ${item}`);
    }

    if (coin.warnings.length) {
      lines.push(`⚠️ ${coin.warnings.join('، ')}`);
    }

    lines.push('──────────────────');
  });

  lines.push('');
  lines.push('ℹ️ امتیاز، رتبه‌بندی فنی است و احتمال قطعی رشد نیست.');
  lines.push('ℹ️ این گزارش سیگنال ورود قطعی محسوب نمی‌شود.');

  return lines.join('\n');
}

// ========================
// MAIN SCANNER
// ========================

async function main() {
  const startedAt = Date.now();

  console.log('\n🚀 GATE.IO EARLY BULLISH TREND SCANNER');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎯 Target: Beginning of bullish trend');
  console.log('⏱ Timeframes: 15m / 1h / 4h\n');

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers(),
  ]);

  if (!Array.isArray(contracts) || !Array.isArray(tickers)) {
    throw new Error('داده قراردادها یا تیکرهای Gate.io معتبر نیست.');
  }

  const tickerMap = new Map(
    tickers.map((ticker) => [ticker.contract, ticker])
  );

  const activeContracts = contracts.filter((contract) => {
    return (
      contract &&
      contract.name &&
      contract.in_delisting !== true &&
      tickerMap.has(contract.name)
    );
  });

  const liquidMarkets = activeContracts
    .map((contract) => {
      const ticker = tickerMap.get(contract.name);

      return {
        symbol: contract.name,
        ticker,
        quoteVolume: number(ticker.volume_24h_quote),
        lastPrice: number(ticker.last),
      };
    })
    .filter((market) =>
      market.lastPrice > 0 &&
      market.quoteVolume >= CONFIG.MIN_QUOTE_VOLUME_24H
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  console.log(`📊 Active contracts: ${activeContracts.length}`);
  console.log(`💧 Liquid contracts: ${liquidMarkets.length}`);
  console.log('🔍 Scanning all liquid contracts...\n');

  let success = 0;
  let errors = 0;

  const analyzed = await mapLimit(
    liquidMarkets,
    CONFIG.CONCURRENCY,
    async (market) => {
      const [candles15m, candles1h, candles4h] =
        await Promise.all([
          getCandles(market.symbol, '15m', CONFIG.TIMEFRAMES['15m'].limit),
          getCandles(market.symbol, '1h', CONFIG.TIMEFRAMES['1h'].limit),
          getCandles(market.symbol, '4h', CONFIG.TIMEFRAMES['4h'].limit),
        ]);

      if (
        candles15m.length < 30 ||
        candles1h.length < 30 ||
        candles4h.length < 30
      ) {
        throw new Error('کندل کافی دریافت نشد.');
      }

      success++;

      return analyzeCoin({
        symbol: market.symbol,
        candles: {
          '15m': candles15m,
          '1h': candles1h,
          '4h': candles4h,
        },
      });
    }
  );

  const candidates = [];

  for (const result of analyzed) {
    if (result?.error) {
      errors++;
      continue;
    }

    if (result) candidates.push(result);
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.volume['1h'] - a.volume['1h'];
  });

  const duration = Date.now() - startedAt;

  const stats = {
    active: activeContracts.length,
    liquid: liquidMarkets.length,
    success,
    errors,
  };

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏆 TOP EARLY BULLISH CANDIDATES');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  candidates.slice(0, CONFIG.TOP_COUNT).forEach((coin, index) => {
    console.log(
      `${index + 1}. ${coin.symbol} | ` +
      `Score: ${coin.score} | ` +
      `${coin.stage} | ` +
      `1H Volume: ${coin.volume['1h'].toFixed(2)}x`
    );
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Successful analyses: ${success}`);
  console.log(`Errors: ${errors}`);
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const report = buildReport(candidates, stats, duration);
  await sendReports(report);

  console.log('✅ Telegram report sent successfully.');
}

main().catch((error) => {
  console.error('\n❌ SCANNER FAILED:', error);
  process.exitCode = 1;
});
