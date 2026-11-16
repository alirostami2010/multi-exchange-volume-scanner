
const VOLUME_MULTIPLIER = 2;
const LOOKBACK_CANDLES = 20;

export function analyzeVolume(candles) {
  if (!Array.isArray(candles) ||
      candles.length < LOOKBACK_CANDLES + 1) {
    return null;
  }

  // کندل‌های بسته‌شده؛ آخرین کندل زنده حذف می‌شود
  const closed = candles.slice(0, -1);

  const current = closed[closed.length - 1];

  const previous = closed.slice(
    -(LOOKBACK_CANDLES + 1),
    -1
  );

  const volumes = previous.map(candle =>
    Number(candle[5])
  );

  const averageVolume =
    volumes.reduce((sum, value) => sum + value, 0) /
    volumes.length;

  const currentVolume = Number(current[5]);

  const volumeRatio = averageVolume > 0
    ? currentVolume / averageVolume
    : 0;

  const openPrice = Number(current[1]);
  const closePrice = Number(current[4]);

  const priceChange = openPrice > 0
    ? ((closePrice - openPrice) / openPrice) * 100
    : 0;

  const takerBuyVolume = Number(current[10]);

  const buyPressure = currentVolume > 0
    ? (takerBuyVolume / currentVolume) * 100
    : 0;

  let direction = 'UNKNOWN';

  if (priceChange > 0) direction = 'BULLISH';
  if (priceChange < 0) direction = 'BEARISH';

  return {
    volumeRatio: Number(volumeRatio.toFixed(2)),
    volumeIncreasePercent: Number(
      ((volumeRatio - 1) * 100).toFixed(2)
    ),
    priceChangePercent: Number(
      priceChange.toFixed(3)
    ),
    buyPressurePercent: Number(
      buyPressure.toFixed(2)
    ),
    direction,
    volumeSpike: volumeRatio >= VOLUME_MULTIPLIER,
    earlyWarning:
      volumeRatio >= VOLUME_MULTIPLIER &&
      Math.abs(priceChange) < 0.5
  };
}
