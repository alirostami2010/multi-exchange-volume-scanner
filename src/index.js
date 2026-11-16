
import 'dotenv/config';

console.log('================================');
console.log(' MULTI-EXCHANGE VOLUME SCANNER');
console.log('================================');

console.log('Starting scanner...');

const exchanges = [
  'Binance',
  'Bybit',
  'OKX',
  'LBank',
  'Toobit'
];

for (const exchange of exchanges) {
  console.log(`Exchange configured: ${exchange}`);
}

console.log('Scanner initialization completed.');
