import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const API = 'https://fapi.asterdex.com/fapi/v1';
const STREAM = 'wss://fstream.asterdex.com/stream?streams=pearlusdt@kline_1m/pearlusdt@aggTrade/pearlusdt@ticker/pearlusdt@markPrice@1s';
const PERIODS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const numeric = (value) => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const bucket = (time, period) => Math.floor(time / period) * period;

export function normalizeAsterCandle(row) {
  const time = Math.floor(Number(Array.isArray(row) ? row[0] : row?.t) / 1000);
  const open = numeric(Array.isArray(row) ? row[1] : row?.o);
  const high = numeric(Array.isArray(row) ? row[2] : row?.h);
  const low = numeric(Array.isArray(row) ? row[3] : row?.l);
  const close = numeric(Array.isArray(row) ? row[4] : row?.c);
  const volume = numeric(Array.isArray(row) ? row[5] : row?.v);
  return Number.isSafeInteger(time) && time > 0 && [open, high, low, close, volume].every((value) => value !== null)
    && open > 0 && close > 0 && high >= Math.max(open, close) && low <= Math.min(open, close) && volume >= 0
    ? { time, open, high, low, close, volume, empty: false } : null;
}

export function normalizeAsterTrade(row) {
  const id = row?.a ?? row?.id;
  const price = numeric(row?.p ?? row?.price);
  const amount = numeric(row?.q ?? row?.qty);
  const time = Math.floor(Number(row?.T ?? row?.time) / 1000);
  if (id == null || !Number.isSafeInteger(time) || time <= 0 || price === null || price <= 0 || amount === null || amount <= 0) return null;
  return { id: String(id), price, amount, time, side: (row?.m ?? row?.isBuyerMaker) ? 'sell' : 'buy' };
}

