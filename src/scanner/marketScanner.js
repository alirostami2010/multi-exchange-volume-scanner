
/**
 * GATE.IO — 4H ACCUMULATION CYCLE SCANNER
 * ----------------------------------------
 * Mission:
 * Find ALL active USDT perpetual contracts showing
 * early accumulation characteristics.
 *
 * Node.js 20+
 * No external packages
 *
 * Required environment variables:
 * TELEGRAM_BOT_TOKEN
 * TELEGRAM_CHAT_ID
 */

const CONFIG = {
  BASE_URL: "https://api.gateio.ws/api/v4",
  INTERVAL: "4h",
  CANDLE_LIMIT: 180,

  MIN_SCORE: 60,
  MIN_BASE_BARS: 12,

  CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  RETRIES: 3,

  TELEGRAM_MAX_LENGTH: 3800,

  // No TOP N limit. All qualified contracts are reported.
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function average(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function percent(a, b) {
  return b ? ((a / b) - 1) * 100 : 0;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }

      return await response.json();

    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.RETRIES) {
        await sleep(700 * attempt);
      }
    }
  }

  throw lastError;
}

// --------------------------------------------------
// 1. GET ALL ACTIVE USDT PERPETUAL CONTRACTS
// --------------------------------------------------

async function getContracts() {
  const url = `${CONFIG.BASE_URL}/futures/usdt/contracts`;
  const data = await fetchJson(url);

  return data.filter(contract =>
    contract.status === "trading" &&
    contract.in_delisting !== true &&
    contract.type === "direct" &&
    contract.name?.endsWith("_USDT")
  );
}

// --------------------------------------------------
// 2. GET 4H CANDLES
// --------------------------------------------------

async function getCandles(contract) {
  const params = new URLSearchParams({
    contract,
    interval: CONFIG.INTERVAL,
    limit: String(CONFIG.CANDLE_LIMIT)
  });

  const url =
    `${CONFIG.BASE_URL}/futures/usdt/candlesticks?${params}`;

  const raw = await fetchJson(url);

  if (!Array.isArray(raw)) {
    throw new Error(`Invalid candles: ${contract}`);
  }

  const candles = raw.map(c => ({
    time: number(c.t),
    open: number(c.o),
    high: number(c.h),
    low: number(c.l),
    close: number(c.c),
    volume: number(c.sum)
  }))
  .filter(c =>
    c.time > 0 &&
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0 &&
    c.high >= c.low
  )
  .sort((a, b) => a.time - b.time);

  // Never use the currently forming 4H candle.
  const now = Math.floor(Date.now() / 1000);
  const fourHours = 4 * 60 * 60;

  return candles.filter(c => c.time + fourHours <= now);
}

// --------------------------------------------------
// 3. CALCULATE TRUE RANGE
// --------------------------------------------------

function trueRanges(candles) {
  const result = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const previousClose = candles[i - 1].close;

    result.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - previousClose),
      Math.abs(c.low - previousClose)
    ));
  }

  return result;
}

// --------------------------------------------------
// 4. ACCUMULATION DETECTOR
// --------------------------------------------------

