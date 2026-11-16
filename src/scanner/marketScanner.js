
import { getMarketTickers, getKlines } from '../exchanges/gateio.js';
import { analyzeVolume } from './volumeScanner.js';

const TOP_SYMBOLS = 150;
const TOP_EARLY = 20;
const TOP_MOMENTUM = 20;
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
    // 1. EARLY ACCUMULATION SCORE
    // =====================================

    const earlyPriceStable =
      Math.abs(daily.priceChangePercent) <= 3 &&
      Math.abs(fourHour.priceChangePercent) <= 5;

    const earlyVolumeGrowing =
      weekly.trendRatio >= 1.15 &&
      daily.trendRatio >= 1.15;

    const earlyIntradayActivity =
      fourHour.trendRatio >= 1.10 ||
      oneHour.trendRatio >= 1.10;

    const earlyVolumeScore =
      clamp((weekly.trendRatio - 1) / 1.5, 0, 1) * 30 +
      clamp((daily.trendRatio - 1) / 1.5, 0, 1) * 30;

    const earlyIntradayScore =
      clamp((fourHour.trendRatio - 1) / 1.5, 0, 1) * 10 +
      clamp((oneHour.trendRatio - 1) / 1.5, 0, 1) * 10;

    const stabilityScore = clamp(
      20 -
      Math.abs(daily.priceChangePercent) * 2 -
      Math.abs(fourHour.priceChangePercent),
      0,
      20
    );

    const earlyScore = Math.round(
      earlyVolumeScore +
      earlyIntradayScore +
      stabilityScore
    );

    const earlyAccumulation =
      earlyPriceStable &&
      earlyVolumeGrowing &&
      earlyIntradayActivity;

    // =====================================
    // 2. MOMENTUM SCORE
    // =====================================

    const momentumVolumeScore =
      clamp((fifteenMinute.volumeRatio - 1) / 3, 0, 1) * 30 +
      clamp((fiveMinute.volumeRatio - 1) / 2, 0, 1) * 25;

    const momentumTrendScore =
      clamp((fourHour.volumeRatio - 1) / 2, 0, 1) * 15 +
      clamp((oneHour.volumeRatio - 1) / 2, 0, 1) * 15;

    const momentumDirectionScore =
      (
        (fifteenMinute.direction === 'BULLISH' &&
         fiveMinute.direction === 'BULLISH') ||
        (fifteenMinute.direction === 'BEARISH' &&
         fiveMinute.direction === 'BEARISH')
      ) ? 15 : 0;

    const momentumScore = Math.round(
      momentumVolumeScore +
      momentumTrendScore +
      momentumDirectionScore
    );

    // =====================================
    // 3. MOMENTUM DIRECTION
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

    // =====================================
    // 4. EARLY DIRECTION
    // =====================================

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

    if (earlyAccumulation && (momentumLong || momentumShort)) {
      status = 'EARLY + MOMENTUM';
    } else if (earlyAccumulation) {
      status = 'EARLY ACCUMULATION';
    } else if (momentumLong) {
      status = 'MOMENTUM LONG';
    } else if (momentumShort) {
      status = 'MOMENTUM SHORT';
    }

    // =====================================
    // 5. RETURN ALL ANALYZED SYMBOLS
    // =====================================

    return {
      symbol,
      status,

      earlyAccumulation,
      earlyPriceStable,
      earlyVolumeGrowing,
      earlyIntradayActivity,
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

    const results = await scanAllSymbols(
      selected.map(item => item.symbol)
    );

    // =====================================
    // 6. FILTER COUNTERS
    // =====================================

    console.log('\n===== FILTER DIAGNOSTICS =====');

    console.log(`Analyzed: ${results.length}`);

    console.log(
      `Early stable price: ${
        results.filter(x => x.earlyPriceStable).length
      }`
    );

    console.log(
      `Early volume growing: ${
        results.filter(x => x.earlyVolumeGrowing).length
      }`
    );

    console.log(
      `Early intraday activity: ${
        results.filter(x => x.earlyIntradayActivity).length
      }`
    );

    console.log(
      `Early accumulation confirmed: ${
        results.filter(x => x.earlyAccumulation).length
      }`
    );

    console.log(
      `Momentum long confirmed: ${
        results.filter(x => x.momentumLong).length
      }`
    );

    console.log(
      `Momentum short confirmed: ${
        results.filter(x => x.momentumShort).length
      }`
    );

    // =====================================
    // 7. TOP 20 EARLY ACCUMULATION
    // =====================================

    const earlyTop = [...results]
      .sort((a, b) => b.earlyScore - a.earlyScore)
      .slice(0, TOP_EARLY);

    console.log('\n===== TOP 20 EARLY ACCUMULATION =====');

    for (const item of earlyTop) {
      console.log({
        symbol: item.symbol,
        score: item.earlyScore,
        confirmed: item.earlyAccumulation,
        direction: item.earlyDirection,
        weeklyTrend: item.weeklyTrend + 'x',
        dailyTrend: item.dailyTrend + 'x',
        fourHourTrend: item.fourHourTrend + 'x',
        dailyChange: item.dailyChange + '%',
        fourHourChange: item.fourHourChange + '%'
      });
    }

    // =====================================
    // 8. TOP 20 MOMENTUM
    // =====================================

    const momentumTop = [...results]
      .sort((a, b) => b.momentumScore - a.momentumScore)
      .slice(0, TOP_MOMENTUM);

    console.log('\n===== TOP 20 MOMENTUM =====');

    for (const item of momentumTop) {
      console.log({
        symbol: item.symbol,
        score: item.momentumScore,
        longConfirmed: item.momentumLong,
        shortConfirmed: item.momentumShort,
        direction: item.momentumDirection,
        fourHourVolume: item.fourHourVolume + 'x',
        oneHourVolume: item.oneHourVolume + 'x',
        fifteenMinuteVolume: item.fifteenMinuteVolume + 'x',
        fiveMinuteVolume: item.fiveMinuteVolume + 'x',
        fifteenMinuteChange: item.fifteenMinuteChange + '%',
        fiveMinuteChange: item.fiveMinuteChange + '%'
      });
    }

    console.log('\n===== SCAN SUMMARY =====');
    console.log(`Analyzed: ${results.length}`);
    console.log(`Early list: ${earlyTop.length}`);
    console.log(`Momentum list: ${momentumTop.length}`);
    console.log('Scan completed successfully.');

  } catch (error) {
    console.error('Scanner error:', error.message);
    process.exitCode = 1;
  }
}

await runScanner();
