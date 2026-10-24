import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import WebSocket from 'ws';

test('public market never includes account data; connection token gates balances and can be revoked', async () => {
  const key = 'test-readonly-key';
  const secret = 'test-readonly-secret';
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const path = request.url || '';
    if (path.startsWith('/trade/public/') && path.includes('prlusdt')) { response.statusCode = 404; response.end('{}'); }
    else if (path === '/trade/account/balances/spot') {
      const nonce = request.headers['x-auth-nonce'];
      const signature = createHmac('sha256', secret).update(nonce + key).digest('hex');
      if (request.headers['x-auth-apikey'] !== key || request.headers['x-auth-signature'] !== signature) {
        response.statusCode = 403;
        response.end('{}');
      } else response.end(JSON.stringify([{ currency: 'pearl', balance: '12', locked: '1' }, { currency: 'prl', balance: '0', locked: '0' }, { currency: 'USDT', balance: '3', locked: '0' }, { currency: 'BTC', balance: '10', locked: '0' }]));
    } else if (path.includes('/tickers/pearlusdt')) response.end(JSON.stringify({ last: '1.5', high: '2', low: '1', volume: '4', amount: '6', price_change_percent: '+5%' }));
    else if (path.includes('/depth')) response.end(JSON.stringify({ asks: [['1.6', '2']], bids: [['1.4', '3']] }));
    else if (path.startsWith('/trade/market/trades?')) {
      const nonce = request.headers['x-auth-nonce'];
      const signature = createHmac('sha256', secret).update(nonce + key).digest('hex');
      if (request.headers['x-auth-apikey'] !== key || request.headers['x-auth-signature'] !== signature) {
        response.statusCode = 403;
        response.end('{}');
      } else if (new URL(`http://test${path}`).searchParams.get('market') === 'prlusdt') response.end(JSON.stringify([{ id: 41, market: 'prlusdt', side: 'sell', order_side: 'sell', price: '1.1', amount: '2', created_at: '2026-10-17T12:00:00Z' }]));
      else response.end(JSON.stringify([{ id: 41, market: 'pearlusdt', side: 'sell', order_side: 'buy', price: '1.25', amount: '4', created_at: new Date(Date.now() - 60_000).toISOString() }]));
    }
    else if (path.includes('/trades')) response.end(JSON.stringify([{ id: 1, price: '1.5', amount: '2', side: 'buy', created_at: '2026-09-27T02:56:30Z' }]));
    else if (path.includes('/k-line')) response.end(JSON.stringify([[1790477220, '1.5', '1.6', '1.4', '1.5', '2']]));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync(join(tmpdir(), 'pearl-safetrade-test-'));
  const oldDb = new DatabaseSync(join(dataDir, 'accounts.sqlite'));
  oldDb.exec('CREATE TABLE personal_trade_cache (token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, covered_from INTEGER NOT NULL, synced_at INTEGER NOT NULL)');
  oldDb.close();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PEARL_SERVER_PORT: '0', PEARL_DATA_DIR: dataDir, PEARL_CREDENTIAL_KEY: randomBytes(32).toString('base64'), SAFETRADE_API_BASE: `http://127.0.0.1:${upstream.address().port}`, SAFETRADE_WS_DISABLED: '1', GATE_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}/api/safetrade`;
    const gateBase = `http://127.0.0.1:${port}/api/gate`;
    assert.equal((await (await fetch(`${gateBase}/overview`)).json()).pair, 'PEARL/USDT');
    assert.deepEqual((await (await fetch(`${gateBase}/trades`)).json()).trades, []);
    assert.equal((await fetch(`${gateBase}/depth`)).status, 503);
    assert.equal((await fetch(`${gateBase}/candles?interval=bad`)).status, 400);
    const gateStream = new WebSocket(`ws://127.0.0.1:${port}/api/gate/stream`);
    const gateFrame = await new Promise((resolve, reject) => {
      gateStream.once('message', (message) => resolve(JSON.parse(String(message))));
      gateStream.once('error', reject);
    });
    assert.equal(gateFrame.data.pair, 'PEARL/USDT');
    assert.equal('balances' in gateFrame.data, false);
    gateStream.close();
    const market = await (await fetch(`${base}?interval=1m`)).json();
    assert.equal(market.price, 1.5);
    assert.equal(market.pair, 'PRL/USDT');
    assert.equal(market.depth.asks[0].price, 1.6);
    assert.equal(market.trades[0].side, 'buy');
    assert.equal(market.candles[0].volume, 2);
    assert.equal('balances' in market, false);
    const overview = await (await fetch(`${base}/overview`)).json();
    assert.equal(overview.price, 1.5);
    assert.equal('candles' in overview, false);
    const series = await (await fetch(`${base}/candles?interval=5m`)).json();
    assert.equal(series.interval, '5m');
    assert.equal(series.candles[0].volume, 2);
    assert.equal('depth' in series, false);
    assert.equal((await fetch(`${base}/candles?interval=bad`)).status, 400);
    assert.equal((await fetch(`${base}/account`)).status, 401);
    assert.equal((await fetch(`${base}/personal-trades`)).status, 401);
    assert.equal((await fetch(`${base}/account-stream-ticket`, { method: 'POST' })).status, 401);
    const publicStream = new WebSocket(`ws://127.0.0.1:${port}/api/safetrade/stream`);
    const publicFrame = await new Promise((resolve, reject) => {
      publicStream.once('message', (message) => resolve(JSON.parse(String(message))));
      publicStream.once('error', reject);
    });
    assert.equal(publicFrame.type, 'overview');
    assert.equal(publicFrame.data.price, 1.5);
    assert.equal('balances' in publicFrame.data, false);
    publicStream.close();
    const connected = await fetch(`${base}/connection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, secret }) });
    assert.equal(connected.status, 201);
    const { token } = await connected.json();
    const headers = { Authorization: `Bearer ${token}` };
    const account = await (await fetch(`${base}/account`, { headers })).json();
    assert.deepEqual(account.balances.PRL, { available: '12', locked: '1' });
    assert.equal('BTC' in account.balances, false);
    let personal = await (await fetch(`${base}/personal-trades`, { headers })).json();
    for (let attempt = 0; personal.syncing && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      personal = await (await fetch(`${base}/personal-trades`, { headers })).json();
    }
    assert.equal(personal.syncing, false);
    assert.equal(personal.trades.length, 2);
    assert.equal(personal.trades[0].side, 'sell');
    assert.equal(personal.trades[1].side, 'buy');
    assert.deepEqual(personal.trades.map((trade) => trade.id), ['prlusdt:41', 'pearlusdt:41']);
    assert.equal(personal.averages.buy, 1.25);
    assert.equal(personal.averages.sell, 1.1);
    assert.equal('personalTrades' in market, false);
    const ticketResponse = await fetch(`${base}/account-stream-ticket`, { method: 'POST', headers });
    assert.equal(ticketResponse.status, 200);
    const { ticket } = await ticketResponse.json();
    const accountStream = new WebSocket(`ws://127.0.0.1:${port}/api/safetrade/account-stream`, ['pearl-v1', `ticket.${ticket}`]);
    const accountFrame = await new Promise((resolve, reject) => {
      accountStream.once('message', (message) => resolve(JSON.parse(String(message))));
      accountStream.once('error', reject);
    });
    assert.equal(accountFrame.type, 'account');
    assert.deepEqual(accountFrame.data.balances.USDT, { available: '3', locked: '0' });
    accountStream.close();
    assert.equal((await fetch(`${base}/account`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await fetch(`${base}/account`, { headers })).status, 401);
    assert.equal((await fetch(`${base}/personal-trades`, { headers })).status, 401);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await new Promise((resolve) => upstream.close(resolve));
    if (dataDir.startsWith(tmpdir())) rmSync(dataDir, { recursive: true, force: true });
  }
});
