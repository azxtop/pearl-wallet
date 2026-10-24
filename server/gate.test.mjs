import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateFeed, normalizeGateCandle, normalizeGateTicker, normalizeGateTrade } from './gate.mjs';
import { createTradeHistory } from './trade-history.mjs';

test('Gate uses base volume for candles and 24h volume, and quote volume for turnover', () => {
  const expected = { time: 1800000000, open: 2, high: 3, low: 1, close: 2.5, volume: 4, empty: false };
  assert.deepEqual(normalizeGateCandle(['1800000000', '10', '2.5', '3', '1', '2', '4', 'true']), expected);
  assert.deepEqual(normalizeGateCandle({ t: '1800000000', v: '10', c: '2.5', h: '3', l: '1', o: '2', a: '4' }), expected);
  assert.equal(normalizeGateCandle(['1800000000', '10', '2.5', '3', '1', '2']), null);
  assert.equal(normalizeGateCandle({ t: 1800000000, c: 2, h: 1, l: 1, o: 2, a: 1 }), null);
  assert.deepEqual(normalizeGateTicker({ currency_pair: 'PEARL_USDT', last: '2.5', high_24h: '3', low_24h: '1', base_volume: '4', quote_volume: '10', change_percentage: '-2' }),
    { price: 2.5, stats24h: { high: 3, low: 1, volume: 4, turnover: 10, changePercent: -2 } });
  assert.deepEqual(normalizeGateTrade({ id: '7', create_time_ms: '1800000000123.456', price: '2.5', amount: '4', side: 'sell', currency_pair: 'PEARL_USDT' }),
    { id: '7', time: 1800000000, price: 2.5, amount: 4, side: 'sell' });
  assert.equal(normalizeGateTrade({ id: '7', create_time: '1800000000', price: '2.5', amount: '4', side: 'unknown' }), null);
});

