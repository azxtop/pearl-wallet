import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateWprlCandles, combineWprlCandles, normalizeWprlCandles, parseSwap, SWAP_TOPIC, WPRL_POOL } from './wprl.mjs';

const word = (value) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, '0');

test('Uniswap V3 Swap log gives WPRL/USDT price, amount and direction', () => {
  const sqrt = BigInt(Math.round(Math.sqrt(1.5 / 100) * 2 ** 96));
  const base = {
    address: WPRL_POOL, topics: [SWAP_TOPIC], transactionHash: '0xabc', logIndex: '0x2', blockNumber: '0x10',
  };
  const buy = parseSwap({ ...base, data: `0x${word(-100_000_000n)}${word(1_500_000n)}${word(sqrt)}${word(0n)}${word(0n)}` }, 1790490000);
  assert.equal(buy.side, 'buy');
  assert.equal(buy.amount, 1);
  assert.equal(buy.turnover, 1.5);
  assert.ok(Math.abs(buy.price - 1.5) < 1e-10);
  const sell = parseSwap({ ...base, data: `0x${word(200_000_000n)}${word(-3_000_000n)}${word(sqrt)}${word(0n)}${word(0n)}` }, 1790490000);
  assert.equal(sell.side, 'sell');
  assert.equal(sell.amount, 2);
  assert.equal(parseSwap({ ...base, address: '0x0000000000000000000000000000000000000000' }, 1790490000), null);
});

test('pool OHLCV keeps chronological 1-minute candles', () => {
  const payload = { data: { attributes: { ohlcv_list: [[120, 1.2, 1.3, 1.1, 1.25, 8], [60, 1, 1.2, 0.9, 1.2, 4]] } } };
  const rows = normalizeWprlCandles(payload, '1m');
  assert.deepEqual(rows.map((row) => row.time), [60, 120]);
  assert.equal(rows[1].close, 1.25);
});

test('minute candles can provide a usable hourly fallback during upstream rate limits', () => {
  const rows = [
    { time: 3600, open: 1, high: 1.3, low: 0.9, close: 1.2, volume: 2, empty: false },
    { time: 3660, open: 1.2, high: 1.4, low: 1.1, close: 1.3, volume: 3, empty: false },
    { time: 7200, open: 1.3, high: 1.5, low: 1.2, close: 1.4, volume: 4, empty: false },
  ];
  const result = aggregateWprlCandles(rows, '1h');
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { time: 3600, open: 1, high: 1.4, low: 0.9, close: 1.3, volume: 5, empty: false });
});

test('reference candles end before recording starts and never replace recorded candles', () => {
  const make = (time, close) => ({ time, open: close, high: close, low: close, volume: 1, close, empty: false });
  const merged = combineWprlCandles([make(6000, 1), make(6060, 2), make(6120, 3)], [make(6060, 4), make(6120, 5)], 6065, '1m');
  assert.equal(merged.source, 'mixed');
  assert.deepEqual(merged.candles.map((row) => [row.time, row.close]), [[6000, 1], [6060, 4], [6120, 5]]);
});
