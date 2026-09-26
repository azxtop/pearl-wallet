import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { candlesFromTrades, normalizeTrade } from './market.mjs';

const HOST = process.env.PEARL_SERVER_HOST || '127.0.0.1';
const PORT = Number(process.env.PEARL_SERVER_PORT || 8787);
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST) && process.env.PEARL_ALLOW_CONTAINER_BIND !== '1') {
  throw new Error('仅允许监听本机；对外发布时请使用带 HTTPS 和访问控制的反向代理');
}
const API_BASE = process.env.SAFETRADE_API_BASE || 'https://safe.trade/api/v2';
const CREDENTIAL_FILE = process.env.SAFETRADE_CREDENTIAL_FILE || 'private/safetrade.txt';
const DATA_DIR = resolve(process.env.PEARL_DATA_DIR || 'server/data');
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(resolve(DATA_DIR, 'safetrade.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, price REAL NOT NULL, amount REAL NOT NULL)');
db.exec('CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts)');
const insertTrade = db.prepare('INSERT OR IGNORE INTO trades(id,ts,price,amount) VALUES(?,?,?,?)');
const latestTrades = db.prepare('SELECT id,ts,price,amount FROM trades WHERE ts >= ? ORDER BY ts,id');
const priorTrade = db.prepare('SELECT price FROM trades WHERE ts < ? ORDER BY ts DESC LIMIT 1');
const latestRecordedTrade = db.prepare('SELECT ts FROM trades ORDER BY ts DESC LIMIT 1');
const INTERVALS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 });

