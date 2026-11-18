
/**
 * GATE.IO USDT PERPETUAL — EARLY LONG ACCUMULATION RADAR V5.1
 * -----------------------------------------------------------
 * - Scan ALL active USDT perpetual contracts
 * - Detect active accumulation / demand building
 * - Rank candidates by multi-factor scoring
 * - Select max 20 unique coins
 * - Send compact Telegram reports
 * - Handle Gate API and Telegram rate limits
 *
 * Node.js 20+
 */

const CONFIG = {
  API_BASE: "https://api.gateio.ws/api/v4",
  SETTLE: "usdt",

  INTERVAL: "4h",
  CANDLE_LIMIT: 180,
  BASE_WINDOWS: [18, 24, 30, 36],
  DECLINE_LOOKBACK: 72,

  MAX_TELEGRAM_COINS: 20,
  MAX_PER_MESSAGE: 10,

  MIN_24H_TURNOVER: 200000,
  MIN_BASE_TURNOVER: 10000,

  MIN_DECLINE_PCT: 8,
  MAX_DECLINE_PCT: 70,

  MIN_ZONE_WIDTH_PCT: 1,
  MAX_ZONE_WIDTH_PCT: 20,

  MIN_SCORE: 52,
  MAX_BREAKOUT_EXTENSION_PCT: 4,
  MAX_DISTANCE_TO_HIGH_PCT: 12,

  CONCURRENCY: 4,
  REQUEST_TIMEOUT_MS: 20000,
  REQUEST_RETRIES: 4,

  TELEGRAM_RETRIES: 5,
  TELEGRAM_MESSAGE_DELAY_MS: 1500,

  LOG_EVERY: 50,
};

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return value.toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
  if (value >= 1) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return value.toPrecision(5);
}

