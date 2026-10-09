import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAsterFeed, normalizeAsterCandle, normalizeAsterTrade } from './aster.mjs';

test('normalizes Aster public candles and taker direction', () => {
  assert.deepEqual(normalizeAsterCandle([120000, '2', '3', '1', '2.5', '4']),
    { time: 120, open: 2, high: 3, low: 1, close: 2.5, volume: 4, empty: false });
  assert.equal(normalizeAsterCandle([120000, '2', '1', '1', '2.5', '4']), null);
  assert.deepEqual(normalizeAsterTrade({ a: 42, p: '2.5', q: '4', T: 120000, m: true }),
    { id: '42', price: 2.5, amount: 4, time: 120, side: 'sell' });
});

test('records Aster PEARL candles and serves an aggregated chart after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-aster-'));
  const path = join(dir, 'aster.sqlite');
  const base = 1_800_000_000_000;
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); assert.match(url, /pearlusdt@kline_1m/); queueMicrotask(() => this.emit('open')); }
    terminate() { this.emit('close'); }
    ping() {}
  }
  const fetcher = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (!url.pathname.endsWith('/exchangeInfo')) assert.equal(url.searchParams.get('symbol'), 'PEARLUSDT');
    const data = url.pathname.endsWith('/exchangeInfo') ? { symbols: [{ symbol: 'PEARLUSDT', status: 'TRADING', contractType: 'PERPETUAL' }] }
      : url.pathname.endsWith('/ticker/24hr') ? { lastPrice: '2.5', highPrice: '3', lowPrice: '2', volume: '10', quoteVolume: '25', priceChangePercent: '1.2' }
      : url.pathname.endsWith('/premiumIndex') ? { markPrice: '2.4', indexPrice: '2.3', lastFundingRate: '0.001' }
      : url.pathname.endsWith('/openInterest') ? { openInterest: '100' }
      : url.pathname.endsWith('/depth') ? { bids: [['2', '5']], asks: [['3', '7']] }
      : url.pathname.endsWith('/trades') ? [{ id: 1, price: '2.5', qty: '1', time: base, isBuyerMaker: false }]
      : url.pathname.endsWith('/klines') ? [
        [base, '2', '3', '1', '2.5', '4'],
        [base + 60_000, '2.5', '4', '2', '3', '6'],
      ] : null;
    assert.ok(data, rawUrl);
    return { ok: true, json: async () => data };
  };
  let feed;
  try {
    feed = createAsterFeed({ storePath: path, fetcher, WebSocketImpl: FakeSocket, now: () => base + 120_000 });
    await feed.start();
    assert.equal(feed.getOverview().price, 2.5);
    assert.equal(feed.getOverview().openInterest, 100);
    assert.equal(feed.getFullDepth().bids[0].amount, 5);
    assert.equal(feed.getCandles('1m').candles.length, 2);
    const five = feed.getCandles('5m').candles[0];
    assert.equal(five.high, 4);
    assert.equal(five.volume, 10);
    feed.stop(); feed = null;
    const reopened = createAsterFeed({ storePath: path, fetcher, WebSocketImpl: FakeSocket });
    assert.equal(reopened.getCandles('1m').candles[1].close, 3);
    reopened.stop();
  } finally { feed?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
