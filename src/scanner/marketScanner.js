
import { getMarketTickers, getKlines } from '../exchanges/gateio.js';
import { analyzeVolume } from './volumeScanner.js';

const TOP_SYMBOLS = 150;
const CONCURRENCY = 4;

const TIMEFRAMES = {
  weekly: '7d',
  daily: '1d',
  fourHour: '4h',
  oneHour: '1h',
  fifteenMinute: '15m',
  fiveMinute: '5m'
};

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const clamp = (value, min, max) =>
  Math.min(Math.max(value, min), max);

async function getAnalysis(symbol, interval) {
  const candles = await getKlines(symbol, interval, 30);
  return analyzeVolume(candles);
}

async function scanSymbol(symbol) {
  try {
    const weekly = await getAnalysis(symbol, TIMEFRAMES.weekly);
    await sleep(120);

    const daily = await getAnalysis(symbol, TIMEFRAMES.daily);
    await sleep(120);

    const fourHour = await getAnalysis(symbol, TIMEFRAMES.fourHour);
    await sleep(120);

    const oneHour = await getAnalysis(symbol, TIMEFRAMES.oneHour);
    await sleep(120);

    const fifteenMinute = await getAnalysis(symbol, TIMEFRAMES.fifteenMinute);
    await sleep(120);

    const fiveMinute = await getAnalysis(symbol, TIMEFRAMES.fiveMinute);

    if (!weekly || !daily || !fourHour || !oneHour ||
        !fifteenMinute || !fiveMinute) {
      return null;
    }

    // =====================================
    // 1. EARLY ACCUMULATION
    // =====================================

    const earlyPriceStable =
      Math.abs(daily.priceChangePercent) <= 3 &&
      Math.abs(fourHour.priceChangePercent) <= 5;

    const earlyVolumeGrowing =
      weekly.trendRatio >= 1.15 &&
      daily.trendRatio >= 1.15 &&
      weekly.volumeTrend === 'RISING' &&
      daily.volumeTrend === 'RISING';

    const earlyIntradayActivity =
      fourHour.trendRatio >= 1.10 ||
      oneHour.trendRatio >= 1.10;

    const earlyAccumulation =
      earlyPriceStable &&
      earlyVolumeGrowing &&
      earlyIntradayActivity;

    const weeklyScore =
      clamp((weekly.trendRatio - 1) / 1.5, 0, 1) * 30;

    const dailyScore =
      clamp((daily.trendRatio - 1) / 1.5, 0, 1) * 30;

    const intradayScore =
      clamp(
        ((fourHour.trendRatio + oneHour.trendRatio) / 2 - 1) / 1.5,
        0,
        1
      ) * 20;

    const stabilityScore = clamp(
      20 -
      Math.abs(daily.priceChangePercent) * 2 -
      Math.abs(fourHour.priceChangePercent),
      0,
      20
    );

    const earlyScore = Math.round(
      weeklyScore + dailyScore +
      intradayScore + stabilityScore
    );

    // =====================================
    // 2. MOMENTUM ALERT
    // =====================================

    const momentumLong =
      fourHour.direction === 'BULLISH' &&
      oneHour.direction === 'BULLISH' &&
      fifteenMinute.direction === 'BULLISH' &&
      fiveMinute.direction === 'BULLISH' &&
      fourHour.volumeRatio >= 1.5 &&
      oneHour.volumeRatio >= 1.5 &&
      fifteenMinute.volumeRatio >= 2 &&
      fiveMinute.volumeRatio >= 1.5 &&
      fifteenMinute.closePosition >= 60 &&
      fiveMinute.closePosition >= 60;

    const momentumShort =
      fourHour.direction === 'BEARISH' &&
      oneHour.direction === 'BEARISH' &&
      fifteenMinute.direction === 'BEARISH' &&
      fiveMinute.direction === 'BEARISH' &&
      fourHour.volumeRatio >= 1.5 &&
      oneHour.volumeRatio >= 1.5 &&
      fifteenMinute.volumeRatio >= 2 &&
      fiveMinute.volumeRatio >= 1.5 &&
      fifteenMinute.closePosition <= 40 &&
      fiveMinute.closePosition <= 40;

    const momentumVolumeScore =
      clamp((fifteenMinute.volumeRatio - 1) / 3, 0, 1) * 35 +
      clamp((fiveMinute.volumeRatio - 1) / 2, 0, 1) * 25;

    const momentumTrendScore =
      clamp((fourHour.volumeRatio - 1) / 2, 0, 1) * 20 +
      clamp((oneHour.volumeRatio - 1) / 2, 0, 1) * 20;

    const momentumScore = Math.round(
      momentumVolumeScore + momentumTrendScore
    );

    // =====================================
    // 3. FILTER AND STATUS
    // =====================================

    const hasEarlySignal = earlyAccumulation && earlyScore >= 35;
    const hasMomentumSignal = momentumLong || momentumShort;

    if (!hasEarlySignal && !hasMomentumSignal) {
      return null;
    }

    let earlyDirection = 'UNCONFIRMED';

    if (
      fourHour.direction === 'BULLISH' &&
      oneHour.direction === 'BULLISH'
    ) {
      earlyDirection = 'BULLISH';
    } else if (
      fourHour.direction === 'BEARISH' &&
      oneHour.direction === 'BEARISH'
    ) {
      earlyDirection = 'BEARISH';
    }

    let momentumDirection = 'NONE';

    if (momentumLong) {
      momentumDirection = 'BULLISH';
    } else if (momentumShort) {
      momentumDirection = 'BEARISH';
    }

    let status = 'WATCH';

    if (hasEarlySignal && hasMomentumSignal) {
      status = 'EARLY + MOMENTUM';
    } else if (hasEarlySignal) {
      status = 'EARLY ACCUMULATION';
    } else if (momentumLong) {
      status = 'MOMENTUM LONG';
    } else if (momentumShort) {
      status = 'MOMENTUM SHORT';
    }

    // =====================================
    // 4. FINAL RESULT
    // =====================================

    return {
      symbol,
      status,

      earlyAccumulation,
      earlyScore,
      earlyDirection,

      momentumLong,
      momentumShort,
      momentumScore,
      momentumDirection,

      weeklyVolume: weekly.volumeRatio,
      dailyVolume: daily.volumeRatio,
      fourHourVolume: fourHour.volumeRatio,
      oneHourVolume: oneHour.volumeRatio,
      fifteenMinuteVolume: fifteenMinute.volumeRatio,
      fiveMinuteVolume: fiveMinute.volumeRatio,

      dailyChange: daily.priceChangePercent,
      fourHourChange: fourHour.priceChangePercent,
      oneHourChange: oneHour.priceChangePercent,
      fifteenMinuteChange: fifteenMinute.priceChangePercent,
      fiveMinuteChange: fiveMinute.priceChangePercent,

      weeklyTrend: weekly.trendRatio,
      dailyTrend: daily.trendRatio,
      fourHourTrend: fourHour.trendRatio,
      oneHourTrend: oneHour.trendRatio,

      weeklyVolumeTrend: weekly.volumeTrend,
      dailyVolumeTrend: daily.volumeTrend
    };

  } catch (error) {
    console.error(`${symbol}: ${error.message}`);
    return null;
  }
}