test('Gate records all chart periods, maintains incremental depth, resyncs gaps and persists public trades separately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pearl-gate-'));
  const path = join(directory, 'gate.sqlite');
  const history = createTradeHistory(join(directory, 'trades.sqlite'));
  const base = 1800000000;
  const sockets = [], subscriptions = [], candleRequests = [];
  let snapshotId = 10, snapshotCalls = 0;
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor(url) { super(); assert.equal(url, 'wss://api.gateio.ws/ws/v4/'); sockets.push(this); queueMicrotask(() => this.emit('open')); }
    send(raw) { subscriptions.push(JSON.parse(raw)); }
    ping() {}
    terminate() { this.emit('close'); }
    close() { this.emit('close'); }
  }
  const fetcher = async (rawUrl) => {
    const url = new URL(rawUrl);
    let data;
    if (url.pathname.endsWith('/currency_pairs/PEARL_USDT')) data = { id: 'PEARL_USDT', base: 'PEARL', quote: 'USDT', trade_status: 'tradable', buy_start: base };
    else {
      assert.equal(url.searchParams.get('currency_pair'), 'PEARL_USDT');
      if (url.pathname.endsWith('/tickers')) data = [{ currency_pair: 'PEARL_USDT', last: '2', base_volume: '5', quote_volume: '10' }];
      else if (url.pathname.endsWith('/trades')) data = [{ id: '1', create_time: String(base), price: '2', amount: '5', side: 'buy' }];
      else if (url.pathname.endsWith('/order_book')) { snapshotCalls++; data = { id: snapshotId, bids: [['2', '5']], asks: [['3', '7']] }; }
      else if (url.pathname.endsWith('/candlesticks')) {
        candleRequests.push(url);
        data = [[String(base), '10', '2', '3', '1', '2', '5', 'true']];
      } else throw new Error(rawUrl);
    }
    return { ok: true, json: async () => data };
  };
  const frame = (channel, result) => sockets.at(-1).emit('message', JSON.stringify({ channel, event: 'update', result }));
  const feed = createGateFeed({ storePath: path, fetcher, WebSocketImpl: Socket, now: () => (base + 120) * 1000,
    onFrame: (value) => { if (value.type === 'trades') history.add('gate', 'PEARL/USDT', value.trades); } });
  try {
    await feed.start(); await new Promise(setImmediate);
    assert.equal(subscriptions.filter((row) => row.channel === 'spot.candlesticks').length, 6);
    assert.deepEqual(subscriptions.find((row) => row.channel === 'spot.obu').payload, ['ob.PEARL_USDT.400']);
    assert.equal(candleRequests.length, 6);
    frame('spot.obu', { s: 'ob.PEARL_USDT.400', full: true, u: 10, b: [['2', '5']], a: [['3', '7']] });
    frame('spot.obu', { s: 'ob.PEARL_USDT.400', U: 11, u: 11, b: [['2', '0'], ['1.9', '8']], a: [] });
    assert.deepEqual(feed.getFullDepth().bids, [{ price: 1.9, amount: 8 }]);
    snapshotId = 15;
    frame('spot.obu', { s: 'ob.PEARL_USDT.400', U: 15, u: 15, b: [], a: [] });
    await new Promise(setImmediate);
    assert.equal(feed.getStatus().bookSynchronized, false);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(sockets.length, 2);
    frame('spot.obu', { s: 'ob.PEARL_USDT.400', full: true, u: 15, b: [['2', '5']], a: [['3', '7']] });
    assert.equal(feed.getStatus().bookSynchronized, true);
    assert.deepEqual(feed.getFullDepth().bids, [{ price: 2, amount: 5 }]);
    frame('spot.obu', { s: 'ob.PEARL_USDT.400', U: 16, u: 16, a: [['3', '9']] });
    assert.equal(feed.getFullDepth().asks[0].amount, 9);
    frame('spot.trades', { id: '2', currency_pair: 'PEARL_USDT', create_time: String(base + 1), price: '2.2', amount: '3', side: 'sell' });
    frame('spot.candlesticks', { n: '1m_PEARL_USDT', t: String(base), v: '12', o: '2', h: '3', l: '1', c: '2.2', a: '6' });
    assert.equal(feed.getOverview().price, 2.2);
    assert.equal(feed.getCandles('1m').candles.at(-1).volume, 6);
    assert.equal(history.query('gate', 'PEARL/USDT', {}).trades.length, 2);
    assert.equal(history.query('safetrade', 'PRL/USDT', {}).trades.length, 0);
    feed.stop();
    const restored = createGateFeed({ storePath: path });
    assert.equal(restored.getCandles('1m').candles.at(-1).close, 2.2);
    assert.equal(restored.getCandles('1d').candles.length, 1);
    restored.stop();
  } finally { feed.stop(); history.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Gate REST history cannot overwrite a candle received while the request was in flight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pearl-gate-race-'));
  let socket;
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor() { super(); socket = this; queueMicrotask(() => this.emit('open')); }
    send() {} ping() {} terminate() { this.emit('close'); }
  }
  const feed = createGateFeed({ storePath: join(directory, 'gate.sqlite'), WebSocketImpl: Socket, now: () => 1800000120000,
    fetcher: async (rawUrl) => {
      const url = new URL(rawUrl);
      let data;
      if (url.pathname.includes('currency_pairs')) data = { id: 'PEARL_USDT', base: 'PEARL', quote: 'USDT', buy_start: 1800000000 };
      else if (url.pathname.endsWith('/order_book')) data = { id: 1, bids: [], asks: [] };
      else if (url.pathname.endsWith('/candlesticks')) {
        if (url.searchParams.get('interval') === '1m') socket.emit('message', JSON.stringify({ channel: 'spot.candlesticks', event: 'update', result: { n: '1m_PEARL_USDT', t: '1800000000', o: '2', h: '3', l: '1', c: '2.8', a: '9' } }));
        data = [['1800000000', '10', '2', '3', '1', '2', '5']];
      } else data = [];
      return { ok: true, json: async () => data };
    } });
  try { await feed.start(); assert.equal(feed.getCandles('1m').candles.at(-1).close, 2.8); }
  finally { feed.stop(); rmSync(directory, { recursive: true, force: true }); }
});