export function createAsterFeed({ storePath, onFrame = () => {}, fetcher = fetch, WebSocketImpl = WebSocket, now = Date.now }) {
  const db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS candles (interval TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (interval,time));');
  const put = db.prepare('INSERT INTO candles(interval,time,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?) ON CONFLICT(interval,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume');
  const range = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE interval=? AND time>=? AND time<? ORDER BY time');
  const recent = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE interval=? ORDER BY time DESC LIMIT 300');
  const latest = db.prepare('SELECT MAX(time) AS time FROM candles WHERE interval=?');
  const earliest = db.prepare('SELECT MIN(time) AS time FROM candles WHERE interval=?');
  const at = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE interval=? AND time=?');
  const bids = new Map(), asks = new Map();
  let overview = null, trades = [], socket = null, started = false, retry = 1000, syncing = null;
  let reconnectTimer, statsTimer, bookTimer, backfillTimer, heartbeatTimer;
  let lastWsAt = 0, lastCandleWrite = 0;
  const pair = 'PEARL/USDT';
  const contract = () => ({ coin: 'PEARL', pair, quote: 'USDT', example: false });
  const recordingSince = () => earliest.get('1m')?.time ?? null;
  const sorted = (map, descending, limit) => [...map].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).slice(0, limit).map(([price, amount]) => ({ price, amount }));
  const depth = (limit = 20) => ({ bids: sorted(bids, true, limit), asks: sorted(asks, false, limit) });
  const emitDepth = () => { updateOverview({ depth: depth() }); onFrame({ type: 'full-depth', depth: depth(200), updatedAt: now() }); };

  async function get(path) {
    const response = await fetcher(`${API}${path}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Aster HTTP ${response.status}`);
    return response.json();
  }
  function updateOverview(change) {
    const first = !overview;
    overview = { pair, price: null, stats24h: null, depth: depth(), trades, marketError: null, ...overview, ...change, updatedAt: now(), contract: contract(), recordingSince: recordingSince() };
    onFrame(first ? { type: 'overview', data: overview } : { type: 'overview-patch', data: { ...change, updatedAt: overview.updatedAt } });
  }
  function saveCandle(candle, emit = true) {
    const current = at.get('1m', candle.time);
    if (current && current.open === candle.open && current.high === candle.high && current.low === candle.low && current.close === candle.close && current.volume === candle.volume) return;
    put.run('1m', candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume);
    for (const [interval, seconds] of Object.entries(PERIODS)) {
      if (interval === '1m') continue;
      const time = bucket(candle.time, seconds);
      const rows = range.all('1m', time, time + seconds);
      if (rows.length) put.run(interval, time, rows[0].open, Math.max(...rows.map((row) => row.high)), Math.min(...rows.map((row) => row.low)), rows.at(-1).close, rows.reduce((sum, row) => sum + row.volume, 0));
    }
    if (emit) for (const [interval, seconds] of Object.entries(PERIODS)) {
      const row = at.get(interval, bucket(candle.time, seconds));
      if (row) onFrame({ type: 'candle', interval, candle: { ...row, empty: false }, updatedAt: now() });
    }
  }
  async function backfill() {
    if (syncing) return syncing;
    syncing = (async () => {
      const last = latest.get('1m')?.time;
      const startTime = last == null ? now() - 1000 * 60_000 : last * 1000;
      const rows = await get(`/klines?symbol=PEARLUSDT&interval=1m&startTime=${Math.max(0, Math.floor(startTime))}&limit=1000`);
      if (!Array.isArray(rows)) throw new Error('Aster candles invalid');
      for (const row of rows) { const candle = normalizeAsterCandle(row); if (candle) saveCandle(candle, false); }
    })().finally(() => { syncing = null; });
    return syncing;
  }
  async function refreshStats() {
    const [ticker, premium, interest] = await Promise.all([
      get('/ticker/24hr?symbol=PEARLUSDT'), get('/premiumIndex?symbol=PEARLUSDT'), get('/openInterest?symbol=PEARLUSDT'),
    ]);
    updateOverview({ price: numeric(ticker.lastPrice), stats24h: { high: numeric(ticker.highPrice), low: numeric(ticker.lowPrice), volume: numeric(ticker.volume), turnover: numeric(ticker.quoteVolume), changePercent: numeric(ticker.priceChangePercent) }, markPrice: numeric(premium.markPrice), oraclePrice: numeric(premium.indexPrice), funding: numeric(premium.lastFundingRate), openInterest: numeric(interest.openInterest) });
  }
  async function refreshBook() {
    const book = await get('/depth?symbol=PEARLUSDT&limit=500');
    if (!Array.isArray(book?.bids) || !Array.isArray(book?.asks)) throw new Error('Aster depth invalid');
    bids.clear(); asks.clear();
    for (const [map, rows] of [[bids, book.bids], [asks, book.asks]]) for (const [rawPrice, rawAmount] of rows) {
      const price = numeric(rawPrice), amount = numeric(rawAmount);
      if (price > 0 && amount > 0) map.set(price, amount);
    }
    emitDepth();
  }
  function applyTrades(rows) {
    const incoming = rows.map(normalizeAsterTrade).filter(Boolean);
    if (!incoming.length) return;
    const ids = new Set(incoming.map((row) => row.id));
    trades = [...incoming, ...trades.filter((row) => !ids.has(row.id))].sort((a, b) => b.time - a.time).slice(0, 20);
    updateOverview({ price: incoming.at(-1).price, trades });
    onFrame({ type: 'trades', trades: incoming, price: incoming.at(-1).price, updatedAt: now() });
  }
  function connect() {
    if (!started || socket) return;
    const current = new WebSocketImpl(STREAM, { handshakeTimeout: 12_000 });
    socket = current;
    current.on('open', () => { retry = 1000; lastWsAt = now(); });
    current.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      lastWsAt = now();
      const row = frame?.data;
      if (!row || row.s !== 'PEARLUSDT') return;
      if (row.e === 'kline') {
        const candle = normalizeAsterCandle(row.k);
        if (candle && (row.k.x || now() - lastCandleWrite > 1000)) { lastCandleWrite = now(); saveCandle(candle); }
      } else if (row.e === 'aggTrade') applyTrades([row]);
      else if (row.e === '24hrTicker') updateOverview({ price: numeric(row.c), stats24h: { high: numeric(row.h), low: numeric(row.l), volume: numeric(row.v), turnover: numeric(row.q), changePercent: numeric(row.P) } });
      else if (row.e === 'markPriceUpdate') updateOverview({ markPrice: numeric(row.p), oraclePrice: numeric(row.i), funding: numeric(row.r) });
    });
    current.on('error', (error) => console.warn('Aster WS:', error.message));
    current.on('close', () => {
      if (socket !== current) return;
      socket = null;
      if (!started) return;
      reconnectTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
  }
  async function start() {
    if (started) return;
    started = true;
    try {
      const market = await get('/exchangeInfo');
      if (!market.symbols?.some((row) => row.symbol === 'PEARLUSDT' && row.status === 'TRADING' && row.contractType === 'PERPETUAL')) throw new Error('Aster PEARLUSDT perpetual unavailable');
    } catch (error) {
      started = false;
      throw error;
    }
    await Promise.allSettled([refreshStats(), refreshBook(), backfill(), get('/trades?symbol=PEARLUSDT&limit=20').then((rows) => { if (Array.isArray(rows)) applyTrades(rows); })]);
    connect();
    statsTimer = setInterval(() => { void refreshStats().catch((error) => console.warn('Aster stats:', error.message)); }, 30_000);
    bookTimer = setInterval(() => { void refreshBook().catch((error) => console.warn('Aster depth:', error.message)); }, 15_000);
    backfillTimer = setInterval(() => { void backfill().catch((error) => console.warn('Aster backfill:', error.message)); }, 60_000);
    heartbeatTimer = setInterval(() => { if (socket?.readyState === WebSocketImpl.OPEN) { socket.ping(); if (now() - lastWsAt > 90_000) socket.terminate(); } else connect(); }, 30_000);
  }
  function stop() {
    started = false;
    clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(bookTimer); clearInterval(backfillTimer); clearInterval(heartbeatTimer);
    socket?.terminate(); socket = null; db.close();
  }
  function getOverview() {
    return overview ?? { pair, price: null, stats24h: null, depth: depth(), trades, marketError: '等待实时行情', updatedAt: now(), contract: contract(), recordingSince: recordingSince() };
  }
  function getCandles(interval) {
    if (!PERIODS[interval]) throw new Error('Unsupported interval');
    return { pair, interval, candles: recent.all(interval).reverse().map((row) => ({ ...row, empty: false })), updatedAt: now(), source: 'recorded', recordingSince: recordingSince() };
  }
  return { start, stop, getOverview, getCandles, getFullDepth: () => depth(200), contract };
}
