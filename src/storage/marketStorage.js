import fs from 'node:fs/promises';
import path from 'node:path';

// File: src/storage/marketStorage.js
// Stores scanner observations, not realized trading performance.
// Paper signal performance is stored separately in signal-state.json.

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');

const DAY_MS = 86400000;
const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;
const RANK_MEMORY_RETENTION_DAYS = 15;
const MAX_COMPARISON_AGE_MS = 10 * 60 * 1000;

function numeric(value, fallback = 0) {
  if (value == null) return fallback;
  if (value === '') return fallback;

  const result = Number(value);

  return Number.isFinite(result)
    ? result
    : fallback;
}

function isRecord(value) {
  if (value == null) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;

  return true;
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
    const text = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(text);

    if (!isRecord(data)) {
      throw new Error(
        'Invalid market-state.json: expected an object'
      );
    }

    const state = {
      ...emptyState(),
      ...data,
    };

    if (!Array.isArray(state.history)) {
      state.history = [];
    }

    for (const key of [
      'summaries',
      'rankMemory',
      'tradeStates',
      'events',
    ]) {
      if (!isRecord(state[key])) {
        state[key] = {};
      }
    }

    if (!isRecord(state.scanMeta)) {
      state.scanMeta = null;
    }

    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptyState();
    }

    // Do not overwrite malformed existing data with an empty state.
    throw error;
  }
}

function keyOf(coin) {
  return coin.symbol + ':' + coin.side;
}

function observationPrice(coin) {
  const checked = numeric(coin.lastCheckedPrice, null);

  if (checked != null && checked > 0) {
    return checked;
  }

  return numeric(coin.price);
}

