
/**
 * MARKET STORAGE — LONG BUY RADAR
 * -----------------------------------------------
 * Ranking: Single Long-Only Score
 * Detailed history: 15 days
 * Coin summaries: 30 days
 * Rank memory: 15 days
 *
 * File: src/storage/marketStorage.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================
// CONFIG
// ============================================================

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');

const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;
const RANK_MEMORY_RETENTION_DAYS = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

const SCORE_SMOOTHING = 0.70;

// ============================================================
// UTILITIES
// ============================================================

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const pctChange = (current, previous) =>
  !previous || previous <= 0
    ? 0
    : ((current - previous) / previous) * 100;

// ============================================================
// READ STATE
// ============================================================

async function readState() {
  try {
    const data = JSON.parse(
      await fs.readFile(DATA_FILE, 'utf8')
    );

    return {
      history: Array.isArray(data.history)
        ? data.history
        : [],

      summaries:
        data.summaries &&
        typeof data.summaries === 'object'
          ? data.summaries
          : {},

      rankMemory:
        data.rankMemory &&
        typeof data.rankMemory === 'object'
          ? data.rankMemory
          : {},

      // Preserve previous data for backward compatibility.
      tradeStates:
        data.tradeStates &&
        typeof data.tradeStates === 'object'
          ? data.tradeStates
          : {},

      events:
        data.events &&
        typeof data.events === 'object'
          ? data.events
          : {}
    };

  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        history: [],
        summaries: {},
        rankMemory: {},
        tradeStates: {},
        events: {}
      };
    }

    throw error;
  }
}

// ============================================================
// PRICE
// ============================================================

function getObservationPrice(coin) {
  const livePrice = number(coin.livePrice);

  return livePrice > 0
    ? livePrice
    : number(coin.price);
}

// ============================================================
// SUMMARY
// ============================================================

function updateSummary(previous, coin, now) {
  const price = getObservationPrice(coin);

  if (price <= 0) return previous;

  const summary = previous || {
    symbol: coin.symbol,

    firstDiscoveredAt: now,

    firstDiscoveryPrice: price,

    highestPrice: price,

    lowestPrice: price,

    maxGainPercent: 0,

    bestRank: null,

    bestScore: 0,

    lastSeenAt: now,

    lastPrice: price,

    lastScore: coin.score,

    observations: 0
  };

  summary.highestPrice = Math.max(
    number(summary.highestPrice, price),
    price
  );

  summary.lowestPrice = Math.min(
    number(summary.lowestPrice, price),
    price
  );

  const gain =
    summary.firstDiscoveryPrice > 0
      ? pctChange(
          summary.highestPrice,
          summary.firstDiscoveryPrice
        )
      : 0;

  summary.maxGainPercent = Math.max(
    number(summary.maxGainPercent),
    gain
  );

  if (coin.rank > 0) {
    summary.bestRank =
      summary.bestRank == null
        ? coin.rank
        : Math.min(
            number(summary.bestRank, coin.rank),
            coin.rank
          );
  }

  summary.bestScore = Math.max(
    number(summary.bestScore),
    number(coin.score)
  );

  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastScore = number(coin.score);

  summary.observations =
    number(summary.observations) + 1;

  return summary;
}

// ============================================================
// SCORE SMOOTHING
// ============================================================

function smoothScore(current, previous) {
  const raw = clamp(number(current), 0, 100);

  if (
    !previous ||
    !Number.isFinite(Number(previous.score))
  ) {
    return raw;
  }

  const oldScore = number(previous.score);

  if (Math.abs(raw - oldScore) < 1.5) {
    return oldScore;
  }

  return Number(
    (
      oldScore * SCORE_SMOOTHING +
      raw * (1 - SCORE_SMOOTHING)
    ).toFixed(2)
  );
}

// ============================================================
// RANK CHANGE
// ============================================================

function buildRankChanges(rankedCandidates, previousMemory) {
  const result = {};

  for (const coin of rankedCandidates) {
    const previous = previousMemory[coin.symbol];

    const previousRank =
      previous?.rank ??
      previous?.growth?.rank ??
      previous?.move?.rank ??
      null;

    const change =
      previousRank == null
        ? null
        : previousRank - coin.rank;

    result[coin.symbol] = {
      status:
        previousRank == null
          ? 'NEW'
          : change > 0
            ? 'UP'
            : change < 0
              ? 'DOWN'
              : 'SAME',

      previousRank,

      currentRank: coin.rank,

      change
    };
  }

  return result;
}

// ============================================================
// SORTING
// ============================================================

function compareCandidates(a, b) {
  const scoreDifference =
    number(b.score) - number(a.score);

  if (Math.abs(scoreDifference) > 1.25) {
    return scoreDifference;
  }

  return a.symbol.localeCompare(b.symbol);
}

// ============================================================
// SAVE SNAPSHOT
// ============================================================

export async function saveMarketSnapshot(candidates = []) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const state = await readState();

  const previousMemory = state.rankMemory;

  // ----------------------------------------------------------
  // SMOOTH SCORES
  // ----------------------------------------------------------

  const rankedCandidates = candidates.map(coin => {
    const previous = previousMemory[coin.symbol];

    const rawScore = number(coin.score);

    const smoothedScore = smoothScore(
      rawScore,
      previous
    );

    return {
      ...coin,

      scoreRaw: rawScore,

      score: Number(smoothedScore.toFixed(2))
    };
  });

  // ----------------------------------------------------------
  // SINGLE RANKING
  // ----------------------------------------------------------

  rankedCandidates.sort(compareCandidates);

  rankedCandidates.forEach((coin, index) => {
    coin.rank = index + 1;
  });

  const rankChanges = buildRankChanges(
    rankedCandidates,
    previousMemory
  );

  // ----------------------------------------------------------
  // UPDATE SUMMARIES AND MEMORY
  // ----------------------------------------------------------

  for (const coin of rankedCandidates) {
    state.summaries[coin.symbol] = updateSummary(
      state.summaries[coin.symbol],
      coin,
      now
    );

    state.rankMemory[coin.symbol] = {
      score: coin.score,
      rank: coin.rank,
      updatedAt: now
    };
  }

  // ----------------------------------------------------------
  // SNAPSHOTS
  // ----------------------------------------------------------

  const currentSnapshots = rankedCandidates.map(coin => ({
    timestamp: now,

    symbol: coin.symbol,

    price: coin.price,

    livePrice: coin.livePrice,

    score: coin.score,

    scoreRaw: coin.scoreRaw,

    rank: coin.rank,

    strength: coin.strength,

    buyRatio: coin.buyRatio,

    buyVolume: coin.buyVolume,

    sellVolume: coin.sellVolume,

    tradeCount: coin.tradeCount,

    flowQuality: coin.flowQuality,

    momentum: coin.momentum,

    volume: coin.volume,

    components: coin.components,

    confirmations: coin.confirmations
  }));

  state.history.push(...currentSnapshots);

  // ----------------------------------------------------------
  // CLEAN HISTORY: 15 DAYS
  // ----------------------------------------------------------

  const historyCutoff =
    nowMs - HISTORY_RETENTION_DAYS * DAY_MS;

  state.history = state.history.filter(item => {
    const timestamp = Date.parse(item.timestamp);

    return (
      Number.isFinite(timestamp) &&
      timestamp >= historyCutoff
    );
  });

  // ----------------------------------------------------------
  // CLEAN SUMMARIES: 30 DAYS
  // ----------------------------------------------------------

  const summaryCutoff =
    nowMs - SUMMARY_RETENTION_DAYS * DAY_MS;

  for (const [symbol, summary] of Object.entries(state.summaries)) {
    const lastSeen = Date.parse(summary.lastSeenAt);

    if (
      !Number.isFinite(lastSeen) ||
      lastSeen < summaryCutoff
    ) {
      delete state.summaries[symbol];
    }
  }

  // ----------------------------------------------------------
  // CLEAN RANK MEMORY: 15 DAYS
  // ----------------------------------------------------------

  const memoryCutoff =
    nowMs - RANK_MEMORY_RETENTION_DAYS * DAY_MS;

  for (const [symbol, memory] of Object.entries(state.rankMemory)) {
    const updated = Date.parse(memory.updatedAt);

    if (
      !Number.isFinite(updated) ||
      updated < memoryCutoff
    ) {
      delete state.rankMemory[symbol];
    }
  }

  // ----------------------------------------------------------
  // WRITE ATOMICALLY
  // ----------------------------------------------------------

  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporaryFile = `${DATA_FILE}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify({
      updatedAt: now,

      history: state.history,

      summaries: state.summaries,

      rankMemory: state.rankMemory,

      // Keep old records; the new scanner does not use them.
      tradeStates: state.tradeStates,

      events: state.events

    }, null, 2),
    'utf8'
  );

  await fs.rename(
    temporaryFile,
    DATA_FILE
  );

  // ----------------------------------------------------------
  // RESULT
  // ----------------------------------------------------------

  return {
    rankedCandidates,

    snapshotsSaved: currentSnapshots.length,

    historyCount: state.history.length,

    summaryCount: Object.keys(state.summaries).length,

    rankMemoryCount: Object.keys(state.rankMemory).length,

    rankChanges
  };
}
