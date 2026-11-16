
const LOOKBACK_CANDLES = 20;
const VOLUME_MULTIPLIER = 2;
const TREND_WINDOW = 5;

export function analyzeVolume(candles) {
  if (!Array.isArray(candles) ||
      candles.length < LOOKBACK_CANDLES + 1) {
    return null;
  }

  // حذف آخرین کندل که ممکن است هنوز بسته نشده باشد
  const closed = candles.slice(0, -1);
  const current = closed[closed.length - 1];

  // گردش مالی به‌جای تعداد قراردادها
  // ساختار استاندارد:
  // [time, open, high, low, close, volume, turnover]
  const turnover = candle => Number(candle[6]);

  const previous = closed.slice(
    -(LOOKBACK_CANDLES + 1),
    -1
  );

  const historicalValues = previous.map(turnover);

  if (historicalValues.some(
    value => !Number.isFinite(value) || value < 0
  )) {
    return null;
  }

  const averageTurnover =
    historicalValues.reduce((sum, value) => sum + value, 0) /
    historicalValues.length;

  const currentTurnover = turnover(current);

  if (!Number.isFinite(currentTurnover) ||
      averageTurnover <= 0) {
    return null;
  }

  // مقایسه میانگین پنج کندل اخیر با پنج کندل قبل‌تر
  const recent = closed.slice(-TREND_WINDOW);
  const older = closed.slice(
    -(TREND_WINDOW * 2),
    -TREND_WINDOW
  );

  if (recent.length < TREND_WINDOW ||
      older.length < TREND_WINDOW) {
    return null;
  }

  const recentValues = recent.map(turnover);
  const olderValues = older.map(turnover);

  const recentAverage =
    recentValues.reduce((a, b) => a + b, 0) /
    recentValues.length;

  const olderAverage =
    olderValues.reduce((a, b) => a + b, 0) /
    olderValues.length;

  const trendRatio = olderAverage > 0
    ? recentAverage / olderAverage
    : 0;

  let risingSteps = 0;

  for (let i = 1; i < recentValues.length; i++) {
    if (recentValues[i] > recentValues[i - 1]) {
      risingSteps++;
    }
  }

  const gradualVolumeGrowth =
    trendRatio >= 1.25 &&
    risingSteps >= 2;

  let volumeTrend = 'STABLE';

  if (gradualVolumeGrowth) {
    volumeTrend = 'RISING';
  } else if (trendRatio <= 0.8) {
    volumeTrend = 'FALLING';
  }

  const volumeRatio =
    currentTurnover / averageTurnover;

  const open = Number(current[1]);
  const high = Number(current[2]);
  const low = Number(current[3]);
  const close = Number(current[4]);

  if (![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || high < low || high <= 0) {
    return null;
  }

  const priceChange =
    ((close - open) / open) * 100;

  const candleRange = high - low;

  const bodyRatio = candleRange > 0
    ? Math.abs(close - open) / candleRange
    : 0;

  const closePosition = candleRange > 0
    ? ((close - low) / candleRange) * 100
    : 50;

  let direction = 'NEUTRAL';

  if (priceChange > 0) direction = 'BULLISH';
  if (priceChange < 0) direction = 'BEARISH';

  const volumeSpike =
    volumeRatio >= VOLUME_MULTIPLIER;

  const earlyWarning =
    volumeSpike && Math.abs(priceChange) < 0.5;

  const absorptionCandidate =
    volumeSpike &&
    bodyRatio <= 0.25 &&
    (candleRange / open) * 100 >= 0.05;

  return {
    volumeRatio: Number(volumeRatio.toFixed(2)),
    trendRatio: Number(trendRatio.toFixed(2)),
    risingSteps,
    volumeTrend,
    gradualVolumeGrowth,

    volumeIncreasePercent: Number(
      ((volumeRatio - 1) * 100).toFixed(2)
    ),

    priceChangePercent: Number(priceChange.toFixed(3)),
    bodyRatio: Number(bodyRatio.toFixed(2)),
    closePosition: Number(closePosition.toFixed(1)),

    direction,
    volumeSpike,
    earlyWarning,
    absorptionCandidate,

    buyPressurePercent: null
  };
}
