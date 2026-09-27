import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeCandle, normalizeDepth, normalizePublicTrades, normalizeTicker, PERIODS } from './safetrade-data.mjs';

const HOST = process.env.PEARL_SERVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PEARL_SERVER_PORT || 8787);
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && process.env.PEARL_ALLOW_CONTAINER_BIND !== '1') {
  throw new Error('Public bind requires a reverse proxy with HTTPS');
}
const API_BASE = process.env.SAFETRADE_API_BASE || 'https://safe.trade/api/v2';
const DATA_DIR = resolve(process.env.PEARL_DATA_DIR || 'server/data');
const KEY_FILE = process.env.PEARL_CREDENTIAL_KEY_FILE;
const keyText = KEY_FILE ? readFileSync(KEY_FILE, 'utf8').trim() : process.env.PEARL_CREDENTIAL_KEY;
const DATA_KEY = keyText ? Buffer.from(keyText, 'base64') : null;
if (!DATA_KEY || DATA_KEY.length !== 32) throw new Error('PEARL_CREDENTIAL_KEY_FILE must contain a base64 32-byte key');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'accounts.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS connections (token_hash TEXT PRIMARY KEY, credentials TEXT NOT NULL, created_at INTEGER NOT NULL)');
const insertConnection = db.prepare('INSERT INTO connections(token_hash, credentials, created_at) VALUES(?, ?, ?)');
const findConnection = db.prepare('SELECT credentials FROM connections WHERE token_hash = ?');
const deleteConnection = db.prepare('DELETE FROM connections WHERE token_hash = ?');

const ALLOWED_ORIGINS = new Set(['http://localhost', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://pearlwallet.az1993.xyz']);
const marketCache = new Map();
const accountCache = new Map();
const connectionAttempts = new Map();

function json(response, status, body) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decrypt(value) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', DATA_KEY, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function requestToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '');
  return match?.[1] ?? null;
}

function authHeaders(key, secret) {
  const nonce = String(Date.now());
  return {
    'X-Auth-Apikey': key,
    'X-Auth-Nonce': nonce,
    'X-Auth-Signature': createHmac('sha256', secret).update(nonce + key).digest('hex'),
    'Content-Type': 'application/json;charset=utf-8',
  };
}

async function fetchJson(path, headers = {}) {
  const response = await fetch(API_BASE + path, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`SafeTrade HTTP ${response.status}`);
  return response.json();
}

function cached(name, lifetime, fetcher) {
  const now = Date.now();
  const entry = marketCache.get(name);
  if (entry?.value && now - entry.at < lifetime) return Promise.resolve(entry.value);
  if (entry?.pending) return entry.pending;
  const pending = fetcher().then((value) => {
    marketCache.set(name, { value, at: Date.now() });
    return value;
  }).catch((error) => {
    marketCache.set(name, { value: entry?.value, at: entry?.at ?? 0 });
    if (entry?.value && now - entry.at < 300_000) return entry.value;
    throw error;
  });
  marketCache.set(name, { ...entry, pending });
  return pending;
}

async function marketData(interval) {
  const period = PERIODS[interval];
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - period * 60 * 121;
  const query = new URLSearchParams({ period: String(period), time_from: String(timeFrom), time_to: String(now), limit: '120' });
  const results = await Promise.allSettled([
    cached('ticker', 8_000, async () => normalizeTicker(await fetchJson('/trade/public/tickers/prlusdt'))),
    cached('depth', 8_000, async () => normalizeDepth(await fetchJson('/trade/public/markets/prlusdt/depth?limit=10'))),
    cached('trades', 8_000, async () => normalizePublicTrades(await fetchJson('/trade/public/markets/prlusdt/trades?limit=20'))),
    cached(`candles:${interval}`, 15_000, async () => {
      const rows = await fetchJson(`/trade/public/markets/prlusdt/k-line?${query}`);
      if (!Array.isArray(rows)) throw new Error('Invalid candles');
      return rows.map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time);
    }),
  ]);
  const value = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
  const ticker = value(0, null);
  const candles = value(3, []);
  if (!ticker && !candles.length) throw new Error('Market unavailable');
  return {
    pair: 'PRL/USDT', interval,
    price: ticker?.price ?? candles.at(-1)?.close ?? null,
    stats24h: ticker?.stats24h ?? null,
    depth: value(1, { asks: [], bids: [] }),
    trades: value(2, []), candles,
    marketError: results.some((item) => item.status === 'rejected') ? '部分行情暂不可用' : null,
    updatedAt: Date.now(),
  };
}