function analyzeAccumulation(candles) {
  if (candles.length < 70) {
    return null;
  }

  const last = candles[candles.length - 1];

  // Previous decline: bars before the current base.
  const declineWindow = candles.slice(-48, -12);

  // Current consolidation/base.
  const base = candles.slice(-12);

  const previousBase = candles.slice(-24, -12);
  const recent = candles.slice(-6);
  const earlierVolume = candles.slice(-24, -6);

  const peak = Math.max(...declineWindow.map(c => c.high));
  const baseHigh = Math.max(...base.map(c => c.high));
  const baseLow = Math.min(...base.map(c => c.low));

  if (!peak || !baseLow || !last.close) return null;

  const priorDecline = ((peak - baseLow) / peak) * 100;
  const baseWidth = ((baseHigh - baseLow) / baseLow) * 100;

  const recentVolume = average(
    recent.map(c => c.volume)
  );

  const previousVolume = average(
    earlierVolume.map(c => c.volume)
  );

  const volumeRatio = previousVolume > 0
    ? recentVolume / previousVolume
    : 1;

  const ranges = trueRanges(candles);

  const recentATR = average(ranges.slice(-6));
  const previousATR = average(ranges.slice(-24, -6));

  const atrRatio = previousATR > 0
    ? recentATR / previousATR
    : 1;

  const previousLow = Math.min(
    ...previousBase.map(c => c.low)
  );

  const recentLow = Math.min(
    ...recent.map(c => c.low)
  );

  const lowStability = previousLow > 0
    ? recentLow / previousLow
    : 0;

  const positiveCandles = recent.filter(
    c => c.close > c.open
  ).length;

  const upperHalfCandles = recent.filter(c => {
    const range = c.high - c.low;
    if (range <= 0) return false;

    return (c.close - c.low) / range >= 0.60;
  }).length;

  // ------------------------------------------------
  // SCORE
  // ------------------------------------------------

  let score = 0;
  const signals = [];

  // A. Previous meaningful decline: 20 points.
  if (priorDecline >= 8) {
    score += 20;
    signals.push("افت قبلی قابل توجه");
  } else if (priorDecline >= 5) {
    score += 10;
    signals.push("افت قبلی متوسط");
  }

  // B. Price consolidation: 20 points.
  if (baseWidth <= 12) {
    score += 20;
    signals.push("فشردگی قوی قیمت");
  } else if (baseWidth <= 18) {
    score += 15;
    signals.push("فشردگی قیمت");
  } else if (baseWidth <= 22) {
    score += 8;
    signals.push("تثبیت نسبی");
  }

  // C. Volume contraction: 15 points.
  if (volumeRatio <= 0.65) {
    score += 15;
    signals.push("کاهش محسوس حجم");
  } else if (volumeRatio <= 0.85) {
    score += 10;
    signals.push("کاهش حجم");
  } else if (volumeRatio <= 1.0) {
    score += 5;
  }

  // D. Volatility contraction: 15 points.
  if (atrRatio <= 0.65) {
    score += 15;
    signals.push("کاهش شدید نوسان");
  } else if (atrRatio <= 0.85) {
    score += 10;
    signals.push("کاهش نوسان");
  } else if (atrRatio <= 1.0) {
    score += 5;
  }

  // E. Stabilizing lows: 15 points.
  if (lowStability >= 0.995) {
    score += 15;
    signals.push("تثبیت کف‌ها");
  } else if (lowStability >= 0.985) {
    score += 8;
    signals.push("کاهش فشار کف‌سازی");
  }

  // F. Early buying behavior: 15 points.
  if (positiveCandles >= 4) {
    score += 8;
    signals.push("غلبه کندل‌های مثبت");
  } else if (positiveCandles >= 3) {
    score += 5;
  }

  if (upperHalfCandles >= 4) {
    score += 7;
    signals.push("بسته‌شدن قیمت نزدیک سقف کندل");
  } else if (upperHalfCandles >= 3) {
    score += 4;
  }

  // ------------------------------------------------
  // QUALIFICATION RULES
  // ------------------------------------------------

  // A candidate must have a prior decline and
  // a genuine consolidation area.
  const hasPriorDecline = priorDecline >= 5;
  const hasBase = baseWidth <= 22;

  if (!hasPriorDecline || !hasBase) {
    return null;
  }

  if (score < CONFIG.MIN_SCORE) {
    return null;
  }

  return {
    score,
    price: last.close,
    priorDecline,
    baseWidth,
    volumeRatio,
    atrRatio,
    lowStability,
    signals,
    lastCandleTime: last.time
  };
}

// --------------------------------------------------
// 5. ANALYZE ONE CONTRACT
// --------------------------------------------------

async function analyzeContract(contract) {
  try {
    const candles = await getCandles(contract.name);

    const result = analyzeAccumulation(candles);

    if (!result) {
      return { qualified: false };
    }

    return {
      qualified: true,
      symbol: contract.name,
      ...result
    };

  } catch (error) {
    return {
      qualified: false,
      error: contract.name,
      message: error.message
    };
  }
}