function formatMoney(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(1) + "K";
  return value.toFixed(0);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* =========================================================
   HTTP
========================================================= */

async function fetchJson(url, label = "API") {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.REQUEST_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = num(
          response.headers.get("Retry-After"),
          attempt * 3
        );

        const wait = Math.max(retryAfter * 1000, attempt * 2000);

        console.warn(`[GATE 429] ${label}: waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `${label}: HTTP ${response.status} ${body.slice(0, 200)}`
        );
      }

      return await response.json();

    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt < CONFIG.REQUEST_RETRIES) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 12000);
        console.warn(`[RETRY] ${label}: ${error.message}`);
        await sleep(wait);
      }
    }
  }

  throw lastError || new Error(`${label}: request failed`);
}

/* =========================================================
   MARKET DATA
========================================================= */

async function getContracts() {
  const url =
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/contracts`;

  const data = await fetchJson(url, "contracts");

  if (!Array.isArray(data)) {
    throw new Error("Invalid contracts response");
  }

  return data.filter(contract => {
    const name = String(contract.name || "");

    if (!name.endsWith("_USDT")) return false;
    if (contract.in_delisting === true) return false;

    const status = String(contract.status || "").toLowerCase();

    return !status || status === "trading";
  });
}

async function getTickers() {
  const url =
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/tickers`;

  const data = await fetchJson(url, "tickers");

  if (!Array.isArray(data)) {
    throw new Error("Invalid tickers response");
  }

  const result = new Map();

  for (const ticker of data) {
    if (!ticker.contract) continue;

    result.set(ticker.contract, {
      last: num(ticker.last),

      turnover24h: num(
        ticker.volume_24h_quote,
        num(ticker.volume_24h_usd, 0)
      ),

      change24h: num(ticker.change_percentage),
      fundingRate: num(ticker.funding_rate),
      high24h: num(ticker.high_24h),
      low24h: num(ticker.low_24h),
    });
  }

  return result;
}

async function getCandles(contract) {
  const params = new URLSearchParams({
    contract,
    interval: CONFIG.INTERVAL,
    limit: String(CONFIG.CANDLE_LIMIT),
  });

  const url =
    `${CONFIG.API_BASE}/futures/${CONFIG.SETTLE}/candlesticks?${params}`;

  const raw = await fetchJson(url, `candles ${contract}`);

  if (!Array.isArray(raw)) return [];

  const now = Math.floor(Date.now() / 1000);
  const intervalSeconds = 4 * 60 * 60;

  return raw
    .map(c => ({
      time: num(c.t),
      open: num(c.o),
      high: num(c.h),
      low: num(c.l),
      close: num(c.c),
      volume: num(c.v),
      turnover: num(c.sum),
    }))
    .filter(c =>
      c.time > 0 &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0 &&
      c.high >= c.low &&
      c.time + intervalSeconds <= now
    )
    .sort((a, b) => a.time - b.time);
}

/* =========================================================
   MARKET STRUCTURE
========================================================= */

function findPreviousDecline(candles, baseStart) {
  const from = Math.max(
    0,
    baseStart - CONFIG.DECLINE_LOOKBACK
  );

  const history = candles.slice(from, baseStart);

  if (history.length < 12) return null;

  let peakIndex = 0;
  let peakPrice = history[0].high;

  for (let i = 1; i < history.length; i++) {
    if (history[i].high > peakPrice) {
      peakPrice = history[i].high;
      peakIndex = i;
    }
  }

  const afterPeak = history.slice(peakIndex + 1);

  if (afterPeak.length < 4) return null;

  const troughPrice = Math.min(
    ...afterPeak.map(c => c.low)
  );

  if (!Number.isFinite(troughPrice) || troughPrice <= 0) {
    return null;
  }

  return {
    peakPrice,
    troughPrice,
    declinePct:
      ((peakPrice - troughPrice) / peakPrice) * 100,
  };
}

function countHigherLows(candles) {
  if (candles.length < 8) return 0;

  const chunks = [];
  const chunkSize = Math.max(
    3,
    Math.floor(candles.length / 4)
  );

  for (let i = 0; i < candles.length; i += chunkSize) {
    const part = candles.slice(i, i + chunkSize);
    if (!part.length) continue;

    chunks.push(Math.min(...part.map(c => c.low)));
  }

  let count = 0;

  for (let i = 1; i < chunks.length; i++) {
    if (chunks[i] > chunks[i - 1]) count++;
  }

  return count;
}

function calculateBaseMetrics(base) {
  const zoneHigh = Math.max(...base.map(c => c.high));
  const zoneLow = Math.min(...base.map(c => c.low));

  const lastClose = base[base.length - 1].close;

  const zoneWidthPct =
    ((zoneHigh - zoneLow) / zoneLow) * 100;

  const closePosition =
    (lastClose - zoneLow) / (zoneHigh - zoneLow);

  const middle = Math.floor(base.length / 2);

  const firstHalf = base.slice(0, middle);
  const secondHalf = base.slice(middle);

  const firstVolume = average(
    firstHalf.map(c => c.turnover)
  );

  const secondVolume = average(
    secondHalf.map(c => c.turnover)
  );

  const volumeTrend =
    firstVolume > 0 ? secondVolume / firstVolume : 1;

  const recentTurnover = average(
    base.slice(-5).map(c => c.turnover)
  );

  const previousTurnover = average(
    base.slice(-15, -5).map(c => c.turnover)
  );

  const recentVolumeExpansion =
    previousTurnover > 0
      ? recentTurnover / previousTurnover
      : 1;

  const greenTurnover = base
    .filter(c => c.close > c.open)
    .reduce((sum, c) => sum + c.turnover, 0);

  const redTurnover = base
    .filter(c => c.close < c.open)
    .reduce((sum, c) => sum + c.turnover, 0);

  const buyPressure =
    greenTurnover + redTurnover > 0
      ? greenTurnover / (greenTurnover + redTurnover)
      : 0.5;

  const higherLows = countHigherLows(base);

  const recentLow = Math.min(
    ...base.slice(-6).map(c => c.low)
  );

  const previousLow = Math.min(
    ...base.slice(-12, -6).map(c => c.low)
  );

  const recentFloorHeld =
    previousLow > 0 &&
    recentLow >= previousLow * 0.985;

  return {
    zoneHigh,
    zoneLow,
    lastClose,
    zoneWidthPct,
    closePosition,
    volumeTrend,
    recentVolumeExpansion,
    buyPressure,
    higherLows,
    recentFloorHeld,
    averageTurnover: average(
      base.map(c => c.turnover)
    ),
  };
}

/* =========================================================
   SCORING
========================================================= */

function scoreCandidate(metrics, decline, base, ticker) {
  let score = 0;
  const reasons = [];

  if (decline.declinePct >= 8 && decline.declinePct <= 70) {
    score += clamp(decline.declinePct * 0.42, 4, 18);
    reasons.push("اصلاح قبلی");
  }

  if (metrics.recentFloorHeld) {
    score += 10;
    reasons.push("حفظ کف");
  }

  score += Math.min(metrics.higherLows * 4, 12);

  if (metrics.higherLows >= 2) {
    reasons.push("کف‌های بالاتر");
  }

  if (metrics.zoneWidthPct <= 6) {
    score += 14;
    reasons.push("فشردگی قوی");
  } else if (metrics.zoneWidthPct <= 10) {
    score += 11;
    reasons.push("فشردگی");
  } else if (metrics.zoneWidthPct <= 15) {
    score += 7;
  } else {
    score += 2;
  }

  if (metrics.recentVolumeExpansion >= 1.8) {
    score += 12;
    reasons.push("افزایش حجم اخیر");
  } else if (metrics.recentVolumeExpansion >= 1.35) {
    score += 8;
    reasons.push("رشد حجم");
  } else if (metrics.recentVolumeExpansion >= 1.1) {
    score += 4;
  }

  if (metrics.volumeTrend >= 1.5) {
    score += 8;
    reasons.push("تقویت گردش مالی");
  } else if (metrics.volumeTrend >= 1.15) {
    score += 5;
  }

  if (metrics.buyPressure >= 0.62) {
    score += 10;
    reasons.push("غلبه حجم صعودی");
  } else if (metrics.buyPressure >= 0.55) {
    score += 6;
  } else if (metrics.buyPressure < 0.42) {
    score -= 8;
  }

  if (
    metrics.closePosition >= 0.65 &&
    metrics.closePosition <= 0.9
  ) {
    score += 10;
    reasons.push("نزدیک سقف محدوده");
  } else if (metrics.closePosition >= 0.5) {
    score += 6;
  } else if (metrics.closePosition < 0.3) {
    score -= 8;
  }

  if (ticker.turnover24h >= 10_000_000) {
    score += 8;
  } else if (ticker.turnover24h >= 2_000_000) {
    score += 6;
  } else if (ticker.turnover24h >= 500_000) {
    score += 3;
  }

  const ageHours =
    (Date.now() / 1000 -
      base[base.length - 1].time) / 3600;

  if (ageHours <= 8) {
    score += 6;
    reasons.push("محدوده تازه");
  } else if (ageHours <= 24) {
    score += 4;
  } else if (ageHours <= 48) {
    score += 2;
  }

  const distanceToHighPct =
    ((metrics.zoneHigh - ticker.last) / ticker.last) * 100;

  if (distanceToHighPct >= 1 && distanceToHighPct <= 5) {
    score += 8;
    reasons.push("نزدیک شکست احتمالی");
  } else if (distanceToHighPct > 5 && distanceToHighPct <= 9) {
    score += 5;
  } else if (
    distanceToHighPct < -CONFIG.MAX_BREAKOUT_EXTENSION_PCT
  ) {
    score -= 25;
  } else if (distanceToHighPct < 0) {
    score -= 8;
  }

  const lastThree = base.slice(-3);

  if (
    lastThree.length === 3 &&
    lastThree.every(c => c.close < c.open)
  ) {
    score -= 8;
  }

  if (metrics.averageTurnover < CONFIG.MIN_BASE_TURNOVER) {
    score -= 10;
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    reasons,
    ageHours,
    distanceToHighPct,
  };
}

/* =========================================================
   CONTRACT ANALYSIS
========================================================= */

function analyzeContract(contract, candles, ticker) {
  if (!Array.isArray(candles) || candles.length < 100) {
    return null;
  }

  if (!ticker || ticker.last <= 0) return null;

  if (ticker.turnover24h < CONFIG.MIN_24H_TURNOVER) {
    return null;
  }

  const candidates = [];

  for (const windowSize of CONFIG.BASE_WINDOWS) {
    const baseStart = candles.length - windowSize;
    const base = candles.slice(baseStart);

    if (base.length !== windowSize) continue;

    const metrics = calculateBaseMetrics(base);

    if (
      metrics.zoneWidthPct < CONFIG.MIN_ZONE_WIDTH_PCT ||
      metrics.zoneWidthPct > CONFIG.MAX_ZONE_WIDTH_PCT
    ) {
      continue;
    }

    const decline = findPreviousDecline(
      candles,
      baseStart
    );

    if (!decline) continue;

    if (
      decline.declinePct < CONFIG.MIN_DECLINE_PCT ||
      decline.declinePct > CONFIG.MAX_DECLINE_PCT
    ) {
      continue;
    }

    const price = ticker.last;

    const breakoutExtensionPct =
      ((price - metrics.zoneHigh) / metrics.zoneHigh) * 100;

    const breakdownPct =
      ((metrics.zoneLow - price) / metrics.zoneLow) * 100;

    if (breakdownPct > 2.5) continue;

    if (
      breakoutExtensionPct >
      CONFIG.MAX_BREAKOUT_EXTENSION_PCT
    ) {
      continue;
    }

    const distanceToHighPct =
      ((metrics.zoneHigh - price) / price) * 100;

    if (
      distanceToHighPct >
      CONFIG.MAX_DISTANCE_TO_HIGH_PCT
    ) {
      continue;
    }

    if (metrics.closePosition < 0.25) continue;

    const scored = scoreCandidate(
      metrics,
      decline,
      base,
      ticker
    );

    if (scored.score < CONFIG.MIN_SCORE) continue;

    candidates.push({
      contract,
      price,
      score: scored.score,

      status:
        breakoutExtensionPct >= 0
          ? "NEAR_BREAKOUT"
          : "ACTIVE_ACCUMULATION",

      zoneLow: metrics.zoneLow,
      zoneHigh: metrics.zoneHigh,
      zoneWidthPct: metrics.zoneWidthPct,

      declinePct: decline.declinePct,
      distanceToHighPct,

      turnover24h: ticker.turnover24h,
      baseTurnover: metrics.averageTurnover,

      volumeExpansion: metrics.recentVolumeExpansion,
      volumeTrend: metrics.volumeTrend,
      buyPressure: metrics.buyPressure,

      higherLows: metrics.higherLows,
      closePosition: metrics.closePosition,

      ageHours: scored.ageHours,
      fundingRate: ticker.fundingRate,
      change24h: ticker.change24h,

      reasons: scored.reasons,
      windowSize,
    });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.windowSize - b.windowSize;
  });

  return candidates[0];
}

/* =========================================================
   RANKING
========================================================= */

function rankCandidates(candidates) {
  const unique = new Map();

  for (const candidate of candidates) {
    const previous = unique.get(candidate.contract);

    if (!previous || candidate.score > previous.score) {
      unique.set(candidate.contract, candidate);
    }
  }

  return [...unique.values()]
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      if (a.distanceToHighPct !== b.distanceToHighPct) {
        return a.distanceToHighPct - b.distanceToHighPct;
      }

      return b.turnover24h - a.turnover24h;
    })
    .slice(0, CONFIG.MAX_TELEGRAM_COINS);
}

/* =========================================================
   TELEGRAM REPORT
========================================================= */

function buildCoinReport(candidate, index) {
  const symbol = candidate.contract.replace("_USDT", "");

  const statusText =
    candidate.status === "NEAR_BREAKOUT"
      ? "نزدیک شکست"
      : "انباشت فعال";

  const reasons = candidate.reasons
    .slice(0, 4)
    .join("، ");

  return [
    `<b>${index + 1}. ${escapeHtml(symbol)}</b> | امتیاز: <b>${candidate.score}/100</b>`,
    `وضعیت: ${statusText}`,
    `قیمت: <code>${formatNumber(candidate.price)}</code>`,
    `محدوده: <code>${formatNumber(candidate.zoneLow)}</code> تا <code>${formatNumber(candidate.zoneHigh)}</code>`,
    `فاصله تا سقف: ${candidate.distanceToHighPct.toFixed(2)}٪`,
    `افت قبل از محدوده: ${candidate.declinePct.toFixed(1)}٪`,
    `گردش مالی ۲۴ساعت: ${formatMoney(candidate.turnover24h)} USDT`,
    `تقویت حجم اخیر: ${candidate.volumeExpansion.toFixed(2)}x`,
    `نشانه‌ها: ${escapeHtml(reasons || "ترکیب معیارهای تکنیکال")}`,
  ].join("\n");
}

function buildTelegramMessages(
  candidates,
  scannedCount,
  failedCount
) {
  const now = new Date().toISOString()
    .replace("T", " ")
    .slice(0, 16);

  if (!candidates.length) {
    return [[
      "<b>GATE.IO — EARLY LONG RADAR V5.1</b>",
      "━━━━━━━━━━━━━━━━━━",
      "هیچ محدوده انباشت فعالی با حداقل امتیاز تعیین‌شده پیدا نشد.",
      "",
      `بازارهای بررسی‌شده: ${scannedCount}`,
      `خطاهای دریافت داده: ${failedCount}`,
      `زمان: ${now} UTC`,
    ].join("\n")];
  }

  const chunks = [];

  for (
    let i = 0;
    i < candidates.length;
    i += CONFIG.MAX_PER_MESSAGE
  ) {
    chunks.push(
      candidates.slice(i, i + CONFIG.MAX_PER_MESSAGE)
    );
  }

  return chunks.map((chunk, chunkIndex) => {
    const offset = chunkIndex * CONFIG.MAX_PER_MESSAGE;

    const header = [
      "<b>GATE.IO — EARLY LONG RADAR V5.1</b>",
      "━━━━━━━━━━━━━━━━━━",
      `برترین فرصت‌های احتمالی لانگ | بخش ${chunkIndex + 1}/${chunks.length}`,
      `کاندیدهای منتخب: ${candidates.length}`,
      `بازارهای اسکن‌شده: ${scannedCount}`,
      `خطاهای دریافت داده: ${failedCount}`,
      `زمان: ${now} UTC`,
      "━━━━━━━━━━━━━━━━━━",
      "",
    ].join("\n");

    const body = chunk
      .map((candidate, i) =>
        buildCoinReport(candidate, offset + i)
      )
      .join("\n\n━━━━━━━━━━━━━━━━━━\n\n");

    return (
      header +
      body +
      "\n\n<i>گزارش تحلیلی است و سیگنال قطعی ورود نیست.</i>"
    );
  });
}

/* =========================================================
   TELEGRAM DELIVERY
========================================================= */

async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID"
    );
  }

  const url =
    `https://api.telegram.org/bot${token}/sendMessage`;

  for (
    let attempt = 1;
    attempt <= CONFIG.TELEGRAM_RETRIES;
    attempt++
  ) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    const result = await response.json().catch(() => ({}));

    if (response.ok && result.ok) {
      return true;
    }

    const retryAfter = num(
      result?.parameters?.retry_after,
      0
    );

    if (response.status === 429 || retryAfter > 0) {
      const wait =
        retryAfter > 0
          ? retryAfter * 1000 + 1500
          : Math.min(5000 * attempt, 30000);

      console.warn(`[TELEGRAM 429] waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }

    if (
      response.status >= 500 &&
      attempt < CONFIG.TELEGRAM_RETRIES
    ) {
      await sleep(Math.min(3000 * attempt, 15000));
      continue;
    }

    throw new Error(
      `Telegram error: ${JSON.stringify(result)}`
    );
  }

  throw new Error(
    "Telegram failed after maximum retries"
  );
}

async function sendReports(messages) {
  for (let i = 0; i < messages.length; i++) {
    await sendTelegramMessage(messages[i]);

    console.log(
      `[TELEGRAM] Sent ${i + 1}/${messages.length}`
    );

    if (i < messages.length - 1) {
      await sleep(CONFIG.TELEGRAM_MESSAGE_DELAY_MS);
    }
  }
}

/* =========================================================
   CONCURRENCY
========================================================= */

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        results[index] = await worker(
          items[index],
          index
        );
      } catch (error) {
        results[index] = {
          error: error.message || String(error),
        };
      }
    }
  }

  const workers = Array.from(
    {
      length: Math.min(concurrency, items.length),
    },
    () => runWorker()
  );

  await Promise.all(workers);

  return results;
}

/* =========================================================
   MAIN SCANNER
========================================================= */

async function scanOneContract(contract, ticker) {
  const candles = await getCandles(contract.name);

  return analyzeContract(
    contract.name,
    candles,
    ticker
  );
}

export async function runMarketScanner() {
  const startedAt = Date.now();

  console.log("");
  console.log("==============================================");
  console.log("GATE.IO EARLY LONG ACCUMULATION RADAR V5.1");
  console.log("==============================================");
  console.log(`Timeframe: ${CONFIG.INTERVAL}`);
  console.log(`Maximum Telegram coins: ${CONFIG.MAX_TELEGRAM_COINS}`);
  console.log("Loading contracts and tickers...");

  const [contracts, tickers] = await Promise.all([
    getContracts(),
    getTickers(),
  ]);

  const eligible = contracts.filter(contract => {
    const ticker = tickers.get(contract.name);

    return ticker && ticker.last > 0;
  });

  console.log(`Eligible markets: ${eligible.length}`);

  let completed = 0;
  let failed = 0;

  const results = await mapLimit(
    eligible,
    CONFIG.CONCURRENCY,
    async contract => {
      try {
        const ticker = tickers.get(contract.name);

        const candidate = await scanOneContract(
          contract,
          ticker
        );

        completed++;

        if (completed % CONFIG.LOG_EVERY === 0) {
          console.log(
            `[PROGRESS] ${completed}/${eligible.length} | Failed: ${failed}`
          );
        }

        return candidate;

      } catch (error) {
        completed++;
        failed++;

        console.warn(
          `[SCAN ERROR] ${contract.name}: ${error.message}`
        );

        if (completed % CONFIG.LOG_EVERY === 0) {
          console.log(
            `[PROGRESS] ${completed}/${eligible.length} | Failed: ${failed}`
          );
        }

        return null;
      }
    }
  );

  const candidates = results.filter(
    item => item && !item.error
  );

  const ranked = rankCandidates(candidates);

  const elapsed =
    ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log("");
  console.log("----------------------------------------------");
  console.log(`Scanned: ${completed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Qualified candidates: ${candidates.length}`);
  console.log(`Selected for Telegram: ${ranked.length}`);
  console.log(`Elapsed: ${elapsed}s`);
  console.log("----------------------------------------------");

  console.log("TOP CANDIDATES:");

  ranked.forEach((item, index) => {
    console.log(
      `${index + 1}. ${item.contract} | ` +
      `Score ${item.score} | ` +
      `Distance ${item.distanceToHighPct.toFixed(2)}% | ` +
      `24h ${formatMoney(item.turnover24h)}`
    );
  });

  const messages = buildTelegramMessages(
    ranked,
    completed,
    failed
  );

  await sendReports(messages);

  console.log("");
  console.log("Telegram reports sent successfully.");
  console.log(
    `Total runtime: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );

  return {
    scanned: completed,
    failed,
    qualified: candidates.length,
    selected: ranked.length,
    candidates: ranked,
  };
}

export default runMarketScanner;

/* =========================================================
   AUTOMATIC EXECUTION
   This ensures the scanner starts when index.js imports
   this module without explicitly calling the function.
========================================================= */

runMarketScanner().catch(error => {
  console.error("");
  console.error("==============================================");
  console.error("FATAL SCANNER ERROR");
  console.error("==============================================");
  console.error(error);
  process.exitCode = 1;
});
