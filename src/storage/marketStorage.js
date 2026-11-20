/**
 * MARKET STORAGE — OPPORTUNITY RANKING + ENTRY SCORE + TRADE STATE
 * History: 15 days | Summary: 30 days
 * Opportunity ranking is independent of entry timing and trade status.
 * File: src/storage/marketStorage.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');

const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MOMENTUM_LOOKBACK_MS = 90 * 60 * 1000;

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

// ========================
// READ STATE
// ========================

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

      tradeStates:
        data.tradeStates &&
        typeof data.tradeStates === 'object'
          ? data.tradeStates
          : {},
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        history: [],
        summaries: {},
        tradeStates: {},
      };
    }

    throw error;
  }
}

export async function getTradeStates() {
  const state = await readState();
  return state.tradeStates;
}

// ========================
// OBSERVATION PRICE
// ========================

function getObservationPrice(item) {
  const livePrice = number(item.livePrice);

  return livePrice > 0
    ? livePrice
    : number(item.price);
}

// ========================
// PRICE PERSISTENCE
// ========================

function calculatePricePersistence(
  coin,
  previousRecords,
  nowMs
) {
  const observations = previousRecords
    .filter((item) => {
      const timestamp = Date.parse(item.timestamp);

      return (
        Number.isFinite(timestamp) &&
        timestamp >= nowMs - MOMENTUM_LOOKBACK_MS &&
        timestamp < nowMs &&
        getObservationPrice(item) > 0
      );
    })
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) -
        Date.parse(b.timestamp)
    )
    .slice(-5);

  const currentPrice = getObservationPrice(coin);

  if (!currentPrice || !observations.length) {
    return {
      score: 50,
      positiveSteps: 0,
      netChange: 0,
      observations: observations.length,
    };
  }

  const prices = [
    ...observations.map(getObservationPrice),
    currentPrice,
  ];

  let positiveSteps = 0;
  let validSteps = 0;

  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] <= 0) continue;

    validSteps++;

    if (prices[i] > prices[i - 1]) {
      positiveSteps++;
    }
  }

  const positiveRatio = validSteps
    ? positiveSteps / validSteps
    : 0.5;

  const netChange = pctChange(
    currentPrice,
    prices[0]
  );

  const score = clamp(
    50 +
      (positiveRatio - 0.5) * 60 +
      clamp(netChange * 8, -20, 20),
    0,
    100
  );

  return {
    score: Math.round(score),
    positiveSteps,
    netChange,
    observations: observations.length,
  };
}

// ========================
// VOLUME PERSISTENCE
// ========================

function calculateVolumePersistence(
  coin,
  previousRecords
) {
  const live = coin.live15m;

  const bucketTime = number(live?.bucketTime);
  const currentTurnover = number(live?.turnover);

  const fallback = () => {
    const ratio = number(
      coin.volume?.['15m'],
      1
    );

    return {
      score: Math.round(
        clamp(50 + (ratio - 1) * 20, 35, 75)
      ),
      delta: null,
      positiveSteps: 0,
      sameBucket: false,
    };
  };

  if (!bucketTime || currentTurnover <= 0) {
    return fallback();
  }

  const sameBucketRecords = previousRecords
    .filter((item) => (
      number(item.live15m?.bucketTime) === bucketTime &&
      number(item.live15m?.turnover) > 0
    ))
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) -
        Date.parse(b.timestamp)
    );

  if (!sameBucketRecords.length) {
    return fallback();
  }

  const previous =
    sameBucketRecords[sameBucketRecords.length - 1];

  const previousTurnover = number(
    previous.live15m?.turnover
  );

  const delta = currentTurnover - previousTurnover;

  const deltaRatio = previousTurnover > 0
    ? delta / previousTurnover
    : 0;

  const sequence = [
    ...sameBucketRecords.map((item) =>
      number(item.live15m?.turnover)
    ),
    currentTurnover,
  ];

  let positiveSteps = 0;

  for (let i = sequence.length - 1; i > 0; i--) {
    if (sequence[i] > sequence[i - 1]) {
      positiveSteps++;
    } else {
      break;
    }
  }

  let score = 50;

  if (delta > 0) {
    score +=
      12 +
      clamp(deltaRatio * 20, 0, 15) +
      Math.min(positiveSteps, 3) * 5;
  } else if (delta < 0) {
    score -= 12;
  }

  return {
    score: Math.round(clamp(score, 0, 100)),
    delta,
    positiveSteps,
    sameBucket: true,
  };
}

// ========================
// OPPORTUNITY MOMENTUM
// ========================

function calculateMomentum(coin, history, nowMs) {
  const previousRecords = history.filter(
    (item) => item.symbol === coin.symbol
  );

  const price = calculatePricePersistence(
    coin,
    previousRecords,
    nowMs
  );

  const volume = calculateVolumePersistence(
    coin,
    previousRecords
  );

  const persistenceScore = Math.round(
    price.score * 0.6 +
    volume.score * 0.4
  );

  const return1h = number(coin.returns?.['1h']);
  const return4h = number(coin.returns?.['4h']);

  const score1h = clamp(
    50 + (return1h / 3) * 50,
    0,
    100
  );

  const score4h = clamp(
    50 + (return4h / 6) * 50,
    0,
    100
  );

  const daily = coin.daily || {};

  const dailyScore = clamp(
    number(daily.score, 50),
    0,
    100
  );

  const baseScore = clamp(
    number(coin.score),
    0,
    100
  );

  /*
   * Opportunity Score:
   * Base structural score: 30%
   * 1H momentum:           15%
   * 4H momentum:           15%
   * Daily context:         20%
   * Persistence:           20%
   *
   * 15m and 5m are deliberately excluded.
   * This avoids double-counting short-term entry signals.
   * Trade status and opportunity group never affect this score.
   */

  const opportunityScore =
    baseScore * 0.30 +
    score1h * 0.15 +
    score4h * 0.15 +
    dailyScore * 0.20 +
    persistenceScore * 0.20;

  /*
   * Entry Score is informational only.
   * It does not change Opportunity Score or ranking.
   */

  const entryScore = clamp(
    number(coin.entryScore, 50),
    0,
    100
  );

  return {
    rankScore: Number(opportunityScore.toFixed(2)),
    opportunityScore: Number(opportunityScore.toFixed(2)),
    entryScore: Math.round(entryScore),

    persistenceScore,

    pricePersistence: price.score,
    volumePersistence: volume.score,

    positivePriceSteps: price.positiveSteps,
    positiveVolumeSteps: volume.positiveSteps,

    priceChangeDuringObservations: Number(
      price.netChange.toFixed(4)
    ),

    volumeDelta15m: volume.delta,
    volumeSameBucket: volume.sameBucket,

    dailyScore: Math.round(dailyScore),

    timeframeScores: {
      '1h': Math.round(score1h),
      '4h': Math.round(score4h),
      '1d': Math.round(dailyScore),
      '15m': Math.round(
        clamp(
          50 + (number(coin.returns?.['15m']) / 2) * 50,
          0,
          100
        )
      ),
    },

    dailyMetrics: {
      dailyReturn: number(daily.dailyReturn),
      dailyOpenReturn: number(daily.dailyOpenReturn),

      volumeRatio5: number(daily.volumeRatio5),
      volumeRatio10: number(daily.volumeRatio10),

      projectedVolumeRatio: number(
        daily.projectedVolumeRatio
      ),

      emaBullish: Boolean(daily.emaBullish),
      ema50Bullish: Boolean(daily.ema50Bullish),
      emaSlope: Boolean(daily.emaSlope),

      breakout20: Boolean(daily.breakout20),
      breakout50: Boolean(daily.breakout50),

      higherHigh: Boolean(daily.higherHigh),
      higherLow: Boolean(daily.higherLow),

      currentCandle: Boolean(daily.currentCandle),
    },
  };
}

