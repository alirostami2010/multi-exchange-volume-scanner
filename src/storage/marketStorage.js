
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');
const DAY_MS = 86400000;
const MAX_COMPARISON_AGE_MS = 10 * 60 * 1000;

function numeric(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function emptyState() {
  return {
    history: [],
    summaries: {},
    rankMemory: {},
    tradeStates: {},
    events: {},
    scanMeta: null,
  };
}

async function readState() {
  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));

    if (!data  typeof data !== 'object'  Array.isArray(data)) {
      throw new Error('Invalid market-state.json');
    }

    const state = { ...emptyState(), ...data };
    if (!Array.isArray(state.history)) state.history = [];

    for (const key of [
      'summaries', 'rankMemory', 'tradeStates', 'events',
    ]) {
      if (
        !state[key] ||
        typeof state[key] !== 'object' ||
        Array.isArray(state[key])
      ) state[key] = {};
    }

    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function keyOf(coin) {
  return coin.symbol + ':' + coin.side;
}

function updateSummary(previous, coin, now) {
  const price = numeric(coin.lastCheckedPrice ?? coin.price);
  if (!(price > 0)) return previous;

const summary = previous || {
    symbol: coin.symbol,
    side: coin.side,
    firstDiscoveredAt: now,
    firstDiscoveryPrice: price,
    highestPrice: price,
    lowestPrice: price,
    bestRank: null,
    bestScore: 0,
    observations: 0,
  };

  summary.highestPrice = Math.max(
    numeric(summary.highestPrice, price), price
  );

  summary.lowestPrice = Math.min(
    numeric(summary.lowestPrice, price), price
  );

  const first = numeric(summary.firstDiscoveryPrice, price);

  summary.maxFavorableObservedPct = coin.side === 'SHORT'
    ? (first - summary.lowestPrice) / first * 100
    : (summary.highestPrice - first) / first * 100;

  // These are scanner observations, NOT trade performance.
  summary.bestRank = summary.bestRank == null
    ? coin.rank
    : Math.min(summary.bestRank, coin.rank);

  summary.bestScore = Math.max(
    numeric(summary.bestScore), coin.score
  );

  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastScore = coin.score;
  summary.observations = numeric(summary.observations) + 1;

  return summary;
}

export async function saveMarketSnapshot(candidates = []) {
  const state = await readState();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const unique = new Map();

  for (const coin of candidates) {
    if (
      !coin ||
      typeof coin.symbol !== 'string' ||
      !['LONG', 'SHORT'].includes(coin.side)
    ) continue;

    const normalized = {
      ...coin,
      score: Math.max(0, Math.min(100, numeric(coin.score))),
    };

    const key = keyOf(normalized);
    const previous = unique.get(key);

    if (!previous || normalized.score > previous.score) {
      unique.set(key, normalized);
    }
  }

  const rankedCandidates = [...unique.values()]
    .sort((a, b) =>
      b.score - a.score ||
      numeric(b.riskRewardToTp1) - numeric(a.riskRewardToTp1) ||
      numeric(b.quoteVolume24h) - numeric(a.quoteVolume24h) ||
      a.symbol.localeCompare(b.symbol)
    )
    .map((coin, i) => ({ ...coin, rank: i + 1 }));

  const oldTime = Date.parse(state.scanMeta?.timestamp);
  const age = nowMs - oldTime;

  const previousRanks =
    Number.isFinite(oldTime) &&
    age >= 0 &&
    age <= MAX_COMPARISON_AGE_MS
      ? state.scanMeta?.ranks || {}
      : {};

  const rankChanges = {};
  const ranks = {};

  for (const coin of rankedCandidates) {
    const key = keyOf(coin);
    const previousRank = numeric(previousRanks[key], null);
    const change = previousRank == null ? null : previousRank - coin.rank;

    rankChanges[key] = {
      previousRank,
      currentRank: coin.rank,
      change,
      status: change == null
        ? 'NEW'
        : change > 0 ? 'UP' : change < 0 ? 'DOWN' : 'SAME',
    };

    ranks[key] = coin.rank;
    state.summaries[key] = updateSummary(state.summaries[key], coin, now);

    state.rankMemory[key] = {
      score: coin.score,
      rank: coin.rank,
      updatedAt: now,
    };

    state.history.push({
      ...coin,
      timestamp: now,
      recordType: 'SCANNER_CANDIDATE',
    });
  }

  state.history = state.history.filter(item =>
    Date.parse(item.timestamp) >= nowMs - 15 * DAY_MS
  );

  for (const [key, summary] of Object.entries(state.summaries)) {
    if (!(Date.parse(summary?.lastSeenAt) >= nowMs - 30 * DAY_MS)) {
      delete state.summaries[key];
    }
  }

  for (const [key, memory] of Object.entries(state.rankMemory)) {
    if (!(Date.parse(memory?.updatedAt) >= nowMs - 15 * DAY_MS)) {
      delete state.rankMemory[key];
    }
  }

  state.scanMeta = {
    timestamp: now,
    candidateCount: rankedCandidates.length,
    ranks,
  };

  state.updatedAt = now;
  state.schemaVersion = 2;

  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporary = DATA_FILE + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, DATA_FILE);

return {
    rankedCandidates,
    snapshotsSaved: rankedCandidates.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    rankMemoryCount: Object.keys(state.rankMemory).length,
    rankChanges,
  };
}
