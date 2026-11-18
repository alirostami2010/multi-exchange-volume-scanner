
/**
 * MARKET STORAGE — RANKING + TRADE STATE
 * --------------------------------------
 * History retention: 15 days
 * Summary retention: 30 days
 *
 * Ranking:
 * Base score + 15m + 1h + 4h + Daily + Persistence
 *
 * Trade state:
 * Persistent entry / exit signal lifecycle
 *
 * File: src/storage/marketStorage.js
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ========================
// CONFIG
// ========================

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'market-state.json');

const HISTORY_RETENTION_DAYS = 15;
const SUMMARY_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MOMENTUM_LOOKBACK_MS = 90 * 60 * 1000;

// ========================
// HELPERS
// ========================

const number = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const pctChange = (current, previous) => {
  if (!previous || previous <= 0) return 0;
  return ((current - previous) / previous) * 100;
};

function isObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

// ========================
// READ STATE
// ========================

async function readState() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);

    return {
      history: Array.isArray(data.history)
        ? data.history
        : [],

      summaries: isObject(data.summaries)
        ? data.summaries
        : {},

      // وضعیت چرخه سیگنال‌ها مستقل از تاریخچه است.
      tradeStates: isObject(data.tradeStates)
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

// ========================
// ATOMIC STATE WRITE
// ========================

async function writeState(state) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const temporaryFile = `${DATA_FILE}.tmp`;

  const payload = {
    updatedAt: new Date().toISOString(),

    history: Array.isArray(state.history)
      ? state.history
      : [],

    summaries: isObject(state.summaries)
      ? state.summaries
      : {},

    tradeStates: isObject(state.tradeStates)
      ? state.tradeStates
      : {},
  };

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(payload, null, 2),
    'utf8'
  );

  await fs.rename(temporaryFile, DATA_FILE);
}

// ========================
// TRADE STATE ACCESS
// ========================

/**
 * دریافت وضعیت ذخیره‌شده تمام ارزها.
 *
 * خروجی:
 * {
 *   BTC_USDT: { ... },
 *   ETH_USDT: { ... }
 * }
 */
export async function getTradeStates() {
  const state = await readState();

  return state.tradeStates;
}

/**
 * دریافت وضعیت یک ارز مشخص.
 */
export async function getTradeState(symbol) {
  if (!symbol) return null;

  const state = await readState();

  return state.tradeStates[symbol] || null;
}

/**
 * ثبت یا به‌روزرسانی وضعیت سیگنال‌ها.
 *
 * ورودی می‌تواند آرایه‌ای از وضعیت‌ها باشد:
 *
 * [
 *   {
 *     symbol: 'BTC_USDT',
 *     status: 'NEAR_ENTRY',
 *     ...
 *   }
 * ]
 *
 * یا یک آبجکت با کلید نمادها.
 *
 * اطلاعات قبلی با اطلاعات جدید ادغام می‌شوند.
 * فیلدهایی که ارسال نشده‌اند حذف نمی‌شوند.
 */
export async function saveTradeStates(updates) {
  if (!updates) {
    const state = await readState();
    return state.tradeStates;
  }

  const state = await readState();

  const entries = Array.isArray(updates)
    ? updates
    : isObject(updates)
      ? Object.entries(updates).map(([symbol, value]) => ({
          symbol,
          ...value,
        }))
      : [];

  const now = new Date().toISOString();

  for (const update of entries) {
    if (!isObject(update) || !update.symbol) {
      continue;
    }

    const symbol = update.symbol;

    const previous = state.tradeStates[symbol] || {};

    state.tradeStates[symbol] = {
      ...previous,
      ...update,

      symbol,

      createdAt:
        previous.createdAt ||
        update.createdAt ||
        now,

      updatedAt: now,
    };
  }

  await writeState(state);

  return state.tradeStates;
}

// ========================
// TRADE STATE MERGE
// ========================

function mergeTradeStateUpdates(
  previousStates,
  updates,
  now
) {
  const result = {
    ...previousStates,
  };

  if (!updates) {
    return result;
  }

  const entries = Array.isArray(updates)
    ? updates
    : isObject(updates)
      ? Object.entries(updates).map(([symbol, value]) => ({
          symbol,
          ...value,
        }))
      : [];

  for (const update of entries) {
    if (!isObject(update) || !update.symbol) {
      continue;
    }

    const symbol = update.symbol;
    const previous = result[symbol] || {};

    result[symbol] = {
      ...previous,
      ...update,

      symbol,

      createdAt:
        previous.createdAt ||
        update.createdAt ||
        now,

      updatedAt: now,
    };
  }

  return result;
}

// ========================
// OBSERVATION PRICE
// ========================