// ========================
// SUMMARY
// ========================

function updateSummary(previous, coin, rank, now) {
  const price = getObservationPrice(coin);

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
    lastOpportunityScore: coin.opportunityScore,
    lastEntryScore: coin.entryScore,
    lastStage: coin.stage,
    observations: 0,
  };

  summary.highestPrice = Math.max(
    number(summary.highestPrice, price),
    price
  );

  summary.lowestPrice = Math.min(
    number(summary.lowestPrice, price),
    price
  );

  const gain = summary.firstDiscoveryPrice > 0
    ? (
        (summary.highestPrice -
          summary.firstDiscoveryPrice) /
        summary.firstDiscoveryPrice
      ) * 100
    : 0;

  summary.maxGainPercent = Math.max(
    number(summary.maxGainPercent),
    gain
  );

  summary.bestRank = Math.min(
    number(summary.bestRank, rank),
    rank
  );

  summary.lastSeenAt = now;
  summary.lastPrice = price;
  summary.lastScore = coin.score;
  summary.lastOpportunityScore = coin.opportunityScore;
  summary.lastEntryScore = coin.entryScore;
  summary.lastStage = coin.stage;
  summary.observations =
    number(summary.observations) + 1;

  return summary;
}

// ========================
// RANKING
// ========================

function compareCandidates(a, b) {
  const opportunityDifference =
    number(b.opportunityScore, b.rankScore) -
    number(a.opportunityScore, a.rankScore);

  if (opportunityDifference !== 0) {
    return opportunityDifference;
  }

  const persistenceDifference =
    number(b.persistenceScore) -
    number(a.persistenceScore);

  if (persistenceDifference !== 0) {
    return persistenceDifference;
  }

  const fourHourDifference =
    number(b.timeframeScores?.['4h']) -
    number(a.timeframeScores?.['4h']);

  if (fourHourDifference !== 0) {
    return fourHourDifference;
  }

  const dailyDifference =
    number(b.dailyScore) -
    number(a.dailyScore);

  if (dailyDifference !== 0) {
    return dailyDifference;
  }

  return number(b.score) - number(a.score);
}

