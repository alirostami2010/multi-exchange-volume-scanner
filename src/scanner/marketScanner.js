import { getUsdtPerpetualSymbols, getKlines } from '../exchanges/bybit.js';
import { analyzeVolume } from './volumeScanner.js';

const INTERVAL = '1';
const CONCURRENCY = 5;
const SCAN_INTERVAL = 60_000;

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

      await sleep(100);
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
  console.log('\nStarting Binance market scan...');

  try {
    const symbols = await getUsdtPerpetualSymbols();

    console.log(`Found ${symbols.length} USDT contracts`);

    const signals = await scanAllSymbols(symbols);

    signals.sort(
      (a, b) => b.volumeRatio - a.volumeRatio
    );

    console.log('\n===== VOLUME ALERTS =====');

    for (const signal of signals.slice(0, 20)) {
      console.log({
        symbol: signal.symbol,
        volumeIncrease: signal.volumeIncreasePercent + '%',
        priceChange: signal.priceChangePercent + '%',
        buyPressure: signal.buyPressurePercent + '%',
        earlyWarning: signal.earlyWarning
      });
    }

    console.log(`Total alerts: ${signals.length}`);

  } catch (error) {
    console.error('Scanner error:', error.message);
  }
}

let scanning = false;

async function safeScan() {
  if (scanning) return;

  scanning = true;

  try {
    await runScanner();
  } finally {
    scanning = false;
  }
}

await safeScan();

setInterval(safeScan, SCAN_INTERVAL);
