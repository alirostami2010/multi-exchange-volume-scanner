
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');

const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

async function readState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);

    return {
      history: Array.isArray(data.history) ? data.history : [],
      summaries:
        data.summaries && typeof data.summaries === 'object'
          ? data.summaries
          : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { history: [], summaries: {} };
    }

    throw error;
  }
}

function updateSummary(previous, coin, rank, now) {
  const price = Number(coin.price);

  if (!Number.isFinite(price) || price <= 0) {
    return previous;
  }

  const summary = previous || {
    symbol: coin.symbol,
    firstDiscoveredAt: now,
    firstDiscoveryPrice: price,
    highestPrice: price,
    lowestPrice: price,
    maxGainPercent: 0,
    bestRank: rank,
    lastSeenAt: now,
    lastPrice: price,
    lastScore: coin.score,
    lastStage: coin.stage,
    observations: 0,
  };

  summary.highestPrice = Math.max(summary.highestPrice, price);
  summary.lowestPrice = Math.min(summary.lowestPrice, price);

  const gain = summary.firstDiscoveryPrice > 0
    ? ((summary.highestPrice - summary.firstDiscoveryPrice) /
        summary.firstDiscoveryPrice) * 100
    : 0;

  summary.maxGainPercent = Math.max(
    summary.maxGainPercent,
    gain
  );

  summary.bestRank = Math.min(summary.bestRank, rank);
  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastScore = coin.score;
  summary.lastStage = coin.stage;
  summary.observations += 1;

  return summary;
}

export async function saveMarketSnapshot(candidates) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const state = await readState();

  // آخرین اجرای ثبت‌شده قبل از اجرای فعلی
  let previousRunTimestamp = null;

  for (const item of state.history) {
    if (
      item.timestamp &&
      (!previousRunTimestamp ||
        item.timestamp > previousRunTimestamp)
    ) {
      previousRunTimestamp = item.timestamp;
    }
  }

  // استخراج رتبه‌های اجرای قبلی
  const previousRanks = new Map();

  if (previousRunTimestamp) {
    for (const item of state.history) {
      if (item.timestamp === previousRunTimestamp) {
        previousRanks.set(item.symbol, item.rank);
      }
    }
  }

  // مقایسه رتبه‌های فعلی با اجرای قبلی
  const rankChanges = {};

  candidates.forEach((coin, index) => {
    const currentRank = index + 1;
    const previousRank = previousRanks.get(coin.symbol);

    if (previousRank === undefined) {
      rankChanges[coin.symbol] = {
        status: 'NEW',
        previousRank: null,
        currentRank,
        change: null,
      };
      return;
    }

    const change = previousRank - currentRank;

    rankChanges[coin.symbol] = {
      status: change > 0
        ? 'UP'
        : change < 0
          ? 'DOWN'
          : 'SAME',
      previousRank,
      currentRank,
      change,
    };
  });

  // ساخت رکوردهای اجرای فعلی
  const currentSnapshots = candidates.map((coin, index) => {
    const rank = index + 1;

    state.summaries[coin.symbol] = updateSummary(
      state.summaries[coin.symbol],
      coin,
      rank,
      now
    );

    return {
      timestamp: now,
      symbol: coin.symbol,
      rank,
      score: coin.score,
      price: coin.price,
      stage: coin.stage,
      returns: coin.returns,
      volume: coin.volume,
      evidence: coin.evidence,
      warnings: coin.warnings,
    };
  });

  state.history.push(...currentSnapshots);

  // پاک‌سازی تاریخچه قدیمی‌تر از ۱۵ روز
  const historyCutoff =
    nowMs - HISTORY_RETENTION_DAYS * DAY_MS;

  state.history = state.history.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return Number.isFinite(timestamp) && timestamp >= historyCutoff;
  });

  // نگهداری خلاصه عملکرد تا ۳۰ روز پس از آخرین مشاهده
  const summaryCutoff =
    nowMs - SUMMARY_RETENTION_DAYS * DAY_MS;

  for (const [symbol, summary] of Object.entries(state.summaries)) {
    const lastSeen = Date.parse(summary.lastSeenAt);

    if (!Number.isFinite(lastSeen) || lastSeen < summaryCutoff) {
      delete state.summaries[symbol];
    }
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporaryFile = `${DATA_FILE}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(
      {
        updatedAt: now,
        history: state.history,
        summaries: state.summaries,
      },
      null,
      2
    ),
    'utf8'
  );

  await fs.rename(temporaryFile, DATA_FILE);

  return {
    snapshotsSaved: currentSnapshots.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    rankChanges,
  };
}
