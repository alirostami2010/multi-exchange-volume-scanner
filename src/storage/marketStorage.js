
/**
 * MARKET STORAGE — LONG BUY RADAR
 * -----------------------------------------------
 * Ranking: Single Long-Only Score
 * Ranking sort: Strict descending
 *
 * Detailed history: 15 days
 * Coin summaries: 30 days
 * Rank memory: 15 days
 *
 * Rank changes compare ONLY with the immediately
 * previous valid scan.
 *
 * Scan frequency does not contribute to score.
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

const MAX_RANK_COMPARISON_AGE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

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

      tradeStates:
        data.tradeStates &&
        typeof data.tradeStates === 'object'
          ? data.tradeStates
          : {},

      events:
        data.events &&
        typeof data.events === 'object'
          ? data.events
          : {},

      scanMeta:
        data.scanMeta &&
        typeof data.scanMeta === 'object'
          ? data.scanMeta
          : null
    };

  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        history: [],
        summaries: {},
        rankMemory: {},
        tradeStates: {},
        events: {},
        scanMeta: null
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
// PREVIOUS SCAN VALIDATION
// ============================================================

function getPreviousScanRanks(scanMeta, nowMs) {
  if (
    !scanMeta ||
    !scanMeta.timestamp ||
    !scanMeta.ranks ||
    typeof scanMeta.ranks !== 'object'
  ) {
    return null;
  }

  const previousTime = Date.parse(scanMeta.timestamp);

  if (!Number.isFinite(previousTime)) {
    return null;
  }

  const age = nowMs - previousTime;

  if (
    age < 0 ||
    age > MAX_RANK_COMPARISON_AGE_MS
  ) {
    return null;
  }

  return scanMeta.ranks;
}

// ============================================================
// RANK CHANGE
// ============================================================

function buildRankChanges(
  rankedCandidates,
  previousScanRanks
) {
  const result = {};

  for (const coin of rankedCandidates) {
    const previousRank =
      previousScanRanks &&
      Number.isFinite(
        Number(previousScanRanks[coin.symbol])
      ) &&
      Number(previousScanRanks[coin.symbol]) > 0
        ? Number(previousScanRanks[coin.symbol])
        : null;

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
// STRICT SORTING
// ============================================================

function compareCandidates(a, b) {
  const scoreDifference =
    number(b.score) - number(a.score);

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  return String(a.symbol).localeCompare(
    String(b.symbol)
  );
}

// ============================================================
// SNAPSHOT BUILDER
// ============================================================

function buildSnapshot(coin, timestamp) {
  return {
    timestamp,

    symbol: coin.symbol,

    price: number(coin.price),

    livePrice: number(coin.livePrice),

    score: number(coin.score),

    scoreRaw: number(coin.scoreRaw),

    rank: number(coin.rank),

    strength: coin.strength || null,

    // Estimated pressure, not verified taker flow.
    pressureScore: number(coin.pressureScore),

    pressureQuality: coin.pressureQuality || 'UNKNOWN',

    closeLocation: number(coin.closeLocation),

    momentum: coin.momentum || {},

    volume: coin.volume || {},

    components: coin.components || {},

    confirmations: Array.isArray(coin.confirmations)
      ? coin.confirmations
      : []
  };
}

// ============================================================
// SAVE SNAPSHOT
// ============================================================

export async function saveMarketSnapshot(candidates = []) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const state = await readState();

  // ----------------------------------------------------------
  // PREVIOUS SCAN
  // ----------------------------------------------------------

  const previousScanRanks = getPreviousScanRanks(
    state.scanMeta,
    nowMs
  );

  // ----------------------------------------------------------
  // PREPARE CURRENT RAW SCORES
  // ----------------------------------------------------------

  const uniqueCandidates = new Map();

  for (const coin of candidates) {
    if (
      !coin ||
      typeof coin.symbol !== 'string' ||
      coin.symbol.length === 0
    ) {
      continue;
    }

    const rawScore = clamp(
      number(coin.score),
      0,
      100
    );

    const normalized = {
      ...coin,

      scoreRaw: rawScore,

      // No old-score smoothing.
      // Current valid market conditions determine ranking.
      score: rawScore
    };

    const existing = uniqueCandidates.get(coin.symbol);

    if (
      !existing ||
      normalized.score > existing.score
    ) {
      uniqueCandidates.set(coin.symbol, normalized);
    }
  }

  const rankedCandidates = [
    ...uniqueCandidates.values()
  ];

  // ----------------------------------------------------------
  // SINGLE RANKING
  // ----------------------------------------------------------

  rankedCandidates.sort(compareCandidates);

  rankedCandidates.forEach((coin, index) => {
    coin.rank = index + 1;
  });

  // ----------------------------------------------------------
  // RANK CHANGES
  // ----------------------------------------------------------

  const rankChanges = buildRankChanges(
    rankedCandidates,
    previousScanRanks
  );

  // ----------------------------------------------------------
  // UPDATE SUMMARIES AND RANK MEMORY
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

  const currentSnapshots = rankedCandidates.map(
    coin => buildSnapshot(coin, now)
  );

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

  for (const [symbol, summary] of Object.entries(
    state.summaries
  )) {
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

  for (const [symbol, memory] of Object.entries(
    state.rankMemory
  )) {
    const updated = Date.parse(memory.updatedAt);

    if (
      !Number.isFinite(updated) ||
      updated < memoryCutoff
    ) {
      delete state.rankMemory[symbol];
    }
  }

  // ----------------------------------------------------------
  // SAVE IMMEDIATELY PREVIOUS SCAN
  // ----------------------------------------------------------

  // Even an empty scan is saved.
  // This prevents a coin from being compared against
  // an old rank after disappearing from the latest scan.

  const currentScanRanks = {};

  for (const coin of rankedCandidates) {
    currentScanRanks[coin.symbol] = coin.rank;
  }

  state.scanMeta = {
    timestamp: now,
    candidateCount: rankedCandidates.length,
    ranks: currentScanRanks
  };

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

      tradeStates: state.tradeStates,

      events: state.events,

      scanMeta: state.scanMeta

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
