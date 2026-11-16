
import { getMarketTickers, getKlines } from '../exchanges/gateio.js';
import { analyzeVolume } from './volumeScanner.js';

const TOP_SYMBOLS = 60;
const CONCURRENCY = 4;

const TIMEFRAMES = {
  weekly: '7d',
  daily: '1d',
  fourHour: '4h',
  oneHour: '1h'
};

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getAnalysis(symbol, interval) {
  const candles = await getKlines(symbol, interval, 30);
  return analyzeVolume(candles);
}

async function scanSymbol(symbol) {
  try {
    // بررسی چهار تایم‌فریم
    const weekly = await getAnalysis(symbol, TIMEFRAMES.weekly);
    await sleep(120);

    const daily = await getAnalysis(symbol, TIMEFRAMES.daily);
    await sleep(120);

    const fourHour = await getAnalysis(symbol, TIMEFRAMES.fourHour);
    await sleep(120);

    const oneHour = await getAnalysis(symbol, TIMEFRAMES.oneHour);

    if (!weekly || !daily || !fourHour || !oneHour) {
      return null;
    }

    // شناسایی افزایش تدریجی حجم در بازه‌های بزرگ
    const watch =
      weekly.volumeRatio >= 1.5 &&
      daily.volumeRatio >= 1.3 &&
      Math.abs(daily.priceChangePercent) < 5;

    if (!watch) return null;

    // احتمال نزدیک شدن به حرکت صعودی
    const longSetup =
      fourHour.volumeRatio >= 2 &&
      oneHour.volumeRatio >= 1.5 &&
      fourHour.direction === 'BULLISH' &&
      oneHour.direction === 'BULLISH' &&
      fourHour.closePosition >= 60 &&
      oneHour.closePosition >= 60;

    // احتمال نزدیک شدن به حرکت نزولی
    const shortSetup =
      fourHour.volumeRatio >= 2 &&
      oneHour.volumeRatio >= 1.5 &&
      fourHour.direction === 'BEARISH' &&
      oneHour.direction === 'BEARISH' &&
      fourHour.closePosition <= 40 &&
      oneHour.closePosition <= 40;

    let status = 'WATCH';
    let direction = 'UNCONFIRMED';

    if (longSetup) {
      status = 'PRE-PUMP LONG';
      direction = 'BULLISH';
    } else if (shortSetup) {
      status = 'PRE-PUMP SHORT';
      direction = 'BEARISH';
    }

    return {
      symbol,
      status,
      direction,

      weeklyVolume: weekly.volumeRatio,
      dailyVolume: daily.volumeRatio,
      fourHourVolume: fourHour.volumeRatio,
      oneHourVolume: oneHour.volumeRatio,

      dailyChange: daily.priceChangePercent,
      fourHourChange: fourHour.priceChangePercent,
      oneHourChange: oneHour.priceChangePercent,

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

      if (result) results.push(result);

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
    console.log('Timeframes: 1H / 4H / 1D / 7D');

    const results = await scanAllSymbols(
      selected.map(item => item.symbol)
    );

    results.sort((a, b) => {
      if (a.status === 'PRE-PUMP LONG' &&
          b.status !== 'PRE-PUMP LONG') return -1;

      if (b.status === 'PRE-PUMP LONG' &&
          a.status !== 'PRE-PUMP LONG') return 1;

      return b.weeklyVolume - a.weeklyVolume;
    });

    console.log('\n===== MARKET WATCHLIST =====');

    for (const item of results) {
      console.log({
        symbol: item.symbol,
        status: item.status,
        direction: item.direction,
        weeklyVolume: item.weeklyVolume + 'x',
        dailyVolume: item.dailyVolume + 'x',
        fourHourVolume: item.fourHourVolume + 'x',
        oneHourVolume: item.oneHourVolume + 'x',
        dailyChange: item.dailyChange + '%',
        fourHourChange: item.fourHourChange + '%',
        oneHourChange: item.oneHourChange + '%'
      });
    }

    console.log('\n===== SCAN SUMMARY =====');
    console.log(`Watchlist: ${results.length}`);
    console.log(
      `Pre-pump long: ${
        results.filter(x => x.status === 'PRE-PUMP LONG').length
      }`
    );
    console.log(
      `Pre-pump short: ${
        results.filter(x => x.status === 'PRE-PUMP SHORT').length
      }`
    );

    console.log('Scan completed successfully.');

  } catch (error) {
    console.error('Scanner error:', error.message);
    process.exitCode = 1;
  }
}

await runScanner();
