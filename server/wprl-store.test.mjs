import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWprlStore } from './wprl-store.mjs';

const hash = (digit) => `0x${digit.repeat(64)}`;
const trade = (id, blockNumber, time, price, amount, logIndex = 0) => ({
  id, blockNumber, logIndex, time, price, amount, turnover: price * amount, side: 'buy',
});

test('recording starts at the next block and resumes from its durable cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-wprl-'));
  const path = join(dir, 'market.sqlite');
  try {
    let store = createWprlStore(path);
    assert.deepEqual(store.initialize(100, 6000), { startBlock: 101, cursor: 100, startTime: 6000, coveredTime: 6000 });
    assert.equal(store.live(trade('before', 100, 6001, 1, 1), hash('a')), false);
    store.reconcile(101, 104, [], 6050);
    assert.equal(store.state().cursor, 104);
    store.close();
    store = createWprlStore(path);
    assert.equal(store.initialize(900, 9999).startBlock, 101);
    assert.equal(store.state().cursor, 104);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('swaps produce base-volume candles, and scanned no-trade minutes are explicit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-wprl-'));
  const store = createWprlStore(join(dir, 'market.sqlite'));
  try {
    store.initialize(100, 6000);
    const first = trade('a', 101, 6061, 1.1, 2, 0);
    const second = trade('b', 101, 6068, 1.3, 3, 1);
    assert.equal(store.live(first, hash('a')), true);
    store.reconcile(101, 102, [{ trade: first, blockHash: hash('a') }, { trade: second, blockHash: hash('a') }], 6250);
    const rows = store.candles('1m');
    assert.equal(rows[0].time, 6060);
    assert.deepEqual([rows[0].open, rows[0].high, rows[0].low, rows[0].close, rows[0].volume, rows[0].empty], [1.1, 1.3, 1.1, 1.3, 5, false]);
    assert.equal(rows[1].volume, 0);
    assert.equal(rows[1].empty, true);
    assert.equal(rows.at(-1).time, 6240);
    assert.equal(store.recent(20).length, 2);
    store.reconcile(101, 102, [{ trade: first, blockHash: hash('a') }, { trade: second, blockHash: hash('a') }], 6250);
    assert.equal(store.candles('1m')[0].volume, 5);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical rescan replaces orphaned swaps and repairs affected candles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-wprl-'));
  const store = createWprlStore(join(dir, 'market.sqlite'));
  try {
    store.initialize(100, 6000);
    const orphan = trade('orphan', 101, 6061, 1.1, 2);
    store.reconcile(101, 101, [{ trade: orphan, blockHash: hash('a') }], 6070);
    assert.equal(store.remove('orphan', hash('b')), false);
    const canonical = trade('canonical', 101, 6062, 1.5, 4);
    store.reconcile(101, 101, [{ trade: canonical, blockHash: hash('b') }], 6072);
    assert.deepEqual(store.recent().map((row) => row.id), ['canonical']);
    assert.equal(store.candles('1m')[0].volume, 4);
    assert.equal(store.candles('1m')[0].close, 1.5);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pruning old swaps retains historical minute candles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-wprl-'));
  const store = createWprlStore(join(dir, 'market.sqlite'));
  try {
    store.initialize(100, 6000);
    store.reconcile(101, 200, [{ trade: trade('old', 101, 6061, 1.2, 2), blockHash: hash('a') }], 7000);
    assert.equal(store.prune(6061 + 31 * 86_400), 1);
    assert.equal(store.recent().length, 0);
    assert.equal(store.candles('1m')[0].close, 1.2);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('24-hour statistics switch to locally recorded data after a full day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-wprl-'));
  const store = createWprlStore(join(dir, 'market.sqlite'));
  try {
    store.initialize(100, 6000);
    const first = trade('first', 101, 6061, 1, 2);
    const last = trade('last', 102, 6000 + 86_400, 1.5, 4);
    store.reconcile(101, 101, [{ trade: first, blockHash: hash('a') }], 6080);
    assert.equal(store.stats24h(), null);
    store.reconcile(102, 102, [{ trade: last, blockHash: hash('b') }], 6000 + 86_410);
    const stats = store.stats24h();
    assert.equal(stats.volume, 6);
    assert.equal(stats.turnover, 8);
    assert.equal(stats.changePercent, 50);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
