import assert from 'node:assert/strict';
import test from 'node:test';
import { candlesFromTrades, normalizeTrade, stats24h } from './market.mjs';

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

test('measures the 24h change against the last trade before the window', () => {
  // Low-volume pair: only two trades in the last 24h, minutes apart. The change
  // must span the full day (vs the last trade before the window), not minutes
  // (vs the first trade inside the window).
  const trades = [
    { id: 'a', ts: 100_000, price: 1.0, amount: 2 },
    { id: 'b', ts: 100_600, price: 1.5, amount: 4 },
  ];
  const stats = stats24h(trades, 1.2);
  assert.equal(stats.high, 1.5);
  assert.equal(stats.low, 1.0);
  assert.equal(stats.volume, 6);
  assert.equal(stats.turnover, 2 * 1.0 + 4 * 1.5);
  assert.equal(stats.changePercent, (1.5 / 1.2 - 1) * 100);
});

test('returns null change and stats when there are no trades', () => {
  const stats = stats24h([], null);
  assert.equal(stats.high, null);
  assert.equal(stats.low, null);
  assert.equal(stats.volume, 0);
  assert.equal(stats.changePercent, null);
  assert.equal(stats24h([{ id: 'a', ts: 1, price: 2, amount: 1 }], null).changePercent, null);
});
