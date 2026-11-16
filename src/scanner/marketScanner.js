
import { getMarketTickers, getKlines } from '../exchanges/gateio.js';

const CANDLE_SECONDS = 4 * 60 * 60;
const CONCURRENCY = 6;
const TOP_RESULTS = 20;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const number = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

async function scanSymbol(ticker) {
  try {
    const candles = await getKlines(ticker.symbol, '4h', 6);

    if (!Array.isArray(candles)) return null;

    const now = Math.floor(Date.now() / 1000);

    // فقط کندل‌های کاملاً بسته‌شده
    const closed = candles
      .filter(c => Number(c[0]) + CANDLE_SECONDS <= now)
      .sort((a, b) => Number(a[0]) - Number(b[0]));

    if (closed.length < 2) return null;

    const current = closed[closed.length - 1];
    const previous = closed[closed.length - 2];

    // از مقایسه کندل‌هایی که بینشان فاصله افتاده خودداری کن
    if (
      Number(current[0]) - Number(previous[0]) !== CANDLE_SECONDS
    ) return null;

    const previousClose = number(previous[4]);
    const currentClose = number(current[4]);

    // حجم بر اساس ارزش معاملات به USDT
    const previousVolume = number(previous[6]);
    const currentVolume = number(current[6]);

    if (
      !previousClose ||
      !currentClose ||
      !previousVolume ||
      previousVolume <= 0 ||
      currentVolume === null ||
      currentVolume <= 0
    ) return null;

    const priceChange =
      ((currentClose - previousClose) / previousClose) * 100;

    const volumeRatio = currentVolume / previousVolume;

    const volumeChange =
      (volumeRatio - 1) * 100;

    // شرط اصلی: افزایش هم‌زمان قیمت و حجم
    if (priceChange <= 0 || volumeChange <= 0) {
      return null;
    }

    const turnover24h = number(ticker.turnover24h) || 0;

    // امتیاز اولویت؛ ترکیبی از رشد قیمت، رشد حجم و نقدشوندگی
    const liquidityFactor = clamp(
      Math.log10(turnover24h + 1) / 5,
      0.3,
      1.5
    );

    const priorityScore =
      Math.sqrt(priceChange * volumeChange) *
      liquidityFactor;

    return {
      symbol: ticker.symbol,
      price: currentClose,
      priceChange,
      volumeChange,
      volumeRatio,
      volume4h: currentVolume,
      turnover24h,
      priorityScore
    };

  } catch (error) {
    return {
      failed: true,
      symbol: ticker.symbol
    };
  }
}

async function runScanner() {
  console.log('\n==========================================');
  console.log('       GATE.IO 4H MARKET RADAR');
  console.log('==========================================');

  const tickers = await getMarketTickers();

  console.log(`Total markets to scan: ${tickers.length}`);
  console.log('Scanning ALL available USDT markets...\n');

  const results = [];
  let completed = 0;
  let failed = 0;

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tickers.length) {
      const index = nextIndex++;
      const ticker = tickers[index];

      const result = await scanSymbol(ticker);

      if (result?.failed) {
        failed++;
      } else if (result) {
        results.push(result);
      }

      completed++;

      if (completed % 50 === 0 || completed === tickers.length) {
        console.log(
          `Progress: ${completed}/${tickers.length} | Found: ${results.length}`
        );
      }

      await sleep(100);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, tickers.length) },
      () => worker()
    )
  );

  results.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }

    return b.turnover24h - a.turnover24h;
  });

  const top20 = results.slice(0, TOP_RESULTS);

  console.log('\n==========================================');
  console.log('          TOP 20 PRIORITY MARKETS');
  console.log('==========================================');

  if (top20.length === 0) {
    console.log('No markets matched the conditions.');
  }

  console.table(
    top20.map((item, index) => ({
      RANK: index + 1,
      SYMBOL: item.symbol,
      PRICE: item.price,
      'PRICE +4H %': `+${item.priceChange.toFixed(2)}%`,
      'VOLUME +4H %': `+${item.volumeChange.toFixed(2)}%`,
      'VOLUME RATIO': `${item.volumeRatio.toFixed(2)}x`,
      '4H VOLUME USDT': Math.round(item.volume4h),
      '24H TURNOVER': Math.round(item.turnover24h),
      PRIORITY: item.priorityScore.toFixed(2)
    }))
  );

  console.log('\n==========================================');
  console.log('SCAN SUMMARY');
  console.log('==========================================');
  console.log(`Markets scanned: ${completed}`);
  console.log(`Scan errors: ${failed}`);
  console.log(`Markets with rising price and volume: ${results.length}`);
  console.log(`Displayed: ${top20.length}`);
  console.log('==========================================\n');
}

runScanner().catch(error => {
  console.error('FATAL SCANNER ERROR:', error);
  process.exitCode = 1;
});
