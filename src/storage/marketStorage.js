/**
 * MARKET STORAGE — DUAL RANKING + EVENT LIFECYCLE
 * Detailed history: 15 days | Coin summaries: 30 days
 * Growth and early-move rankings are smoothed independently.
 * File: src/storage/marketStorage.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');
const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;
const EVENT_RETENTION_DAYS = 30;
const RANK_MEMORY_RETENTION_DAYS = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const GROWTH_SMOOTHING = 0.78;
const MOVE_SMOOTHING = 0.68;

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pctChange = (current, previous) =>
  !previous || previous <= 0 ? 0 : ((current - previous) / previous) * 100;

async function readState() {
  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    return {
      history: Array.isArray(data.history) ? data.history : [],
      summaries: data.summaries && typeof data.summaries === 'object' ? data.summaries : {},
      tradeStates: data.tradeStates && typeof data.tradeStates === 'object' ? data.tradeStates : {},
      rankMemory: data.rankMemory && typeof data.rankMemory === 'object' ? data.rankMemory : {},
      events: data.events && typeof data.events === 'object' ? data.events : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { history: [], summaries: {}, tradeStates: {}, rankMemory: {}, events: {} };
    }
    throw error;
  }
}

export async function getTradeStates() {
  const state = await readState();
  return state.tradeStates;
}

function getObservationPrice(item) {
  const livePrice = number(item.livePrice);
  return livePrice > 0 ? livePrice : number(item.price);
}

function updateSummary(previous, coin, now) {
  const price = getObservationPrice(coin);
  if (!Number.isFinite(price) || price <= 0) return previous;
  const summary = previous || {
    symbol: coin.symbol,
    firstDiscoveredAt: now,
    firstDiscoveryPrice: price,
    highestPrice: price,
    lowestPrice: price,
    maxGainPercent: 0,
    bestGrowthRank: coin.growthRank,
    bestMoveRank: coin.moveRank,
    lastSeenAt: now,
    lastPrice: price,
    lastGrowthScore: coin.growthScore,
    lastMoveScore: coin.moveScore,
    observations: 0,
  };
  summary.highestPrice = Math.max(number(summary.highestPrice, price), price);
  summary.lowestPrice = Math.min(number(summary.lowestPrice, price), price);
  const gain = summary.firstDiscoveryPrice > 0
    ? ((summary.highestPrice - summary.firstDiscoveryPrice) / summary.firstDiscoveryPrice) * 100 : 0;
  summary.maxGainPercent = Math.max(number(summary.maxGainPercent), gain);
  summary.bestGrowthRank = Math.min(number(summary.bestGrowthRank, coin.growthRank), coin.growthRank);
  summary.bestMoveRank = Math.min(number(summary.bestMoveRank, coin.moveRank), coin.moveRank);
  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastGrowthScore = coin.growthScore;
  summary.lastMoveScore = coin.moveScore;
  summary.observations = number(summary.observations) + 1;
  return summary;
}

function smoothScore(current, previous, alpha) {
  const raw = clamp(number(current), 0, 100);
  if (!previous || !Number.isFinite(Number(previous.score))) return raw;
  const oldScore = number(previous.score);
  if (Math.abs(raw - oldScore) < 1.5) return oldScore;
  return Number((oldScore * alpha + raw * (1 - alpha)).toFixed(2));
}

function buildEvent(previous, coin, nowMs, nowIso) {
  const price = getObservationPrice(coin);
  const activeTypes = new Set(['COMPRESSION_BREAKOUT', 'BULLISH_REVERSAL', 'COMPRESSION_WATCH']);
  const incomingActive = activeTypes.has(coin.moveType) &&
    ['WATCHING', 'EARLY', 'CONFIRMED', 'LATE'].includes(coin.moveStatus);

  let event = previous ? { ...previous } : null;
  if (incomingActive) {
    const sameEvent = event && event.type === coin.moveType &&
      !['INVALIDATED', 'COMPLETED'].includes(event.status);
    if (!sameEvent) {
      event = {
        symbol: coin.symbol,
        type: coin.moveType,
        label: coin.moveTypeLabel,
        status: coin.moveStatus,
        startedAt: new Date(nowMs - number(coin.moveAgeMinutes, 0) * 60000).toISOString(),
        startPrice: price,
        highestPrice: price,
        lastSeenAt: nowIso,
        barsSinceTrigger: number(coin.moveAgeBars, 0),
      };
    } else {
      event.status = coin.moveStatus;
      event.lastSeenAt = nowIso;
      event.highestPrice = Math.max(number(event.highestPrice, price), price);
      event.barsSinceTrigger = Math.max(number(event.barsSinceTrigger), number(coin.moveAgeBars, 0));
    }
  } else if (event && !['INVALIDATED', 'COMPLETED'].includes(event.status)) {
    const ageMs = nowMs - Date.parse(event.startedAt);
    const startPrice = number(event.startPrice);
    const gainPct = startPrice > 0 ? pctChange(price, startPrice) : 0;
    if (price > 0 && startPrice > 0 && price <= startPrice * 0.97) {
      event.status = 'INVALIDATED';
      event.endedAt = nowIso;
      event.endReason = 'قیمت بیش از ۳٪ زیر قیمت شروع رویداد قرار گرفت';
    } else if (gainPct >= 10 || ageMs > 24 * 60 * 60 * 1000) {
      event.status = 'COMPLETED';
      event.endedAt = nowIso;
      event.endReason = gainPct >= 10 ? 'حرکت اولیه بیش از ۱۰٪ انجام شد' : 'پنجره تازگی رویداد پایان یافت';
    } else if (ageMs <= 4 * 60 * 60 * 1000) {
      event.status = 'WATCHING';
    } else {
      event.status = 'COMPLETED';
      event.endedAt = nowIso;
      event.endReason = 'نشانه‌های شروع حرکت در بازه اخیر تکرار نشد';
    }
  }

  if (!event) return null;
  const startedAtMs = Date.parse(event.startedAt);
  const ageMinutes = Number.isFinite(startedAtMs) ? Math.max(0, (nowMs - startedAtMs) / 60000) : null;
  const startPrice = number(event.startPrice);
  const gainPct = startPrice > 0 && price > 0 ? pctChange(price, startPrice) : 0;
  return {
    ...event,
    currentPrice: price,
    gainPct: Number(gainPct.toFixed(3)),
    ageMinutes: ageMinutes == null ? null : Number(ageMinutes.toFixed(1)),
  };
}

const compareBy = (field) => (a, b) =>
  number(b[field]) - number(a[field]) || a.symbol.localeCompare(b.symbol);

function buildRankChanges(rankedCandidates, previousMemory) {
  const result = {};
  for (const coin of rankedCandidates) {
    const previous = previousMemory[coin.symbol];
    const growthPreviousRank = previous?.growth?.rank;
    const movePreviousRank = previous?.move?.rank;
    const growthChange = growthPreviousRank == null ? null : growthPreviousRank - coin.growthRank;
    const moveChange = movePreviousRank == null ? null : movePreviousRank - coin.moveRank;
    result[coin.symbol] = {
      growth: {
        status: growthPreviousRank == null ? 'NEW' : growthChange > 0 ? 'UP' : growthChange < 0 ? 'DOWN' : 'SAME',
        previousRank: growthPreviousRank ?? null,
        currentRank: coin.growthRank,
        change: growthChange,
      },
      move: {
        status: movePreviousRank == null ? 'NEW' : moveChange > 0 ? 'UP' : moveChange < 0 ? 'DOWN' : 'SAME',
        previousRank: movePreviousRank ?? null,
        currentRank: coin.moveRank,
        change: moveChange,
      },
    };
  }
  return result;
}

function mergeTradeStates(previous, incoming, now) {
  const merged = { ...previous };
  if (Array.isArray(incoming)) {
    for (const item of incoming) if (item?.symbol) merged[item.symbol] = { ...item, updatedAt: now };
  } else if (incoming && typeof incoming === 'object') {
    for (const [symbol, item] of Object.entries(incoming)) {
      if (item && typeof item === 'object') merged[symbol] = { ...item, symbol, updatedAt: now };
    }
  }
  return merged;
}

export async function saveMarketSnapshot(candidates, options = {}) {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const state = await readState();
  const previousMemory = state.rankMemory;

  const rankedCandidates = candidates.map((coin) => {
    const previous = previousMemory[coin.symbol];
    const growthSmoothed = smoothScore(coin.growthScore, previous?.growth, GROWTH_SMOOTHING);
    const moveSmoothed = smoothScore(coin.moveScore, previous?.move, MOVE_SMOOTHING);
    const event = buildEvent(state.events[coin.symbol], coin, nowMs, now);
    return {
      ...coin,
      growthScoreRaw: number(coin.growthScore),
      moveScoreRaw: number(coin.moveScore),
      growthScore: Number(growthSmoothed.toFixed(2)),
      growthStatus: growthSmoothed >= 75 ? 'HIGH_POTENTIAL' : growthSmoothed >= 60 ? 'WATCHLIST' : 'NORMAL',
      moveScore: Number(moveSmoothed.toFixed(2)),
      growthEvent: event,
    };
  });

  const stableCompare = (scoreField, rankField) => (a, b) => {
    const scoreDiff = number(b[scoreField]) - number(a[scoreField]);
    if (Math.abs(scoreDiff) > 1.25) return scoreDiff;
    const previousA = number(previousMemory[a.symbol]?.[rankField], 999999);
    const previousB = number(previousMemory[b.symbol]?.[rankField], 999999);
    if (previousA !== previousB) return previousA - previousB;
    return a.symbol.localeCompare(b.symbol);
  };
  const growthSorted = [...rankedCandidates].sort(stableCompare('growthScore', 'growthRank'));
  const moveSorted = [...rankedCandidates].sort(stableCompare('moveScore', 'moveRank'));
  growthSorted.forEach((coin, index) => { coin.growthRank = index + 1; });
  moveSorted.forEach((coin, index) => { coin.moveRank = index + 1; });
  const rankChanges = buildRankChanges(rankedCandidates, previousMemory);

  for (const coin of rankedCandidates) {
    state.summaries[coin.symbol] = updateSummary(state.summaries[coin.symbol], coin, now);
    if (coin.growthEvent) state.events[coin.symbol] = coin.growthEvent;
    state.rankMemory[coin.symbol] = {
      growth: { score: coin.growthScore, rank: coin.growthRank },
      move: { score: coin.moveScore, rank: coin.moveRank },
      updatedAt: now,
    };
  }

  const currentSnapshots = rankedCandidates.map((coin) => ({
    timestamp: now,
    symbol: coin.symbol,
    price: coin.price,
    livePrice: coin.livePrice,
    growthScore: coin.growthScore,
    growthScoreRaw: coin.growthScoreRaw,
    growthRank: coin.growthRank,
    growthStatus: coin.growthStatus,
    moveScore: coin.moveScore,
    moveScoreRaw: coin.moveScoreRaw,
    moveRank: coin.moveRank,
    moveStatus: coin.moveStatus,
    moveType: coin.moveType,
    growthEvent: coin.growthEvent,
    returns: coin.returns,
    volume: coin.volume,
    structure: coin.structure,
    derivatives: coin.derivatives,
    evidence: coin.evidence,
    warnings: coin.warnings,
    tradeStatus: coin.tradeStatus,
    tradeSetup: coin.tradeSetup,
  }));

  state.history.push(...currentSnapshots);
  const historyCutoff = nowMs - HISTORY_RETENTION_DAYS * DAY_MS;
  state.history = state.history.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return Number.isFinite(timestamp) && timestamp >= historyCutoff;
  });

  const summaryCutoff = nowMs - SUMMARY_RETENTION_DAYS * DAY_MS;
  for (const [symbol, summary] of Object.entries(state.summaries)) {
    const lastSeen = Date.parse(summary.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < summaryCutoff) delete state.summaries[symbol];
  }

  const eventCutoff = nowMs - EVENT_RETENTION_DAYS * DAY_MS;
  for (const [symbol, event] of Object.entries(state.events)) {
    const lastSeen = Date.parse(event.lastSeenAt || event.startedAt);
    if (!Number.isFinite(lastSeen) || lastSeen < eventCutoff) delete state.events[symbol];
  }

  const rankMemoryCutoff = nowMs - RANK_MEMORY_RETENTION_DAYS * DAY_MS;
  for (const [symbol, memory] of Object.entries(state.rankMemory)) {
    const updated = Date.parse(memory.updatedAt);
    if (!Number.isFinite(updated) || updated < rankMemoryCutoff) delete state.rankMemory[symbol];
  }

  state.tradeStates = mergeTradeStates(state.tradeStates, options.tradeStates ?? options.signals, now);

  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = `${DATA_FILE}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify({
    updatedAt: now,
    history: state.history,
    summaries: state.summaries,
    tradeStates: state.tradeStates,
    rankMemory: state.rankMemory,
    events: state.events,
  }, null, 2), 'utf8');
  await fs.rename(temporaryFile, DATA_FILE);

  return {
    rankedCandidates,
    snapshotsSaved: currentSnapshots.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    tradeStateCount: Object.keys(state.tradeStates).length,
    eventCount: Object.keys(state.events).length,
    rankChanges,
    tradeStates: state.tradeStates,
  };
}
