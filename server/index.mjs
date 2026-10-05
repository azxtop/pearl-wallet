import http from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import { normalizeCandle, normalizeDepth, normalizePublicTrades, normalizeTicker, PERIODS } from './safetrade-data.mjs';
import { createSafeTradeFeed } from './safetrade-ws.mjs';
import { createWprlFeed } from './wprl.mjs';
import { createHyperliquidFeed } from './hyperliquid.mjs';
import { createHyperliquidFanout } from './hyperliquid-fanout.mjs';
import { createLighterFeed } from './lighter.mjs';
import { createTradeHistory } from './trade-history.mjs';

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
const tradeHistory = createTradeHistory(resolve(DATA_DIR, 'trade-history.sqlite'));
const db = new DatabaseSync(resolve(DATA_DIR, 'accounts.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS connections (token_hash TEXT PRIMARY KEY, credentials TEXT NOT NULL, created_at INTEGER NOT NULL)');
const insertConnection = db.prepare('INSERT INTO connections(token_hash, credentials, created_at) VALUES(?, ?, ?)');
const findConnection = db.prepare('SELECT credentials FROM connections WHERE token_hash = ?');
const deleteConnection = db.prepare('DELETE FROM connections WHERE token_hash = ?');

const ALLOWED_ORIGINS = new Set(['http://localhost', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://pearlwallet.az1993.xyz']);
const marketCache = new Map();
const accountCache = new Map();
const connectionAttempts = new Map();
const streamClients = new Set();
const streamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const fullDepthClients = new Set();
const fullDepthStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const marketDepthClients = { hyperliquid: new Set(), lighter: new Set() };
const marketDepthSequence = { hyperliquid: 0, lighter: 0 };
const marketDepthUpdatedAt = { hyperliquid: 0, lighter: 0 };
const marketDepthStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const wprlStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const wprlStreamClients = new Set();
const hyperliquidStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const hyperliquidFanout = createHyperliquidFanout();
const lighterStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const lighterFanout = createHyperliquidFanout();
const accountStreamServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });
const accountStreamTickets = new Map();
const accountStreams = new Map();
let streamFlushTimer;
let liveOverview = null;
const pendingFrames = new Map();

function broadcast(frame) {
  const key = frame.type === 'candle' ? `candle:${frame.interval}` : frame.type;
  if (frame.type === 'overview-patch') {
    const previous = pendingFrames.get(key);
    pendingFrames.set(key, { type: frame.type, data: { ...previous?.data, ...frame.data } });
  } else pendingFrames.set(key, frame);
  if (streamFlushTimer) return;
  streamFlushTimer = setTimeout(() => {
    streamFlushTimer = null;
    const frames = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const client of streamClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 256_000) { client.terminate(); continue; }
      for (const item of frames) {
        if (item.type === 'candle' && item.interval !== client.marketInterval) continue;
        client.send(JSON.stringify(item));
      }
    }
  }, 120);
}

function updateOverview(change) {
  const previous = liveOverview || marketCache.get('overview')?.value;
  liveOverview = {
    pair: 'PRL/USDT', price: null, stats24h: null,
    depth: { asks: [], bids: [] }, trades: [], marketError: null,
    ...previous, ...change, updatedAt: Date.now(),
  };
  broadcast({ type: 'overview-patch', data: { ...change, updatedAt: liveOverview.updatedAt } });
}

function updateCandlesFromTrade(trade) {
  if (!Number.isFinite(trade.time) || !Number.isFinite(trade.price)) return;
  for (const [interval, period] of Object.entries(PERIODS)) {
    const entry = marketCache.get(`candles:${interval}`);
    const series = entry?.value;
    if (!series?.candles.length || trade.time < Math.floor(series.updatedAt / 1000) - 1) continue;
    const time = Math.floor(trade.time / (period * 60)) * period * 60;
    const candles = series.candles.slice();
    const last = candles.at(-1);
    if (time < last.time) continue;
    const candle = time === last.time
      ? { ...last, high: Math.max(last.high, trade.price), low: Math.min(last.low, trade.price), close: trade.price, empty: false }
      : { time, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: 0, empty: false };
    if (time === last.time) candles[candles.length - 1] = candle;
    else { candles.push(candle); if (candles.length > 300) candles.shift(); }
    marketCache.set(`candles:${interval}`, { ...entry, value: { ...series, candles, updatedAt: Date.now() } });
    broadcast({ type: 'candle', interval, candle, updatedAt: Date.now() });
  }
}

