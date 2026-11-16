
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

    const fifteenMinute = await getAnalysis(
      symbol,
      TIMEFRAMES.fifteenMinute
    );
    await sleep(120);

    const fiveMinute = await getAnalysis(
      symbol,
      TIMEFRAMES.fiveMinute
    );

    if (
      !weekly ||
      !daily ||
      !fourHour ||
      !oneHour ||
      !fifteenMinute ||
      !fiveMinute
    ) {
      return null;
    }

    // شناسایی نامزدهای انباشت بلندمدت
    const watch =
      weekly.gradualVolumeGrowth &&
      daily.gradualVolumeGrowth &&
      Math.abs(daily.priceChangePercent) < 3;

    const accumulationCandidate =
      watch &&
      weekly.volumeTrend === 'RISING' &&
      daily.volumeTrend === 'RISING' &&
      weekly.trendRatio >= 1.25 &&
      daily.trendRatio >= 1.25;

    // هشدار سریع لانگ
    const fastLongTrigger =
      fifteenMinute.volumeRatio >= 2 &&
      fiveMinute.volumeRatio >= 1.5 &&
      fifteenMinute.direction === 'BULLISH' &&
      fiveMinute.direction === 'BULLISH' &&
      fifteenMinute.closePosition >= 60 &&
      fiveMinute.closePosition >= 60 &&
      fifteenMinute.priceChangePercent <= 3 &&
      fiveMinute.priceChangePercent <= 2;

    // هشدار سریع شورت
    const fastShortTrigger =
      fifteenMinute.volumeRatio >= 2 &&
      fiveMinute.volumeRatio >= 1.5 &&
      fifteenMinute.direction === 'BEARISH' &&
      fiveMinute.direction === 'BEARISH' &&
      fifteenMinute.closePosition <= 40 &&
      fiveMinute.closePosition <= 40 &&
      fifteenMinute.priceChangePercent >= -3 &&
      fiveMinute.priceChangePercent >= -2;

    if (
      !accumulationCandidate &&
      !fastLongTrigger &&
      !fastShortTrigger
    ) {
      return null;
    }

    // تأیید حرکت در تایم‌فریم‌های ۴ و ۱ ساعته
    const longSetup =
      accumulationCandidate &&
      fourHour.volumeRatio >= 2 &&
      oneHour.volumeRatio >= 1.5 &&
      fourHour.direction === 'BULLISH' &&
      oneHour.direction === 'BULLISH' &&
      fourHour.closePosition >= 60 &&
      oneHour.closePosition >= 60 &&
      fourHour.priceChangePercent <= 8 &&
      oneHour.priceChangePercent <= 5;

    const shortSetup =
      accumulationCandidate &&
      fourHour.volumeRatio >= 2 &&
      oneHour.volumeRatio >= 1.5 &&
      fourHour.direction === 'BEARISH' &&
      oneHour.direction === 'BEARISH' &&
      fourHour.closePosition <= 40 &&
      oneHour.closePosition <= 40 &&
      fourHour.priceChangePercent >= -8 &&
      oneHour.priceChangePercent >= -5;

    let status = 'WATCH';
    let direction = 'UNCONFIRMED';

    if (longSetup) {
      status = 'PRE-PUMP LONG';
      direction = 'BULLISH';
    } else if (shortSetup) {
      status = 'PRE-PUMP SHORT';
      direction = 'BEARISH';
    } else if (fastLongTrigger) {
      status = 'FAST LONG WATCH';
      direction = 'BULLISH';
    } else if (fastShortTrigger) {
      status = 'FAST SHORT WATCH';
      direction = 'BEARISH';
    }

    // محاسبه امتیاز رشد تدریجی حجم
    const weeklyScore =
      Math.min(
        Math.max((weekly.trendRatio - 1) / 1.5, 0),
        1
      ) * 30;

    const dailyScore =
      Math.min(
        Math.max((daily.trendRatio - 1) / 1.5, 0),
        1
      ) * 30;

    // امتیاز آرامش قیمت
    const stabilityScore = Math.max(
      0,
      40 -
      Math.abs(daily.priceChangePercent) * 2 -
      Math.abs(fourHour.priceChangePercent) * 0.5 -
      Math.abs(oneHour.priceChangePercent)
    );

    const accumulationScore = Math.round(
      weeklyScore + dailyScore + stabilityScore
    );

    // خروجی نهایی هر ارز
    return {
      symbol,
      status,
      direction,
      accumulationScore,

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

      weeklyVolumeTrend: weekly.volumeTrend,
      dailyVolumeTrend: daily.volumeTrend,

      fourHourClosePosition: fourHour.closePosition,
      oneHourClosePosition: oneHour.closePosition
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
  console.log('Starting Gate.io multi-timeframe scan...');

  try {
    const tickers = await getMarketTickers();
    const selected = tickers.slice(0, TOP_SYMBOLS);

    console.log(`Found ${tickers.length} markets`);
    console.log(`Scanning ${selected.length} markets`);

    console.log(
      'Timeframes: 7D / 1D / 4H / 1H / 15M / 5M'
    );

    const results = await scanAllSymbols(
      selected.map(item => item.symbol)
    );

    // مرتب‌سازی بر اساس امتیاز
    results.sort(
      (a, b) => b.accumulationScore - a.accumulationScore
    );

    console.log('\n===== MARKET WATCHLIST =====');

    for (const item of results) {
      console.log({
        symbol: item.symbol,
        status: item.status,
        direction: item.direction,
        accumulationScore: item.accumulationScore,

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

        weeklyVolumeTrend: item.weeklyVolumeTrend,
        dailyVolumeTrend: item.dailyVolumeTrend
      });
    }

    console.log('\n===== SCAN SUMMARY =====');

    console.log(`Watchlist: ${results.length}`);

    console.log(
      `Pre-pump long: ${
        results.filter(
          x => x.status === 'PRE-PUMP LONG'
        ).length
      }`
    );

    console.log(
      `Pre-pump short: ${
        results.filter(
          x => x.status === 'PRE-PUMP SHORT'
        ).length
      }`
    );

    console.log(
      `Fast long watch: ${
        results.filter(
          x => x.status === 'FAST LONG WATCH'
        ).length
      }`
    );

    console.log(
      `Fast short watch: ${
        results.filter(
          x => x.status === 'FAST SHORT WATCH'
        ).length
      }`
    );

    console.log('Scan completed successfully.');

  } catch (error) {
    console.error('Scanner error:', error.message);
    process.exitCode = 1;
  }
}

await runScanner();
