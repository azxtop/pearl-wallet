import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createSafeTradeFeed } from './safetrade-ws.mjs';

test('SafeTrade public stream applies depth deltas by sequence and resynchronizes on a gap', async () => {
  const server = createServer();
  const upstream = new WebSocketServer({ server, path: '/api/v2/websocket/public' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const received = { ticker: [], depth: [], trades: [] };
  let snapshotCount = 0;
  let upstreamClient;
  upstream.on('connection', (client) => {
    upstreamClient = client;
    client.on('message', () => {
      client.send(JSON.stringify({ 'global.tickers': { prlusdt: { last: '1.57', high: '1.6', low: '1.1' } } }));
      client.send(JSON.stringify({ 'prlusdt.trades': [{ id: 42, price: '1.57', amount: '2', side: 'buy', created_at: '2026-09-27T06:58:02Z' }] }));
    });
  });
  const feed = createSafeTradeFeed({
    apiBase: `http://127.0.0.1:${server.address().port}/api/v2`,
    fetchDepth: async () => ++snapshotCount === 1
      ? { sequence: 5, asks: [['1.6', '3']], bids: [['1.5', '2']] }
      : { sequence: 9, asks: [['1.7', '4']], bids: [['1.4', '1']] },
    onTicker: (value) => received.ticker.push(value),
    onDepth: (value) => received.depth.push(value),
    onTrades: (value) => received.trades.push(...value),
  });
  const until = async (predicate) => {
    const limit = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > limit) throw new Error('Timed out waiting for WebSocket data');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    feed.start();
    await until(() => received.depth.length && received.ticker.length && received.trades.length);
    assert.equal(received.ticker[0].price, 1.57);
    assert.equal(received.trades[0].id, '42');
    upstreamClient.send(JSON.stringify({ 'prlusdt.depth': { sequence: 6, asks: [['1.6', '0'], ['1.65', '5']], bids: [] } }));
    await until(() => received.depth.at(-1)?.asks[0]?.price === 1.65);
    assert.equal(received.depth.at(-1).asks.length, 1);
    upstreamClient.send(JSON.stringify({ 'prlusdt.depth': { sequence: 8, asks: [['1.8', '1']], bids: [] } }));
    await until(() => snapshotCount === 2 && received.depth.at(-1)?.asks[0]?.price === 1.7);
    assert.equal(received.depth.at(-1).bids[0].price, 1.4);
  } finally {
    feed.stop();
    for (const client of upstream.clients) client.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
