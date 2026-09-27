import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createHyperliquidFeed, normalizeHlCandle } from './hyperliquid.mjs';
import { createHyperliquidFanout } from './hyperliquid-fanout.mjs';

test('normalizes Hyperliquid minute candles and rejects bad numbers', () => {
  assert.deepEqual(normalizeHlCandle({ t: 120000, o: '2', h: '3', l: '1', c: '2.5', v: '4' }),
    { time: 120, open: 2, high: 3, low: 1, close: 2.5, volume: 4, empty: false });
  assert.equal(normalizeHlCandle({ t: 120000, o: 'NaN', h: '3', l: '1', c: '2', v: '4' }), null);
});

test('records one-minute candles and derives higher intervals across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-hl-'));
  const path = join(dir, 'hl.sqlite');
  const base = 1_800_000_000_000;
  const rows = [
    { t: base, o: '10', h: '12', l: '9', c: '11', v: '2' },
    { t: base + 60_000, o: '11', h: '13', l: '10', c: '12', v: '3' },
  ];
  const fetcher = async () => ({ ok: true, json: async () => rows });
  try {
    const feed = createHyperliquidFeed({ storePath: path, fetcher, now: () => base + 120_000 });
    await feed.backfill();
    const minutes = feed.getCandles('1m');
    assert.equal(minutes.candles.length, 2);
    assert.equal(minutes.candles[1].close, 12);
    const five = feed.getCandles('5m').candles;
    assert.equal(five.length, 1);
    assert.equal(five[0].high, 13);
    assert.equal(five[0].low, 9);
    assert.equal(five[0].volume, 5);
    feed.stop();
    const reopened = createHyperliquidFeed({ storePath: path, fetcher, now: () => base + 120_000 });
    assert.equal(reopened.getCandles('1m').candles.length, 2);
    reopened.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('switches trade fanout to sampled batches at 100 viewers and reports skipped trades', () => {
  let time = 1_000_000;
  const fanout = createHyperliquidFanout({ now: () => time });
  const received = [];
  const clients = Array.from({ length: 100 }, () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, marketInterval: '1m', send: (value) => received.push(JSON.parse(value)), close: () => {} }));
  clients.forEach((client) => fanout.clients.add(client));
  const trades = Array.from({ length: 14 }, (_, index) => ({ id: String(index), price: 10 + index, amount: 1, time: 1, side: 'buy' }));
  fanout.broadcast({ type: 'trades', trades, price: 23, updatedAt: time });
  assert.equal(fanout.mode(), 'batched');
  assert.equal(received.length, 0);
  time += 1000;
  fanout.flushTrades();
  assert.equal(received.length, 100);
  assert.equal(received[0].trades.length, 10);
  assert.equal(received[0].skipped, 4);
  fanout.stop();
});
