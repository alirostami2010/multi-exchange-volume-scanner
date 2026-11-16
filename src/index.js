
import 'dotenv/config';

console.log('======================================');
console.log(' MULTI-EXCHANGE SMART VOLUME SCANNER');
console.log('======================================');

console.log('Starting market scanner...');
console.log('Exchange: Gate.io');
console.log('Market: USDT Perpetual Futures');
console.log('Timeframes: 1m');
console.log('Mode: Volume Spike Detection');

import './scanner/marketScanner.js';