function updateSummary(previous, coin, now) {
  const price = observationPrice(coin);

  if (!(price > 0)) {
    return isRecord(previous) ? previous : null;
  }

  const summary = isRecord(previous)
    ? { ...previous }
    : {
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

  summary.symbol = coin.symbol;
  summary.side = coin.side;

  summary.highestPrice = Math.max(
    numeric(summary.highestPrice, price),
    price
  );

  summary.lowestPrice = Math.min(
    numeric(summary.lowestPrice, price),
    price
  );

  const storedFirst = numeric(
    summary.firstDiscoveryPrice,
    price
  );

  const first = storedFirst > 0
    ? storedFirst
    : price;

  summary.firstDiscoveryPrice = first;

  summary.maxFavorableObservedPct = coin.side === 'SHORT'
    ? (first - summary.lowestPrice) / first * 100
    : (summary.highestPrice - first) / first * 100;

  // This metric uses scanner observations only.
  // It is not a trade return or a complete price-history measurement.
  const previousBestRank = numeric(summary.bestRank, null);

  summary.bestRank =
    previousBestRank != null && previousBestRank > 0
      ? Math.min(previousBestRank, coin.rank)
      : coin.rank;

  summary.bestScore = Math.max(
    numeric(summary.bestScore),
    coin.score
  );

  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastScore = coin.score;
  summary.observations = numeric(summary.observations) + 1;

  return summary;
}

function compareCandidates(a, b) {
  const scoreDifference = b.score - a.score;

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const rrDifference =
    numeric(b.riskRewardToTp1) -
    numeric(a.riskRewardToTp1);

  if (rrDifference !== 0) {
    return rrDifference;
  }

  const volumeDifference =
    numeric(b.quoteVolume24h) -
    numeric(a.quoteVolume24h);

  if (volumeDifference !== 0) {
    return volumeDifference;
  }

  const symbolDifference =
    a.symbol.localeCompare(b.symbol);

  if (symbolDifference !== 0) {
    return symbolDifference;
  }

  return a.side.localeCompare(b.side);
}

function previousRanksFor(state, nowMs) {
  if (!isRecord(state.scanMeta)) return {};
  if (!isRecord(state.scanMeta.ranks)) return {};

  const previousTime = Date.parse(state.scanMeta.timestamp);

  if (!Number.isFinite(previousTime)) return {};

  const age = nowMs - previousTime;

  if (age < 0) return {};
  if (age > MAX_COMPARISON_AGE_MS) return {};

  return state.scanMeta.ranks;
}

export async function saveMarketSnapshot(candidates = []) {
  if (!Array.isArray(candidates)) {
    throw new TypeError(
      'saveMarketSnapshot expects an array'
    );
  }

  const state = await readState();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  const unique = new Map();

  for (const coin of candidates) {
    if (!isRecord(coin)) continue;
    if (typeof coin.symbol !== 'string') continue;
    if (coin.symbol.length === 0) continue;
    if (!['LONG', 'SHORT'].includes(coin.side)) continue;

    const score = Math.max(
      0,
      Math.min(100, numeric(coin.score))
    );

    const normalized = {
      ...coin,
      score,
      scoreRaw: score,
    };

    const key = keyOf(normalized);
    const previous = unique.get(key);

    if (!previous) {
      unique.set(key, normalized);
    } else if (normalized.score > previous.score) {
      unique.set(key, normalized);
    }
  }

  const rankedCandidates = [...unique.values()]
    .sort(compareCandidates)
    .map((coin, index) => ({
      ...coin,
      rank: index + 1,
    }));

  const previousRanks = previousRanksFor(state, nowMs);
  const rankChanges = {};
  const currentRanks = {};

  for (const coin of rankedCandidates) {
    const key = keyOf(coin);

    const storedRank = numeric(
      previousRanks[key],
      null
    );

    const previousRank =
      storedRank != null && storedRank > 0
        ? storedRank
        : null;

    const change = previousRank == null
      ? null
      : previousRank - coin.rank;

    let status = 'NEW';

    if (change != null) {
      if (change > 0) {
        status = 'UP';
      } else if (change < 0) {
        status = 'DOWN';
      } else {
        status = 'SAME';
      }
    }

    rankChanges[key] = {
      previousRank,
      currentRank: coin.rank,
      change,
      status,
    };

    currentRanks[key] = coin.rank;

    const summary = updateSummary(
      state.summaries[key],
      coin,
      now
    );

    if (summary != null) {
      state.summaries[key] = summary;
    }

    state.rankMemory[key] = {
      symbol: coin.symbol,
      side: coin.side,
      score: coin.score,
      rank: coin.rank,
      updatedAt: now,
    };

    // Keep the complete candidate, including direction and levels.
    // Being stored here does not mean it was sent to Telegram.
    state.history.push({
      ...coin,
      timestamp: now,
      recordType: 'SCANNER_CANDIDATE',
    });
  }

  const historyCutoff =
    nowMs - HISTORY_RETENTION_DAYS * DAY_MS;

  state.history = state.history.filter(item => {
    if (!isRecord(item)) return false;

    const timestamp = Date.parse(item.timestamp);

    return Number.isFinite(timestamp) &&
      timestamp >= historyCutoff;
  });

  const summaryCutoff =
    nowMs - SUMMARY_RETENTION_DAYS * DAY_MS;

  for (const [key, summary] of Object.entries(state.summaries)) {
    const timestamp = Date.parse(summary?.lastSeenAt);

    if (!Number.isFinite(timestamp)) {
      delete state.summaries[key];
    } else if (timestamp < summaryCutoff) {
      delete state.summaries[key];
    }
  }

  const memoryCutoff =
    nowMs - RANK_MEMORY_RETENTION_DAYS * DAY_MS;

  for (const [key, memory] of Object.entries(state.rankMemory)) {
    const timestamp = Date.parse(memory?.updatedAt);

    if (!Number.isFinite(timestamp)) {
      delete state.rankMemory[key];
    } else if (timestamp < memoryCutoff) {
      delete state.rankMemory[key];
    }
  }

  // Save even an empty valid scan, so ranks are compared only
  // against the immediately preceding saved scan.
  state.scanMeta = {
    timestamp: now,
    candidateCount: rankedCandidates.length,
    ranks: currentRanks,
  };

  state.updatedAt = now;
  state.schemaVersion = 2;

  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporaryFile = DATA_FILE + '.tmp';

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(state, null, 2),
    'utf8'
  );

  await fs.rename(temporaryFile, DATA_FILE);

  return {
    rankedCandidates,
    snapshotsSaved: rankedCandidates.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    rankMemoryCount: Object.keys(state.rankMemory).length,
    rankChanges,
  };
}