// ========================
// TRADE STATE MERGE
// ========================

function mergeTradeStates(previous, incoming, now) {
  const merged = { ...previous };

  if (Array.isArray(incoming)) {
    for (const item of incoming) {
      if (item?.symbol) {
        merged[item.symbol] = {
          ...item,
          updatedAt: now,
        };
      }
    }
  } else if (
    incoming &&
    typeof incoming === 'object'
  ) {
    for (const [symbol, item] of Object.entries(incoming)) {
      if (item && typeof item === 'object') {
        merged[symbol] = {
          ...item,
          symbol,
          updatedAt: now,
        };
      }
    }
  }

  return merged;
}

// ========================
// SAVE AND RANK
// ========================

export async function saveMarketSnapshot(
  candidates,
  options = {}
) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const state = await readState();

  const rankedCandidates = candidates
    .map((coin) => {
      const momentum = calculateMomentum(
        coin,
        state.history,
        nowMs
      );

      return {
        ...coin,
        ...momentum,
      };
    })
    .sort(compareCandidates);

  const previousRunTimestamp = state.history.reduce(
    (latest, item) =>
      item.timestamp &&
      (!latest || item.timestamp > latest)
        ? item.timestamp
        : latest,
    null
  );

  const previousRanks = new Map();

  if (previousRunTimestamp) {
    for (const item of state.history) {
      if (item.timestamp === previousRunTimestamp) {
        previousRanks.set(item.symbol, item.rank);
      }
    }
  }

  const rankChanges = {};

  rankedCandidates.forEach((coin, index) => {
    const currentRank = index + 1;
    const previousRank = previousRanks.get(coin.symbol);

    if (previousRank === undefined) {
      rankChanges[coin.symbol] = {
        status: 'NEW',
        previousRank: null,
        currentRank,
        change: null,
      };
    } else {
      const change = previousRank - currentRank;

      rankChanges[coin.symbol] = {
        status:
          change > 0
            ? 'UP'
            : change < 0
              ? 'DOWN'
              : 'SAME',

        previousRank,
        currentRank,
        change,
      };
    }
  });

  const currentSnapshots = rankedCandidates.map(
    (coin, index) => {
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
        rankScore: coin.rankScore,
        opportunityScore: coin.opportunityScore,
        entryScore: coin.entryScore,

        persistenceScore: coin.persistenceScore,

        price: coin.price,
        livePrice: coin.livePrice,

        live15m: coin.live15m || null,
        live1d: coin.live1d || null,

        stage: coin.stage,
        opportunityType: coin.opportunityType,
        tradeStatus: coin.tradeStatus,

        returns: coin.returns,
        volume: coin.volume,

        daily: coin.daily || null,
        dailyScore: coin.dailyScore,
        dailyMetrics: coin.dailyMetrics || null,
        timeframeScores: coin.timeframeScores || null,

        pricePersistence: coin.pricePersistence,
        volumePersistence: coin.volumePersistence,

        positivePriceSteps: coin.positivePriceSteps,
        positiveVolumeSteps: coin.positiveVolumeSteps,

        volumeDelta15m: coin.volumeDelta15m,
        volumeSameBucket: coin.volumeSameBucket,

        evidence: coin.evidence,
        warnings: coin.warnings,
      };
    }
  );

  state.history.push(...currentSnapshots);

  const historyCutoff =
    nowMs - HISTORY_RETENTION_DAYS * DAY_MS;

  state.history = state.history.filter((item) => {
    const timestamp = Date.parse(item.timestamp);

    return (
      Number.isFinite(timestamp) &&
      timestamp >= historyCutoff
    );
  });

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

  state.tradeStates = mergeTradeStates(
    state.tradeStates,
    options.tradeStates ?? options.signals,
    now
  );

  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporaryFile = `${DATA_FILE}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(
      {
        updatedAt: now,
        history: state.history,
        summaries: state.summaries,
        tradeStates: state.tradeStates,
      },
      null,
      2
    ),
    'utf8'
  );

  await fs.rename(temporaryFile, DATA_FILE);

  return {
    rankedCandidates,

    snapshotsSaved: currentSnapshots.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    tradeStateCount: Object.keys(state.tradeStates).length,

    rankChanges,
    tradeStates: state.tradeStates,
  };
    }