function getObservationPrice(item) {
  const livePrice = number(item.livePrice);

  if (livePrice > 0) return livePrice;

  return number(item.price);
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
    .sort((a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp)
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

  if (!bucketTime || currentTurnover <= 0) {
    const ratio = number(coin.volume?.['15m'], 1);

    return {
      score: Math.round(
        clamp(50 + (ratio - 1) * 20, 35, 75)
      ),
      delta: null,
      positiveSteps: 0,
      sameBucket: false,
    };
  }

  const sameBucketRecords = previousRecords
    .filter((item) => {
      return (
        number(item.live15m?.bucketTime) === bucketTime &&
        number(item.live15m?.turnover) > 0
      );
    })
    .sort((a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp)
    );

  if (!sameBucketRecords.length) {
    const ratio = number(coin.volume?.['15m'], 1);

    return {
      score: Math.round(
        clamp(50 + (ratio - 1) * 20, 35, 75)
      ),
      delta: null,
      positiveSteps: 0,
      sameBucket: false,
    };
  }

  const previous = sameBucketRecords[
    sameBucketRecords.length - 1
  ];

  const previousTurnover = number(
    previous.live15m?.turnover
  );

  const delta = currentTurnover - previousTurnover;

  const deltaRatio = previousTurnover > 0
    ? delta / previousTurnover
    : 0;

  let positiveSteps = 0;

  const turnoverSequence = [
    ...sameBucketRecords.map((item) =>
      number(item.live15m?.turnover)
    ),
    currentTurnover,
  ];

  for (
    let i = turnoverSequence.length - 1;
    i > 0;
    i--
  ) {
    if (
      turnoverSequence[i] >
      turnoverSequence[i - 1]
    ) {
      positiveSteps++;
    } else {
      break;
    }
  }

  let score = 50;

  if (delta > 0) {
    score += 12;
    score += clamp(deltaRatio * 20, 0, 15);
    score += Math.min(positiveSteps, 3) * 5;
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
// FOUR TIMEFRAME MOMENTUM
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

  const return15m = number(
    coin.returns?.['15m']
  );

  const return1h = number(
    coin.returns?.['1h']
  );

  const return4h = number(
    coin.returns?.['4h']
  );

  const daily = coin.daily || {};

  const score15m = clamp(
    50 + (return15m / 2) * 50,
    0,
    100
  );

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
   * Base Score       20%
   * 15m              20%
   * 1h               15%
   * 4h               10%
   * Daily            20%
   * Persistence      15%
   */

  const rankScore =
    baseScore * 0.20 +
    score15m * 0.20 +
    score1h * 0.15 +
    score4h * 0.10 +
    dailyScore * 0.20 +
    persistenceScore * 0.15;

  return {
    rankScore: Number(rankScore.toFixed(2)),

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
      '15m': Math.round(score15m),
      '1h': Math.round(score1h),
      '4h': Math.round(score4h),
      '1d': Math.round(dailyScore),
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
        (summary.highestPrice - summary.firstDiscoveryPrice) /
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
  summary.lastStage = coin.stage;
  summary.observations = number(summary.observations) + 1;

  return summary;
}

// ========================
// SAVE AND RANK
// ========================

/**
 * سازگاری با فراخوانی قبلی:
 *
 * saveMarketSnapshot(candidates)
 *
 * فراخوانی جدید:
 *
 * saveMarketSnapshot(candidates, {
 *   tradeStates: signalUpdates
 * })
 *
 * در صورت عدم ارسال tradeStates،
 * وضعیت‌های ذخیره‌شده قبلی حفظ می‌شوند.
 */
export async function saveMarketSnapshot(
  candidates,
  options = {}
) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const state = await readState();

  // ------------------------
  // RANKING
  // ------------------------

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
    .sort((a, b) => {
      if (b.rankScore !== a.rankScore) {
        return b.rankScore - a.rankScore;
      }

      if (
        b.persistenceScore !== a.persistenceScore
      ) {
        return b.persistenceScore - a.persistenceScore;
      }

      if (
        number(b.volume?.['15m']) !==
        number(a.volume?.['15m'])
      ) {
        return (
          number(b.volume?.['15m']) -
          number(a.volume?.['15m'])
        );
      }

      return number(b.score) - number(a.score);
    });

  // ------------------------
  // PREVIOUS RUN
  // ------------------------

  let previousRunTimestamp = null;

  for (const item of state.history) {
    if (
      item.timestamp &&
      (
        !previousRunTimestamp ||
        item.timestamp > previousRunTimestamp
      )
    ) {
      previousRunTimestamp = item.timestamp;
    }
  }

  const previousRanks = new Map();

  if (previousRunTimestamp) {
    for (const item of state.history) {
      if (item.timestamp === previousRunTimestamp) {
        previousRanks.set(item.symbol, item.rank);
      }
    }
  }

  // ------------------------
  // RANK CHANGES
  // ------------------------

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

      return;
    }

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
  });

  // ------------------------
  // CURRENT SNAPSHOTS
  // ------------------------

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
        persistenceScore: coin.persistenceScore,

        price: coin.price,
        livePrice: coin.livePrice,

        live15m: coin.live15m || null,
        live1d: coin.live1d || null,

        stage: coin.stage,
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

  // ------------------------
  // TRADE STATE UPDATES
  // ------------------------

  const tradeStateUpdates =
    options?.tradeStates ??
    options?.signals ??
    null;

  state.tradeStates = mergeTradeStateUpdates(
    state.tradeStates,
    tradeStateUpdates,
    now
  );

  // ------------------------
  // HISTORY CLEANUP
  // ------------------------

  const historyCutoff =
    nowMs - HISTORY_RETENTION_DAYS * DAY_MS;

  state.history = state.history.filter((item) => {
    const timestamp = Date.parse(item.timestamp);

    return (
      Number.isFinite(timestamp) &&
      timestamp >= historyCutoff
    );
  });

  // ------------------------
  // SUMMARY CLEANUP
  // ------------------------

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

  // ------------------------
  // ATOMIC SAVE
  // ------------------------

  await writeState(state);

  return {
    rankedCandidates,

    snapshotsSaved: currentSnapshots.length,
    historyCount: state.history.length,
    summaryCount: Object.keys(state.summaries).length,
    tradeStateCount: Object.keys(state.tradeStates).length,

    rankChanges,
  };
}
