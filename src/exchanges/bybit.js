
const BASE_URL = 'https://api.bybit.com';

async function request(endpoint) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Bybit API error: ${response.status}`);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(`Bybit API error: ${data.retMsg}`);
  }

  return data.result;
}

// دریافت قراردادهای دائمی USDT
export async function getUsdtPerpetualSymbols() {
  let symbols = [];
  let cursor = '';

  do {
    const params = new URLSearchParams({
      category: 'linear',
      limit: '1000'
    });

    if (cursor) params.set('cursor', cursor);

    const result = await request(
      `/v5/market/instruments-info?${params}`
    );

    symbols.push(
      ...result.list
        .filter(item =>
          item.quoteCoin === 'USDT' &&
          item.contractType === 'LinearPerpetual' &&
          item.status === 'Trading'
        )
        .map(item => item.symbol)
    );

    cursor = result.nextPageCursor || '';
  } while (cursor);

  return symbols;
}

// دریافت کندل‌ها
export async function getKlines(
  symbol,
  interval = '1',
  limit = 30
) {
  const params = new URLSearchParams({
    category: 'linear',
    symbol,
    interval,
    limit: String(limit)
  });

  const result = await request(
    `/v5/market/kline?${params}`
  );

  // Bybit کندل‌ها را از جدید به قدیم می‌فرستد
  return result.list.reverse();
}

export async function getMarketTickers() {
  const result = await request(
    '/v5/market/tickers?category=linear'
  );

  return result.list
    .filter(item =>
      item.symbol.endsWith('USDT')
    )
    .map(item => ({
      symbol: item.symbol,
      price: Number(item.lastPrice),
      turnover24h: Number(item.turnover24h),
      change24h: Number(item.price24hPcnt) * 100
    }))
    .sort((a, b) =>
      b.turnover24h - a.turnover24h
    );
}