// --------------------------------------------------
// 6. CONCURRENT WORKER
// --------------------------------------------------

async function runWorkers(items, worker, concurrency) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (true) {
      const current = index++;

      if (current >= items.length) return;

      results[current] = await worker(items[current]);

      // Small delay to avoid aggressive API requests.
      await sleep(100);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run()
  );

  await Promise.all(workers);

  return results;
}

// --------------------------------------------------
// 7. TELEGRAM
// --------------------------------------------------

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Telegram credentials are missing.");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  }
}

async function sendLongReport(header, lines) {
  const chunks = [];
  let current = header;

  for (const line of lines) {
    if (
      current.length + line.length + 2 >
      CONFIG.TELEGRAM_MAX_LENGTH
    ) {
      chunks.push(current);
      current = "";
    }

    current += (current ? "\n\n" : "") + line;
  }

  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const partHeader =
      `📄 گزارش ${i + 1}/${chunks.length}\n\n`;

    await sendTelegram(partHeader + chunks[i]);
    await sleep(350);
  }
}

// --------------------------------------------------
// 8. FORMAT RESULT
// --------------------------------------------------

function formatCandidate(item, index) {
  const signals = item.signals
    .map(s => `• ${escapeHtml(s)}`)
    .join("\n");

  return (
    `🟢 <b>${index}. ${escapeHtml(item.symbol)}</b>\n` +
    `امتیاز انباشت: <b>${item.score}/100</b>\n` +
    `قیمت آخرین کندل: ${item.price}\n` +
    `افت قبل از تثبیت: ${item.priorDecline.toFixed(2)}%\n` +
    `عرض محدوده تثبیت: ${item.baseWidth.toFixed(2)}%\n` +
    `نسبت حجم اخیر: ${item.volumeRatio.toFixed(2)}\n` +
    `نسبت نوسان اخیر: ${item.atrRatio.toFixed(2)}\n` +
    `نشانه‌ها:\n${signals}`
  );
}

// --------------------------------------------------
// 9. MAIN
// --------------------------------------------------

async function main() {
  const started = Date.now();

  console.log("Starting 4H Accumulation Scanner...");

  const contracts = await getContracts();

  console.log(`Active contracts: ${contracts.length}`);

  const results = await runWorkers(
    contracts,
    analyzeContract,
    CONFIG.CONCURRENCY
  );

  const candidates = results
    .filter(r => r?.qualified)
    .sort((a, b) => b.score - a.score);

  const errors = results.filter(r => r?.error);

  const header =
    `🛰 <b>GATE.IO | ACCUMULATION RADAR</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `⏱ تایم‌فریم: 4H\n` +
    `📊 کل قراردادهای فعال: ${contracts.length}\n` +
    `✅ بررسی موفق: ${results.length - errors.length}\n` +
    `⚠️ خطا: ${errors.length}\n` +
    `🎯 کاندیدهای انباشت: ${candidates.length}\n` +
    `━━━━━━━━━━━━━━━━━━`;

  if (!candidates.length) {
    await sendTelegram(
      header +
      `\n\nدر این اسکن هیچ ارزی شرایط حداقل امتیاز را نداشت.`
    );
  } else {
    const lines = candidates.map(formatCandidate);

    await sendLongReport(header, lines);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log("Scan completed.");
  console.log(`Candidates: ${candidates.length}`);
  console.log(`Errors: ${errors.length}`);
  console.log(`Elapsed: ${elapsed}s`);

  if (errors.length) {
    console.log("Failed contracts:", errors.map(e => e.error));
  }
}

main().catch(async error => {
  console.error("FATAL:", error);

  try {
    await sendTelegram(
      `🔴 <b>ACCUMULATION RADAR ERROR</b>\n\n` +
      escapeHtml(error.message)
    );
  } catch (telegramError) {
    console.error(telegramError);
  }

  process.exitCode = 1;
});
