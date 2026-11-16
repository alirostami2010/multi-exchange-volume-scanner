
import { getMarketTickers, getKlines } from '../exchanges/bybit.js';
import { analyzeVolume } from './volumeScanner.js';

const INTERVAL = '1';
const TOP_SYMBOLS = 60;
const CONCURRENCY = 5;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

async function scanSymbol(symbol) {
  try {
    const candles = await getKlines(symbol, INTERVAL, 30);
    const result = analyzeVolume(candles);

    if (!result || !result.volumeSpike) return null;

    return {
      exchange: 'Bybit',
      symbol,
      ...result
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
  console.log('Starting Bybit market scan...');

  try {
    const tickers = await getMarketTickers();
    const selected = tickers.slice(0, TOP_SYMBOLS);

    console.log(`Found ${tickers.length} markets`);
    console.log(`Scanning top ${selected.length} by 24h turnover`);

    const signals = await scanAllSymbols(
      selected.map(item => item.symbol)
    );

    signals.sort(
      (a, b) => b.volumeRatio - a.volumeRatio
    );

    console.log('\n===== VOLUME ALERTS =====');

    for (const signal of signals) {
      console.log({
        symbol: signal.symbol,
        volumeIncrease: signal.volumeIncreasePercent + '%',
        priceChange: signal.priceChangePercent + '%',
        direction: signal.direction,
        earlyWarning: signal.earlyWarning
      });
    }

    console.log(`Total alerts: ${signals.length}`);
    console.log('Scan completed successfully.');

  } catch (error) {
    console.error('Scanner error:', error.message);
    process.exitCode = 1;
  }
}

await runScanner();