function broadcastMarketDepth(source, depth, updatedAt) {
  marketDepthSequence[source]++;
  marketDepthUpdatedAt[source] = updatedAt;
  const clients = marketDepthClients[source];
  if (!clients.size) return;
  const frame = JSON.stringify({ type: 'depth-snapshot', sequence: marketDepthSequence[source], depth, updatedAt });
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > 256_000) { client.terminate(); continue; }
    client.send(frame);
  }
}

const publicFeed = createSafeTradeFeed({
  apiBase: API_BASE,
  fetchDepth: () => fetchJson('/trade/public/markets/prlusdt/depth?limit=200'),
  onTicker: (ticker) => updateOverview({ price: ticker.price, stats24h: ticker.stats24h }),
  onDepth: (depth) => updateOverview({ depth }),
  onFullDepth: (frame) => {
    if (!fullDepthClients.size) return;
    const payload = JSON.stringify(frame);
    for (const client of fullDepthClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 256_000) { client.terminate(); continue; }
      client.send(payload);
    }
  },
  onTrades: (trades) => {
    tradeHistory.add('safetrade', 'PRL/USDT', trades);
    const existing = liveOverview?.trades || marketCache.get('overview')?.value?.trades || [];
    const merged = [...trades, ...existing.filter((row) => !trades.some((trade) => trade.id === row.id))]
      .sort((a, b) => b.time - a.time).slice(0, 20);
    updateOverview({ trades: merged, price: trades.at(-1)?.price ?? liveOverview?.price ?? null });
    for (const trade of trades) updateCandlesFromTrade(trade);
  },
});

const wprlFeed = createWprlFeed({
  keyDbPath: process.env.PEARL_INFURA_KEYS_DB || '',
  cachePath: resolve(DATA_DIR, 'wprl-market-cache.json'),
  storePath: process.env.WPRL_ENABLED === '1' ? resolve(DATA_DIR, 'wprl-market.sqlite') : '',
  onFrame: (frame) => {
    for (const client of wprlStreamClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > 256_000) { client.terminate(); continue; }
      if (frame.type === 'candle' && frame.interval !== client.marketInterval) continue;
      client.send(JSON.stringify(frame));
    }
  },
});

const hyperliquidFeed = createHyperliquidFeed({
  storePath: resolve(DATA_DIR, 'hyperliquid-market.sqlite'),
  coin: process.env.HYPERLIQUID_COIN || 'BTC',
  dex: process.env.HYPERLIQUID_DEX || '',
  quote: process.env.HYPERLIQUID_QUOTE || 'USDC',
  onFrame: (frame) => {
    if (frame.type === 'full-depth') broadcastMarketDepth('hyperliquid', frame.depth, frame.updatedAt);
    else {
      if (frame.type === 'trades') tradeHistory.add('hyperliquid', hyperliquidFeed.contract()?.pair ?? 'BTC/USDC', frame.trades);
      hyperliquidFanout.broadcast(frame);
    }
  },
});
const lighterFeed = createLighterFeed({
  storePath: resolve(DATA_DIR, 'lighter-market.sqlite'),
  onFrame: (frame) => {
    if (frame.type === 'full-depth') broadcastMarketDepth('lighter', frame.depth, frame.updatedAt);
    else {
      if (frame.type === 'trades') tradeHistory.add('lighter', String(lighterFeed.contract()?.marketId ?? 'PRL'), frame.trades);
      lighterFanout.broadcast(frame);
    }
  },
});

function selectedMarket(source) {
  if (source === 'safetrade') return 'PRL/USDT';
  if (source === 'hyperliquid') return hyperliquidFeed.contract()?.pair ?? null;
  if (source === 'lighter') return lighterFeed.contract()?.marketId == null ? null : String(lighterFeed.contract().marketId);
  return null;
}

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
  const usableStale = entry?.value && now - entry.at < 300_000;
  if (entry?.pending) return usableStale ? Promise.resolve(entry.value) : entry.pending;
  if (entry?.retryAt > now) return usableStale ? Promise.resolve(entry.value) : Promise.reject(new Error('Upstream cooling down'));
  const pending = Promise.resolve().then(fetcher).then((value) => {
    marketCache.set(name, { value, at: Date.now() });
    return value;
  }).catch((error) => {
    marketCache.set(name, { value: entry?.value, at: entry?.at ?? 0, retryAt: Date.now() + 15_000 });
    if (usableStale) return entry.value;
    throw error;
  });
  marketCache.set(name, { ...entry, pending });
  if (usableStale) {
    void pending.catch(() => {});
    return Promise.resolve(entry.value);
  }
  return pending;
}

