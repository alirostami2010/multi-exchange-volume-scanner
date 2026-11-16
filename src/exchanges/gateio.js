
const BASE_URL = 'https://api.gateio.ws/api/v4';

async function request(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Gate.io API error: ${response.status}`);
  }

  return response.json();
}

// دریافت قراردادهای دائمی USDT
export async function getUsdtPerpetualSymbols() {
  const contracts = await request('/futures/usdt/contracts');

  return contracts
    .filter(item =>
      item.in_delisting === false &&
      item.name.endsWith('_USDT')
    )
    .map(item => item.name);
}

// دریافت اطلاعات بازار
export async function getMarketTickers() {
  const tickers = await request('/futures/usdt/tickers');

  return tickers
    .filter(item => item.contract.endsWith('_USDT'))
    .map(item => ({
      symbol: item.contract,
      price: Number(item.last),
      turnover24h: Number(item.volume_24h_quote),
      change24h: Number(item.change_percentage)
    }))
    .sort((a, b) =>
      b.turnover24h - a.turnover24h
    );
}

// دریافت کندل‌ها
export async function getKlines(
  symbol,
  interval = '1m',
  limit = 30
) {
  const params = new URLSearchParams({
    contract: symbol,
    interval,
    limit: String(limit)
  });

  const candles = await request(
    `/futures/usdt/candlesticks?${params}`
  );

  // تبدیل داده‌های Gate.io به ساختار استاندارد
  return candles.map(candle => [
    candle.t,
    candle.o,
    candle.h,
    candle.l,
    candle.c,
    candle.v,
    candle.sum
  ]);
}
