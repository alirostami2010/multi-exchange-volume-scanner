
const VOLUME_MULTIPLIER = 2;
const LOOKBACK_CANDLES = 20;
const EARLY_WARNING_MAX_CHANGE = 0.5;

export function analyzeVolume(candles) {
  if (!Array.isArray(candles) ||
      candles.length < LOOKBACK_CANDLES + 2) {
    return null;
  }

  // Gate.io candles are sorted oldest to newest.
  // Remove the latest, potentially unfinished candle.
  const closed = candles.slice(0, -1);

  const current = closed[closed.length - 1];

  const previous = closed.slice(
    -(LOOKBACK_CANDLES + 1),
    -1
  );

  // Standard format:
  // [time, open, high, low, close, volume, turnover]

  const volumes = previous.map(candle =>
    Number(candle[5])
  );

  if (volumes.some(v => !Number.isFinite(v) || v < 0)) {
    return null;
  }

  const averageVolume =
    volumes.reduce((sum, value) => sum + value, 0) /
    volumes.length;

  const currentVolume = Number(current[5]);

  if (!Number.isFinite(currentVolume) ||
      averageVolume <= 0) {
    return null;
  }

  const open = Number(current[1]);
  const high = Number(current[2]);
  const low = Number(current[3]);
  const close = Number(current[4]);

  if (![open, high, low, close].every(Number.isFinite) ||
      open <= 0 || high < low || high <= 0) {
    return null;
  }

  const volumeRatio = currentVolume / averageVolume;

  const priceChange = ((close - open) / open) * 100;

  const candleRange = high - low;

  const rangePercent =
    (candleRange / open) * 100;

  const bodySize = Math.abs(close - open);

  const bodyRatio = candleRange > 0
    ? bodySize / candleRange
    : 0;

  // Position of close inside candle range: 0 to 100
  const closePosition = candleRange > 0
    ? ((close - low) / candleRange) * 100
    : 50;

  let direction = 'NEUTRAL';

  if (priceChange > 0) direction = 'BULLISH';
  if (priceChange < 0) direction = 'BEARISH';

  const volumeSpike =
    volumeRatio >= VOLUME_MULTIPLIER;

  const earlyWarning =
    volumeSpike &&
    Math.abs(priceChange) < EARLY_WARNING_MAX_CHANGE;

  // Possible absorption pattern, not confirmed order flow.
  const absorptionCandidate =
    volumeSpike &&
    bodyRatio <= 0.25 &&
    rangePercent >= 0.05;

  let signalStrength = 'LOW';

  if (volumeRatio >= 3) signalStrength = 'MEDIUM';
  if (volumeRatio >= 5) signalStrength = 'HIGH';

  return {
    volumeRatio: Number(volumeRatio.toFixed(2)),

    volumeIncreasePercent: Number(
      ((volumeRatio - 1) * 100).toFixed(2)
    ),

    priceChangePercent: Number(
      priceChange.toFixed(3)
    ),

    candleRangePercent: Number(
      rangePercent.toFixed(3)
    ),

    bodyRatio: Number(
      bodyRatio.toFixed(2)
    ),

    closePosition: Number(
      closePosition.toFixed(1)
    ),

    buyPressurePercent: null,

    direction,
    signalStrength,
    volumeSpike,
    earlyWarning,
    absorptionCandidate
  };
}