function candleData(interval) {
  const period = PERIODS[interval];
  const now = Math.floor(Date.now() / 1000);
  const timeFrom = now - period * 60 * 301;
  const query = new URLSearchParams({ period: String(period), time_from: String(timeFrom), time_to: String(now), limit: '300' });
  return cached(`candles:${interval}`, 10_000, async () => {
    const rows = await fetchJson(`/trade/public/markets/prlusdt/k-line?${query}`);
    if (!Array.isArray(rows)) throw new Error('Invalid candles');
    return { interval, candles: rows.map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time), updatedAt: Date.now() };
  });
}

function overviewData() {
  return cached('overview', 5_000, async () => {
    const results = await Promise.allSettled([
      fetchJson('/trade/public/tickers/prlusdt').then(normalizeTicker),
      fetchJson('/trade/public/markets/prlusdt/depth?limit=10').then(normalizeDepth),
      fetchJson('/trade/public/markets/prlusdt/trades?limit=20').then(normalizePublicTrades),
    ]);
    if (results.every((item) => item.status === 'rejected')) throw new Error('Market unavailable');
    if (results[2].status === 'fulfilled') tradeHistory.add('safetrade', 'PRL/USDT', results[2].value);
    const value = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
    const previous = marketCache.get('overview')?.value;
    const ticker = value(0, null);
    return {
      pair: 'PRL/USDT', price: ticker?.price ?? previous?.price ?? null, stats24h: ticker?.stats24h ?? previous?.stats24h ?? null,
      depth: value(1, previous?.depth ?? { asks: [], bids: [] }), trades: value(2, previous?.trades ?? []),
      marketError: results.some((item) => item.status === 'rejected') ? '部分行情暂不可用' : null,
      updatedAt: Date.now(),
    };
  });
}

