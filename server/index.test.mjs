import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';

test('public market never includes account data; connection token gates balances and can be revoked', async () => {
  const key = 'test-readonly-key';
  const secret = 'test-readonly-secret';
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const path = request.url || '';
    if (path === '/trade/account/balances/spot') {
      const nonce = request.headers['x-auth-nonce'];
      const signature = createHmac('sha256', secret).update(nonce + key).digest('hex');
      if (request.headers['x-auth-apikey'] !== key || request.headers['x-auth-signature'] !== signature) {
        response.statusCode = 403;
        response.end('{}');
      } else response.end(JSON.stringify([{ currency: 'PRL', balance: '12', locked: '1' }, { currency: 'USDT', balance: '3', locked: '0' }, { currency: 'BTC', balance: '10', locked: '0' }]));
    } else if (path.includes('/tickers/prlusdt')) response.end(JSON.stringify({ last: '1.5', high: '2', low: '1', volume: '4', amount: '6', price_change_percent: '+5%' }));
    else if (path.includes('/depth')) response.end(JSON.stringify({ asks: [['1.6', '2']], bids: [['1.4', '3']] }));
    else if (path.includes('/trades')) response.end(JSON.stringify([{ id: 1, price: '1.5', amount: '2', side: 'buy', created_at: '2026-09-27T02:56:30Z' }]));
    else if (path.includes('/k-line')) response.end(JSON.stringify([[1790477220, '1.5', '1.6', '1.4', '1.5', '2']]));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const dataDir = mkdtempSync(join(tmpdir(), 'pearl-safetrade-test-'));
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PEARL_SERVER_PORT: '0', PEARL_DATA_DIR: dataDir, PEARL_CREDENTIAL_KEY: randomBytes(32).toString('base64'), SAFETRADE_API_BASE: `http://127.0.0.1:${upstream.address().port}`, SAFETRADE_WS_DISABLED: '1' },
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
    const market = await (await fetch(`${base}?interval=1m`)).json();
    assert.equal(market.price, 1.5);
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
