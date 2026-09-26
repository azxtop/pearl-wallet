import assert from 'node:assert/strict';
import test from 'node:test';
import { candlesFromTrades, normalizeTrade } from './market.mjs';

test('builds one-minute OHLCV and marks minutes with no trade', () => {
  const trades = [
    { id: '2', ts: 125, price: 2, amount: 3 },
    { id: '1', ts: 121, price: 1, amount: 2 },
    { id: '3', ts: 175, price: 1.5, amount: 1 },
  ];
  const candles = candlesFromTrades(trades, 120, 240);
  assert.deepEqual(candles[0], { time: 120, open: 1, high: 2, low: 1, close: 1.5, volume: 6, trades: 3, empty: false });
  assert.equal(candles[1].empty, true);
  assert.equal(candles[1].volume, 0);
  assert.equal(candles[2].close, 1.5);
});

test('rejects trades without usable timestamps or prices', () => {
  assert.equal(normalizeTrade({ id: 'x', price: 0, amount: 1, created_at: 123 }), null);
  assert.equal(normalizeTrade({ id: 'x', price: 1, amount: 1, created_at: 'bad' }), null);
});

test('groups trades into selected chart intervals', () => {
  const trades = [
    { id: 'a', ts: 60, price: 1, amount: 2 },
    { id: 'b', ts: 180, price: 1.2, amount: 3 },
    { id: 'c', ts: 320, price: 1.1, amount: 4 },
  ];
  const candles = candlesFromTrades(trades, 0, 600, null, 300);
  assert.equal(candles[0].open, 1);
  assert.equal(candles[0].close, 1.2);
  assert.equal(candles[0].volume, 5);
  assert.equal(candles[1].open, 1.1);
  assert.equal(candles[2].empty, true);
});
