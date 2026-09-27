import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCandle, normalizeDepth, normalizePublicTrades, normalizeTicker } from './safetrade-data.mjs';

test('normalizes SafeTrade public data without leaking raw fields', () => {
  assert.deepEqual(normalizeCandle([1790477220, '1.51', '1.54', '1.50', '1.52', '14.5']),
    { time: 1790477220, open: 1.51, high: 1.54, low: 1.5, close: 1.52, volume: 14.5, empty: false });
  assert.equal(normalizeCandle(['bad', 1, 1, 1, 1, 1]), null);
  assert.deepEqual(normalizeTicker({ last: '1.51', high: '1.54', low: '1.04', volume: '3', amount: '4', price_change_percent: '+39.81%' })?.stats24h.changePercent, 39.81);
  assert.deepEqual(normalizeDepth({ asks: [['1.5', '2']], bids: [['1.4', '3']] }).asks, [{ price: 1.5, amount: 2 }]);
  assert.deepEqual(normalizePublicTrades([{ id: 1, price: '1.5', amount: '2', side: 'buy', created_at: '2026-09-27T02:56:30Z' }])[0]?.side, 'buy');
});