async function scanAllSymbols(symbols) {
  const results = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < symbols.length) {
      const index = nextIndex++;
      const result = await scanSymbol(symbols[index]);

      if (result) {
        results.push(result);
      }

      await sleep(150);
    }
  }

  await Promise.all(
    Array.from(
      { length: CONCURRENCY },
      () => worker()
    )
  );

  return results;
}

async function runScanner() {
  console.log('Starting Gate.io dual-signal scanner...');

  try {
    const tickers = await getMarketTickers();
    const selected = tickers.slice(0, TOP_SYMBOLS);

    console.log(`Found ${tickers.length} markets`);
    console.log(`Scanning ${selected.length} markets`);
    console.log('Timeframes: 7D / 1D / 4H / 1H / 15M / 5M');
    console.log('Modes: EARLY ACCUMULATION + MOMENTUM');

    const results = await scanAllSymbols(
      selected.map(item => item.symbol)
    );

    results.sort((a, b) =>
      Math.max(b.earlyScore, b.momentumScore) -
      Math.max(a.earlyScore, a.momentumScore)
    );

    console.log('\n===== DUAL SIGNAL WATCHLIST =====');

    for (const item of results) {
      console.log({
        symbol: item.symbol,
        status: item.status,

        earlyScore: item.earlyScore,
        earlyDirection: item.earlyDirection,

        momentumScore: item.momentumScore,
        momentumDirection: item.momentumDirection,

        weeklyVolume: item.weeklyVolume + 'x',
        dailyVolume: item.dailyVolume + 'x',
        fourHourVolume: item.fourHourVolume + 'x',
        oneHourVolume: item.oneHourVolume + 'x',
        fifteenMinuteVolume: item.fifteenMinuteVolume + 'x',
        fiveMinuteVolume: item.fiveMinuteVolume + 'x',

        dailyChange: item.dailyChange + '%',
        fourHourChange: item.fourHourChange + '%',
        oneHourChange: item.oneHourChange + '%',
        fifteenMinuteChange: item.fifteenMinuteChange + '%',
        fiveMinuteChange: item.fiveMinuteChange + '%',

        weeklyTrend: item.weeklyTrend + 'x',
        dailyTrend: item.dailyTrend + 'x',
        fourHourTrend: item.fourHourTrend + 'x',
        oneHourTrend: item.oneHourTrend + 'x'
      });
    }

    console.log('\n===== SCAN SUMMARY =====');

    console.log(`Total signals: ${results.length}`);

    console.log(
      `Early accumulation: ${
        results.filter(x => x.earlyAccumulation).length
      }`
    );

    console.log(
      `Momentum long: ${
        results.filter(x => x.momentumLong).length
      }`
    );

    console.log(
      `Momentum short: ${
        results.filter(x => x.momentumShort).length
      }`
    );

    console.log('Scan completed successfully.');

  } catch (error) {
    console.error('Scanner error:', error.message);
    process.exitCode = 1;
  }
}

await runScanner();
