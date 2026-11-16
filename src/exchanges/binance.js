
const BASE_URL = 'https://fapi.binance.com';

async function request(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(
      `Binance API error: ${response.status}`
    );
  }

  return response.json();
}

// دریافت تمام قراردادهای دائمی USDT
export async function getUsdtPerpetualSymbols() {
  const data = await request('/fapi/v1/exchangeInfo');

  return data.symbols
    .filter(item =>
      item.quoteAsset === 'USDT' &&
      item.contractType === 'PERPETUAL' &&
      item.status === 'TRADING'
    )
    .map(item => item.symbol);
}

// دریافت آمار ۲۴ ساعته تمام بازارها
export async function get24hTickers() {
  const data = await request('/fapi/v1/ticker/24hr');

  return data.map(item => ({
    symbol: item.symbol,
    price: Number(item.lastPrice),
    changePercent: Number(item.priceChangePercent),
    quoteVolume: Number(item.quoteVolume),
    trades: Number(item.count)
  }));
}

// دریافت اطلاعات بازار و فیلتر قراردادهای موردنظر
export async function getMarketSnapshot() {
  const [symbols, tickers] = await Promise.all([
    getUsdtPerpetualSymbols(),
    get24hTickers()
  ]);

  const allowedSymbols = new Set(symbols);

  return tickers.filter(item =>
    allowedSymbols.has(item.symbol)
  );
}
