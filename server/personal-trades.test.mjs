import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPersonalTrades, mergePersonalTrades, normalizePersonalTrade, personalTradeAverages } from './personal-trades.mjs';

test('personal trades use the account order side and volume-weighted prices', () => {
  const buy = normalizePersonalTrade({ id: 17, side: 'sell', order_side: 'buy', price: '2', amount: '3', created_at: '2026-05-25T05:20:41Z' });
  const sell = normalizePersonalTrade({ id: 18, side: 'buy', order_side: 'sell', price: '4', amount: '1', created_at: '2026-05-25T05:21:41Z' });
  assert.equal(buy.side, 'buy');
  assert.equal(sell.side, 'sell');
  assert.deepEqual(personalTradeAverages([buy, { ...buy, id: '19', price: 5, amount: 1 }, sell]), { buy: 2.75, sell: 4 });
  assert.equal(normalizePersonalTrade({ id: 20, side: 'buy', price: 2, amount: 1, created_at: '2026-05-25T05:20:41Z' }), null);
});

test('personal trade backfill deduplicates records at time-window boundaries', async () => {
  const from = 1_000_000, to = from + 80 * 86_400;
  const first = { id: 1, side: 'sell', order_side: 'buy', price: '1.1', amount: '2', created_at: new Date((from + 60) * 1000).toISOString() };
  const second = { id: 2, side: 'buy', order_side: 'sell', price: '1.2', amount: '3', created_at: new Date((from + 70 * 86_400) * 1000).toISOString() };
  const calls = [];
  const trades = await fetchPersonalTrades(from, to, async (query) => {
    calls.push(query);
    return [first, second];
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(trades.map((trade) => trade.id), ['prlusdt:1', 'prlusdt:2']);
});

test('migrated fills collapse while separate fills with the same numeric ID survive', () => {
  const old = { id: '41', time: 100, side: 'buy', price: 1.25, amount: 4 };
  const migrated = { ...old, id: 'pearlusdt:41' };
  const later = { ...old, id: 'pearlusdt:41', time: 200, price: 1.5 };
  assert.deepEqual(mergePersonalTrades([old], [migrated, later]).map((trade) => trade.id), ['pearlusdt:41', 'pearlusdt:41']);
  assert.deepEqual(mergePersonalTrades([old], [migrated, later]).map((trade) => trade.time), [100, 200]);
});