async function marketData(interval) {
  const results = await Promise.allSettled([
    overviewData(), candleData(interval),
  ]);
  const value = (index, fallback) => results[index].status === 'fulfilled' ? results[index].value : fallback;
  const overview = value(0, null);
  const series = value(1, null);
  if (!overview && !series?.candles.length) throw new Error('Market unavailable');
  return {
    pair: 'PRL/USDT', interval,
    price: overview?.price ?? series?.candles.at(-1)?.close ?? null,
    stats24h: overview?.stats24h ?? null,
    depth: overview?.depth ?? { asks: [], bids: [] },
    trades: overview?.trades ?? [], candles: series?.candles ?? [],
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

async function accountData(token, force = false) {
  const hash = tokenHash(token);
  const entry = findConnection.get(hash);
  if (!entry) return null;
  const previous = accountCache.get(hash);
  if (!force && previous && Date.now() - previous.updatedAt < 20_000) return previous;
  const { key, secret } = decrypt(entry.credentials);
  const balances = balancesOnly(await fetchJson('/trade/account/balances/spot', authHeaders(key, secret)));
  const result = { balances, updatedAt: Date.now() };
  accountCache.set(hash, result);
  return result;
}

function startAccountFeed(client, hash, credentials) {
  const { key, secret } = decrypt(credentials);
  const endpoint = `${API_BASE.replace(/^http/, 'ws').replace(/\/$/, '')}/websocket/private`;
  let upstream;
  let heartbeat;
  let retryTimer;
  let retryMs = 1000;
  let stopped = false;
  const send = (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  };
  const refresh = async () => {
    if (stopped) return;
    const entry = findConnection.get(hash);
    if (!entry) { client.close(1008, 'Connection revoked'); return; }
    try {
      const balances = balancesOnly(await fetchJson('/trade/account/balances/spot', authHeaders(key, secret)));
      const result = { balances, updatedAt: Date.now() };
      accountCache.set(hash, result);
      send({ type: 'account', data: result });
    } catch { /* The App keeps the last balance and retries through REST. */ }
  };
  const connect = () => {
    if (stopped || client.readyState !== WebSocket.OPEN) return;
    upstream = new WebSocket(endpoint, { headers: authHeaders(key, secret), handshakeTimeout: 10_000 });
    upstream.on('open', () => {
      retryMs = 1000;
      upstream.send(JSON.stringify({ event: 'subscribe', streams: ['balance'] }));
      heartbeat = setInterval(() => { if (upstream.readyState === WebSocket.OPEN) upstream.ping(); }, 25_000);
      void refresh();
    });
    upstream.on('message', (message) => {
      let data;
      try { data = JSON.parse(String(message)); } catch { return; }
      if (Object.hasOwn(data || {}, 'balance')) void refresh();
    });
    upstream.on('error', () => {});
    upstream.on('close', () => {
      clearInterval(heartbeat);
      if (!stopped) {
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    });
  };
  client.on('close', () => {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(heartbeat);
    upstream?.terminate();
    const clients = accountStreams.get(hash);
    clients?.delete(client);
    if (clients?.size === 0) accountStreams.delete(hash);
  });
  void refresh();
  connect();
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
  const marketDepthRoute = /^\/api\/(hyperliquid|lighter)\/depth$/.exec(url.pathname);
  if (request.method === 'GET' && marketDepthRoute) {
    const source = marketDepthRoute[1];
    const depth = source === 'hyperliquid' ? hyperliquidFeed.getFullDepth() : lighterFeed.getFullDepth();
    return depth.asks.length || depth.bids.length
      ? json(response, 200, { sequence: marketDepthSequence[source], depth, updatedAt: marketDepthUpdatedAt[source] || Date.now() })
      : json(response, 503, { error: '订单簿正在同步' });
  }
  const tradeHistoryRoute = /^\/api\/(safetrade|hyperliquid|lighter)\/trades$/.exec(url.pathname);
  if (request.method === 'GET' && tradeHistoryRoute) {
    const source = tradeHistoryRoute[1], market = selectedMarket(source);
    if (!market) return json(response, 503, { error: '市场正在同步' });
    try {
      const data = tradeHistory.query(source, market, Object.fromEntries(url.searchParams));
      return json(response, 200, { ...data, pair: source === 'lighter' ? lighterFeed.contract().pair : market, source });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/wprl/overview') {
    try { return json(response, 200, await wprlFeed.getOverview()); }
    catch { return json(response, 503, { error: 'WPRL 行情暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/wprl/candles') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    try { return json(response, 200, await wprlFeed.getCandles(interval)); }
    catch { return json(response, 503, { error: 'WPRL K 线暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/hyperliquid/overview') {
    try { return json(response, 200, hyperliquidFeed.getOverview()); }
    catch { return json(response, 503, { error: 'Hyperliquid 行情暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/hyperliquid/candles') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    try { return json(response, 200, hyperliquidFeed.getCandles(interval)); }
    catch { return json(response, 503, { error: 'Hyperliquid K 线暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/hyperliquid/status') {
    return json(response, 200, { ...hyperliquidFanout.stats(), contract: hyperliquidFeed.contract() });
  }
  if (request.method === 'GET' && url.pathname === '/api/lighter/overview') {
    try { return json(response, 200, lighterFeed.getOverview()); }
    catch { return json(response, 503, { error: 'Lighter 行情暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/lighter/candles') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    try { return json(response, 200, lighterFeed.getCandles(interval)); }
    catch { return json(response, 503, { error: 'Lighter K 线暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/lighter/status') {
    return json(response, 200, { ...lighterFanout.stats(), contract: lighterFeed.contract() });
  }
  if (request.method === 'GET' && url.pathname === '/api/safetrade/depth') {
    const snapshot = publicFeed.getFullDepth();
    return snapshot ? json(response, 200, snapshot) : json(response, 503, { error: '订单簿正在同步' });
  }
  if (request.method === 'GET' && url.pathname === '/api/safetrade') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    try { return json(response, 200, await marketData(interval)); }
    catch { return json(response, 503, { error: '行情暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/safetrade/overview') {
    const started = performance.now();
    try {
      const data = await overviewData();
      response.setHeader('Server-Timing', `market;dur=${(performance.now() - started).toFixed(1)}`);
      return json(response, 200, data);
    }
    catch { return json(response, 503, { error: '行情暂不可用' }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/safetrade/candles') {
    const interval = url.searchParams.get('interval') || '1m';
    if (!PERIODS[interval]) return json(response, 400, { error: 'Unsupported interval' });
    const started = performance.now();
    try {
      const data = await candleData(interval);
      response.setHeader('Server-Timing', `market;dur=${(performance.now() - started).toFixed(1)}`);
      return json(response, 200, data);
    }
    catch { return json(response, 503, { error: 'K 线暂不可用' }); }
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
  if (url.pathname === '/api/safetrade/account-stream-ticket' && request.method === 'POST') {
    const token = requestToken(request);
    if (!token) return json(response, 401, { error: 'Not connected' });
    const hash = tokenHash(token);
    if (!findConnection.get(hash)) return json(response, 401, { error: 'Connection expired' });
    const ticket = randomBytes(24).toString('base64url');
    accountStreamTickets.set(ticket, { hash, expiresAt: Date.now() + 30_000 });
    for (const [value, entry] of accountStreamTickets) {
      if (entry.expiresAt < Date.now()) accountStreamTickets.delete(value);
    }
    return json(response, 200, { ticket });
  }
  if (url.pathname === '/api/safetrade/account') {
    const token = requestToken(request);
    if (!token) return json(response, 401, { error: '未连接 SafeTrade' });
    if (request.method === 'DELETE') {
      const hash = tokenHash(token);
      deleteConnection.run(hash);
      accountCache.delete(hash);
      for (const client of accountStreams.get(hash) || []) client.close(1008, 'Connection revoked');
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

const server = http.createServer((request, response) => {
  handle(request, response).catch(() => json(response, 500, { error: 'Server error' }));
});

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  let pathname;
  try { pathname = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname; }
  catch { socket.destroy(); return; }
  if ((origin && !ALLOWED_ORIGINS.has(origin)) || (pathname !== '/api/safetrade/stream' && pathname !== '/api/safetrade/depth-stream' && pathname !== '/api/safetrade/account-stream' && pathname !== '/api/wprl/stream' && pathname !== '/api/hyperliquid/stream' && pathname !== '/api/lighter/stream' && pathname !== '/api/hyperliquid/depth-stream' && pathname !== '/api/lighter/depth-stream')) {
    socket.destroy();
    return;
  }
  if (pathname === '/api/safetrade/depth-stream') {
    if (fullDepthClients.size >= 100) { socket.destroy(); return; }
    fullDepthStreamServer.handleUpgrade(request, socket, head, (client) => {
      fullDepthClients.add(client);
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('close', () => fullDepthClients.delete(client));
      const snapshot = publicFeed.getFullDepth();
      if (snapshot) client.send(JSON.stringify({ type: 'depth-snapshot', ...snapshot }));
    });
    return;
  }
  const marketDepthRoute = /^\/api\/(hyperliquid|lighter)\/depth-stream$/.exec(pathname);
  if (marketDepthRoute) {
    const source = marketDepthRoute[1], clients = marketDepthClients[source];
    if (clients.size >= 100) { socket.destroy(); return; }
    marketDepthStreamServer.handleUpgrade(request, socket, head, (client) => {
      clients.add(client);
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('close', () => clients.delete(client));
      const depth = source === 'hyperliquid' ? hyperliquidFeed.getFullDepth() : lighterFeed.getFullDepth();
      if (depth.asks.length || depth.bids.length) client.send(JSON.stringify({ type: 'depth-snapshot', sequence: marketDepthSequence[source], depth, updatedAt: marketDepthUpdatedAt[source] || Date.now() }));
    });
    return;
  }
  if (pathname === '/api/safetrade/account-stream') {
    const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map((part) => part.trim());
    const ticket = protocols.find((part) => /^ticket\.[A-Za-z0-9_-]{32}$/.test(part))?.slice(7);
    const entry = ticket && accountStreamTickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now() || !findConnection.get(entry.hash)) { socket.destroy(); return; }
    accountStreamTickets.delete(ticket);
    const clients = accountStreams.get(entry.hash) || new Set();
    if (clients.size >= 3) { socket.destroy(); return; }
    accountStreamServer.handleUpgrade(request, socket, head, (client) => {
      clients.add(client);
      accountStreams.set(entry.hash, clients);
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      startAccountFeed(client, entry.hash, findConnection.get(entry.hash).credentials);
    });
    return;
  }
  if (pathname === '/api/wprl/stream') {
    if (wprlStreamClients.size >= 100) { socket.destroy(); return; }
    wprlStreamServer.handleUpgrade(request, socket, head, (client) => {
      wprlStreamClients.add(client);
      client.marketInterval = '1m';
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('message', (message) => {
        let data;
        try { data = JSON.parse(String(message)); } catch { return; }
        if (data?.type === 'subscribe' && PERIODS[data.interval]) client.marketInterval = data.interval;
      });
      client.on('close', () => wprlStreamClients.delete(client));
      const overview = wprlFeed.currentOverview();
      if (overview) client.send(JSON.stringify({ type: 'overview', data: overview }));
    });
    return;
  }
  if (pathname === '/api/hyperliquid/stream') {
    if (hyperliquidFanout.clients.size >= 500) { socket.destroy(); return; }
    hyperliquidStreamServer.handleUpgrade(request, socket, head, (client) => {
      hyperliquidFanout.clients.add(client);
      client.marketInterval = '1m';
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('message', (message) => {
        let data;
        try { data = JSON.parse(String(message)); } catch { return; }
        if (data?.type === 'subscribe' && PERIODS[data.interval]) client.marketInterval = data.interval;
      });
      client.on('close', () => hyperliquidFanout.clients.delete(client));
      try { hyperliquidFanout.send(client, { type: 'overview', data: hyperliquidFeed.getOverview() }); } catch { /* feed starting */ }
    });
    return;
  }
  if (pathname === '/api/lighter/stream') {
    if (lighterFanout.clients.size >= 500) { socket.destroy(); return; }
    lighterStreamServer.handleUpgrade(request, socket, head, (client) => {
      lighterFanout.clients.add(client);
      client.marketInterval = '1m';
      client.isAlive = true;
      client.on('pong', () => { client.isAlive = true; });
      client.on('message', (message) => {
        let data;
        try { data = JSON.parse(String(message)); } catch { return; }
        if (data?.type === 'subscribe' && PERIODS[data.interval]) client.marketInterval = data.interval;
      });
      client.on('close', () => lighterFanout.clients.delete(client));
      try { lighterFanout.send(client, { type: 'overview', data: lighterFeed.getOverview() }); } catch { /* feed starting */ }
    });
    return;
  }
  if (streamClients.size >= 100) { socket.destroy(); return; }
  streamServer.handleUpgrade(request, socket, head, (client) => {
    streamClients.add(client);
    client.marketInterval = '1m';
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });
    client.on('message', (message) => {
      let data;
      try { data = JSON.parse(String(message)); } catch { return; }
      if (data?.type === 'subscribe' && PERIODS[data.interval]) client.marketInterval = data.interval;
    });
    client.on('close', () => streamClients.delete(client));
    const overview = liveOverview || marketCache.get('overview')?.value;
    if (overview) client.send(JSON.stringify({ type: 'overview', data: overview }));
  });
});

setInterval(() => {
  const clients = [...streamClients, ...fullDepthClients, ...marketDepthClients.hyperliquid, ...marketDepthClients.lighter, ...wprlStreamClients, ...hyperliquidFanout.clients, ...lighterFanout.clients, ...[...accountStreams.values()].flatMap((group) => [...group])];
  for (const client of clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, 25_000).unref();

setInterval(() => { try { tradeHistory.prune(); } catch (error) { console.warn('Trade history prune:', error.message); } }, 10 * 60_000).unref();

server.listen(PORT, HOST, function () {
  console.log(`Pearl SafeTrade server listening on ${HOST}:${this.address().port}`);
  void overviewData().catch(() => {});
  void candleData('1m').catch(() => {});
  if (process.env.SAFETRADE_WS_DISABLED !== '1') publicFeed.start();
  if (process.env.WPRL_ENABLED === '1') wprlFeed.start();
  if (process.env.HYPERLIQUID_ENABLED !== '0') void hyperliquidFeed.start();
  if (process.env.LIGHTER_ENABLED !== '0') void lighterFeed.start();
});