function balancesOnly(data) {
  if (!Array.isArray(data)) throw new Error('Invalid balances');
  const values = new Map(data.filter((item) => item && typeof item.currency === 'string')
    .map((item) => [item.currency.toUpperCase(), item]));
  const asset = (symbol) => {
    const row = values.get(symbol);
    return { available: String(row?.balance ?? '0'), locked: String(row?.locked ?? '0') };
  };
  return { PRL: asset('PRL'), USDT: asset('USDT') };
}

async function accountData(token) {
  const hash = tokenHash(token);
  const entry = findConnection.get(hash);
  if (!entry) return null;
  const previous = accountCache.get(hash);
  if (previous && Date.now() - previous.updatedAt < 20_000) return previous;
  const { key, secret } = decrypt(entry.credentials);
  const balances = balancesOnly(await fetchJson('/trade/account/balances/spot', authHeaders(key, secret)));
  const result = { balances, updatedAt: Date.now() };
  accountCache.set(hash, result);
  return result;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error('Request too large');
  }
  return JSON.parse(body);
}

function allowedToConnect(request) {
  const ip = request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (connectionAttempts.get(ip) || []).filter((time) => now - time < 600_000);
  if (attempts.length >= 6) return false;
  attempts.push(now);
  connectionAttempts.set(ip, attempts);
  return true;
}

async function handle(request, response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(response, 403, { error: 'Origin denied' });
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return response.end();
  }
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/api/update') {
    try { return json(response, 200, JSON.parse(readFileSync(process.env.PEARL_UPDATE_FILE || resolve('server/update.json'), 'utf8'))); }
    catch { return json(response, 503, { error: 'Update metadata unavailable' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/safetrade') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    try { return json(response, 200, await marketData(interval)); }
    catch { return json(response, 503, { error: '行情暂不可用' }); }
  }
  if (url.pathname === '/api/safetrade/connection' && request.method === 'POST') {
    if (!allowedToConnect(request)) return json(response, 429, { error: '连接尝试过于频繁' });
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) return json(response, 415, { error: 'Expected JSON' });
    let data;
    try { data = await readBody(request); }
    catch { return json(response, 400, { error: '请求格式无效' }); }
    const key = typeof data?.key === 'string' ? data.key.trim() : '';
    const secret = typeof data?.secret === 'string' ? data.secret.trim() : '';
    if (key.length < 8 || key.length > 256 || secret.length < 8 || secret.length > 256) {
      return json(response, 400, { error: 'API Key 或 Secret 格式无效' });
    }
    try { balancesOnly(await fetchJson('/trade/account/balances/spot', authHeaders(key, secret))); }
    catch { return json(response, 400, { error: '无法验证只读 API，请检查密钥和 SafeTrade IP 白名单' }); }
    const token = randomBytes(32).toString('base64url');
    insertConnection.run(tokenHash(token), encrypt({ key, secret }), Date.now());
    return json(response, 201, { token });
  }
  if (url.pathname === '/api/safetrade/account') {
    const token = requestToken(request);
    if (!token) return json(response, 401, { error: '未连接 SafeTrade' });
    if (request.method === 'DELETE') {
      deleteConnection.run(tokenHash(token));
      accountCache.delete(tokenHash(token));
      return json(response, 200, { disconnected: true });
    }
    if (request.method === 'GET') {
      try {
        const data = await accountData(token);
        return data ? json(response, 200, data) : json(response, 401, { error: '连接已失效' });
      } catch { return json(response, 502, { error: '账户余额暂不可用' }); }
    }
  }
  return json(response, 404, { error: 'Not found' });
}

http.createServer((request, response) => {
  handle(request, response).catch(() => json(response, 500, { error: 'Server error' }));
}).listen(PORT, HOST, function () { console.log(`Pearl SafeTrade server listening on ${HOST}:${this.address().port}`); });