const state = {
  marketError: '等待 SafeTrade 成交数据',
  accountError: '等待 SafeTrade 账户数据',
  balances: { PRL: null, USDT: null },
  accountUpdatedAt: null,
  lastTradeAt: latestRecordedTrade.get()?.ts ?? null,
};
const ALLOWED_ORIGINS = new Set(['http://localhost', 'https://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'https://pearlwallet.az1993.xyz']);

function credentials() {
  if (process.env.SAFETRADE_API_KEY && process.env.SAFETRADE_API_SECRET) {
    return { key: process.env.SAFETRADE_API_KEY.trim(), secret: process.env.SAFETRADE_API_SECRET.trim() };
  }
  const lines = readFileSync(CREDENTIAL_FILE, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // The supplied file has a label followed by the key, then a label followed by the secret.
  if (lines.length !== 4 || !lines[1] || !lines[3]) throw new Error('SafeTrade 凭据文件格式无效');
  return { key: lines[1], secret: lines[3] };
}

function authHeaders() {
  const { key, secret } = credentials();
  const nonce = String(Date.now());
  const signature = createHmac('sha256', secret).update(nonce + key).digest('hex');
  return { 'X-Auth-Apikey': key, 'X-Auth-Nonce': nonce, 'X-Auth-Signature': signature, 'Content-Type': 'application/json;charset=utf-8' };
}

function recordTrade(raw) {
  const trade = normalizeTrade(raw);
  if (!trade) return;
  insertTrade.run(trade.id, trade.ts, trade.price, trade.amount);
  state.lastTradeAt = Math.max(state.lastTradeAt || 0, trade.ts);
  state.marketError = null;
}

function takeTradeMessage(message) {
  const data = typeof message === 'string' ? JSON.parse(message) : message;
  const channel = data?.['prlusdt.trades'] ?? (data?.stream === 'prlusdt.trades' ? data.data : null);
  if (!channel) return;
  const entries = Array.isArray(channel) ? channel : [channel];
  for (const entry of entries) recordTrade(entry);
}

let publicSocket;
function connectPublicSocket() {
  const url = API_BASE.replace(/^http/, 'ws') + '/websocket/public';
  publicSocket = new WebSocket(url);
  publicSocket.addEventListener('open', () => {
    publicSocket.send(JSON.stringify({ event: 'subscribe', streams: ['prlusdt.trades'] }));
  });
  publicSocket.addEventListener('message', (event) => {
    try { takeTradeMessage(event.data); } catch { state.marketError = 'SafeTrade 成交数据格式异常'; }
  });
  publicSocket.addEventListener('error', () => {
    if (!state.marketError || state.marketError.includes('WebSocket')) state.marketError = 'SafeTrade WebSocket 连接失败';
  });
  publicSocket.addEventListener('close', () => {
    if (!state.marketError || state.marketError.includes('WebSocket')) state.marketError = 'SafeTrade WebSocket 已断开';
    setTimeout(connectPublicSocket, 15_000).unref();
  });
}

async function fetchJson(path, headers = {}) {
  const response = await fetch(API_BASE + path, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshTrades() {
  try {
    const data = await fetchJson('/trade/public/markets/prlusdt/trades?limit=100');
    if (!Array.isArray(data)) throw new Error('成交列表格式异常');
    for (const raw of data) recordTrade(raw);
  } catch (error) {
    if (!state.lastTradeAt || Date.now() / 1000 - state.lastTradeAt > 120) {
      state.marketError = `SafeTrade 行情不可用：${error.message}`;
    }
  }
}

function normalizeBalance(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('余额格式异常');
  return {
    available: String(raw.balance ?? raw.available ?? '0'),
    locked: String(raw.locked ?? raw.hold ?? '0'),
  };
}

async function refreshBalances() {
  try {
    const data = await fetchJson('/trade/account/balances/spot', authHeaders());
    if (!Array.isArray(data)) throw new Error('余额列表格式异常');
    const byCurrency = new Map(data.filter((item) => item && typeof item.currency === 'string')
      .map((item) => [item.currency.toUpperCase(), item]));
    state.balances = {
      PRL: byCurrency.has('PRL') ? normalizeBalance(byCurrency.get('PRL')) : { available: '0', locked: '0' },
      USDT: byCurrency.has('USDT') ? normalizeBalance(byCurrency.get('USDT')) : { available: '0', locked: '0' },
    };
    state.accountUpdatedAt = Date.now();
    state.accountError = null;
  } catch (error) {
    state.balances = { PRL: null, USDT: null };
    state.accountUpdatedAt = null;
    state.accountError = `SafeTrade 账户不可用：${error.message}`;
  }
}

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    response.statusCode = 403;
    response.end(JSON.stringify({ error: 'Origin denied' }));
    return;
  }
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization');
    response.end();
    return;
  }
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
  if (request.method === 'GET' && url.pathname === '/api/update') {
    try {
      response.end(readFileSync(process.env.PEARL_UPDATE_FILE || resolve('server/update.json'), 'utf8'));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Update metadata unavailable' }));
    }
    return;
  }
  if (request.method !== 'GET' || url.pathname !== '/api/safetrade') {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const readToken = process.env.PEARL_READ_TOKEN;
  if (readToken && request.headers.authorization !== `Bearer ${readToken}`) {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  const interval = url.searchParams.get('interval') || '1m';
  const seconds = INTERVALS[interval];
  if (!seconds) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: 'Unsupported interval' }));
    return;
  }
  const end = Math.floor(Date.now() / 1000 / seconds) * seconds;
  const start = end - 119 * seconds;
  const rows = latestTrades.all(start);
  const previousClose = priorTrade.get(start)?.price ?? null;
  const candles = candlesFromTrades(rows, start, end, previousClose, seconds);
  const last24h = latestTrades.all(Math.floor(Date.now() / 1000) - 86_400);
  const high24h = last24h.reduce((value, trade) => Math.max(value, trade.price), -Infinity);
  const low24h = last24h.reduce((value, trade) => Math.min(value, trade.price), Infinity);
  const volume24h = last24h.reduce((sum, trade) => sum + trade.amount, 0);
  const turnover24h = last24h.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
  const first24h = last24h[0]?.price;
  const last24hPrice = last24h.at(-1)?.price;
  const change24h = first24h && last24hPrice ? (last24hPrice / first24h - 1) * 100 : null;
  response.end(JSON.stringify({
    pair: 'PRL/USDT',
    interval,
    price: rows.at(-1)?.price ?? previousClose,
    candles,
    stats24h: { high: Number.isFinite(high24h) ? high24h : null, low: Number.isFinite(low24h) ? low24h : null, volume: volume24h, turnover: turnover24h, changePercent: change24h },
    balances: state.balances,
    lastTradeAt: state.lastTradeAt,
    accountUpdatedAt: state.accountUpdatedAt,
    marketError: state.marketError,
    accountError: state.accountError,
  }));
});

server.listen(PORT, HOST, () => console.log(`Pearl SafeTrade server listening on ${HOST}:${PORT}`));
connectPublicSocket();
refreshTrades();
refreshBalances();
setInterval(refreshTrades, 10_000).unref();
setInterval(refreshBalances, 30_000).unref();
