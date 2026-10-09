import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTradeHistory } from './trade-history.mjs';

test('trade history deduplicates, filters and paginates within a market', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pearl-trades-'));
  const history = createTradeHistory(join(folder, 'trades.sqlite'), { now: () => 2_000_000_000_000 });
  const trade = (id, time, price, amount, side = 'buy') => ({ id, time, price, amount, side });
  try {
    history.add('lighter', '101', [trade('a', 2_000_000_000, 1.2, 10), trade('b', 2_000_000_001, 1.3, 20), trade('c', 2_000_000_001, 1.4, 30, 'sell')]);
    history.add('lighter', '101', [trade('b', 2_000_000_001, 1.3, 20)]);
    history.add('lighter', '102', [trade('x', 2_000_000_001, 2, 100)]);
    const first = history.query('lighter', '101', { limit: 2 });
    assert.deepEqual(first.trades.map((row) => row.id), ['c', 'b']);
    assert.equal(first.recordingSince, 2_000_000_000);
    assert.deepEqual(history.query('lighter', '101', { cursor: first.nextCursor }).trades.map((row) => row.id), ['a']);
    assert.deepEqual(history.query('lighter', '101', { from: '2000000001', minPrice: '1.25', maxPrice: '1.35', minAmount: '15', side: 'buy' }).trades.map((row) => row.id), ['b']);
    assert.throws(() => history.query('lighter', '101', { minPrice: '-1' }), /Invalid filter/);
  } finally { history.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('amount ordering paginates the entire filtered market without repeats', () => {
  const folder = mkdtempSync(join(tmpdir(), 'pearl-trades-sort-'));
  const history = createTradeHistory(join(folder, 'trades.sqlite'), { now: () => 2_000_000_000_000 });
  try {
    history.add('safetrade', 'PRL/USDT', [
      { id: 'a', time: 2_000_000_000, price: 1, amount: 1.01, side: 'buy' },
      { id: 'b', time: 2_000_000_001, price: 1, amount: 101, side: 'sell' },
      { id: 'c', time: 2_000_000_002, price: 1, amount: 101, side: 'buy' },
      { id: 'd', time: 2_000_000_003, price: 1, amount: 3, side: 'sell' },
    ]);
    const descending = history.query('safetrade', 'PRL/USDT', { sort: 'amount_desc', limit: 2 });
    assert.deepEqual(descending.trades.map((row) => row.id), ['c', 'b']);
    assert.deepEqual(history.query('safetrade', 'PRL/USDT', { sort: 'amount_desc', limit: 2, cursor: descending.nextCursor }).trades.map((row) => row.id), ['d', 'a']);
    const ascending = history.query('safetrade', 'PRL/USDT', { sort: 'amount_asc', limit: 2 });
    assert.deepEqual(ascending.trades.map((row) => row.id), ['a', 'd']);
    assert.deepEqual(history.query('safetrade', 'PRL/USDT', { sort: 'amount_asc', limit: 2, cursor: ascending.nextCursor }).trades.map((row) => row.id), ['b', 'c']);
    assert.deepEqual(history.query('safetrade', 'PRL/USDT', { sort: 'amount_desc', side: 'buy' }).trades.map((row) => row.id), ['c', 'a']);
    assert.throws(() => history.query('safetrade', 'PRL/USDT', { sort: 'amount_asc', cursor: descending.nextCursor }), /Invalid cursor/);
    assert.throws(() => history.query('safetrade', 'PRL/USDT', { sort: 'price_desc' }), /Invalid sort/);
  } finally { history.close(); rmSync(folder, { recursive: true, force: true }); }
});
