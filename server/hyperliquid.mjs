import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const PERIODS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const INFO = 'https://api.hyperliquid.xyz/info';
const WS = 'wss://api.hyperliquid.xyz/ws';
const number = (value) => { if (value == null || value === '') return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
const bucket = (time, seconds) => Math.floor(time / seconds) * seconds;

export function normalizeHlCandle(row) {
  const time = Math.floor(Number(row?.t) / 1000);
  const open = number(row?.o), high = number(row?.h), low = number(row?.l), close = number(row?.c), volume = number(row?.v);
  return Number.isFinite(time) && [open, high, low, close, volume].every((item) => item !== null)
    && high >= low && volume >= 0 ? { time, open, high, low, close, volume, empty: false } : null;
}

export function createHyperliquidFeed({ storePath, coin = 'BTC', dex = '', quote = 'USDC', onFrame = () => {}, fetcher = fetch, WebSocketImpl = WebSocket, now = Date.now }) {
  const db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS candles (coin TEXT NOT NULL, interval TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (coin,interval,time))');
  const insert = db.prepare('INSERT INTO candles (coin,interval,time,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(coin,interval,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume');
  const latest = db.prepare('SELECT MAX(time) AS time FROM candles WHERE coin=? AND interval=?');
  const earliest = db.prepare('SELECT MIN(time) AS time FROM candles WHERE coin=? AND interval=?');
  const range = db.prepare('SELECT * FROM candles WHERE coin=? AND interval=? AND time>=? AND time<? ORDER BY time');
  const recent = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE coin=? AND interval=? ORDER BY time DESC LIMIT 300');
  let socket, reconnectTimer, validationTimer, heartbeatTimer, backfillTimer, ctxTimer, started = false, retry = 1000;
  let contract = null, overview = null, depth = { asks: [], bids: [] }, trades = [];
  let lastCtx = null, lastCandleTime = 0, lastWsAt = 0, syncing = null;
  const pair = () => `${coin}/${quote}`;
  const recordingSince = () => earliest.get(coin, '1m')?.time ?? null;
  const send = (frame) => onFrame(frame);

  async function info(body) {
    const response = await fetcher(INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
    return response.json();
  }

  async function validateContract() {
    const [meta, contexts] = await info({ type: 'metaAndAssetCtxs', ...(dex ? { dex } : {}) });
    const index = meta?.universe?.findIndex((item) => item.name === coin);
    if (index < 0 || meta.universe[index].isDelisted) throw new Error(`Hyperliquid contract ${coin} unavailable or delisted`);
    contract = { coin, pair: pair(), quote, dex: dex || null, example: coin === 'BTC', szDecimals: meta.universe[index].szDecimals };
    applyContext(contexts[index]);
  }

  function applyContext(ctx) {
    if (!ctx) return;
    lastCtx = ctx;
    const price = number(ctx.midPx) ?? number(ctx.markPx);
    const previous = number(ctx.prevDayPx);
    const stats24h = { high: null, low: null, volume: number(ctx.dayBaseVlm), turnover: number(ctx.dayNtlVlm), changePercent: price !== null && previous ? (price / previous - 1) * 100 : null };
    overview = { pair: pair(), price, stats24h, depth, trades, marketError: null, updatedAt: now(), contract, markPrice: number(ctx.markPx), oraclePrice: number(ctx.oraclePx), funding: number(ctx.funding), openInterest: number(ctx.openInterest), recordingSince: recordingSince() };
    send({ type: 'overview-patch', data: { pair: overview.pair, price, stats24h, contract, markPrice: overview.markPrice, oraclePrice: overview.oraclePrice, funding: overview.funding, openInterest: overview.openInterest, updatedAt: overview.updatedAt } });
  }

  function saveCandle(candle, emit = true) {
    db.exec('BEGIN');
    try {
      insert.run(coin, '1m', candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume);
      for (const [interval, seconds] of Object.entries(PERIODS)) {
        if (interval === '1m') continue;
        const start = bucket(candle.time, seconds);
        const rows = range.all(coin, '1m', start, start + seconds);
        if (!rows.length) continue;
        insert.run(coin, interval, start, rows[0].open, Math.max(...rows.map((row) => row.high)), Math.min(...rows.map((row) => row.low)), rows.at(-1).close, rows.reduce((sum, row) => sum + row.volume, 0));
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    lastCandleTime = Math.max(lastCandleTime, candle.time);
    if (!emit) return;
    for (const [interval, seconds] of Object.entries(PERIODS)) {
      const time = bucket(candle.time, seconds);
      const row = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE coin=? AND interval=? AND time=?').get(coin, interval, time);
      if (row) send({ type: 'candle', interval, candle: { ...row, empty: false }, updatedAt: now() });
    }
  }

  async function backfill() {
    if (syncing) return syncing;
    syncing = (async () => {
      const endTime = now();
      const last = latest.get(coin, '1m')?.time;
      const startTime = last ? Math.max((last - 2 * 60) * 1000, endTime - 5000 * 60_000) : endTime - 5000 * 60_000;
      const data = await info({ type: 'candleSnapshot', req: { coin, interval: '1m', startTime, endTime } });
      if (!Array.isArray(data)) throw new Error('Invalid Hyperliquid candles');
      for (const row of data) {
        const candle = normalizeHlCandle(row);
        if (candle) saveCandle(candle, false);
      }
      for (const interval of Object.keys(PERIODS)) {
        const row = recent.all(coin, interval)[0];
        if (row) send({ type: 'candle', interval, candle: { ...row, empty: false }, updatedAt: now() });
      }
      const after = latest.get(coin, '1m')?.time;
      if (last && after && after - last > 5000 * 60 + 120) console.warn('Hyperliquid candle gap exceeds provider history');
    })().finally(() => { syncing = null; });
    return syncing;
  }

  function updateDepth(data) {
    const levels = data?.levels;
    if (!Array.isArray(levels) || levels.length < 2) return;
    const parse = (side) => side.slice(0, 20).map((item) => ({ price: number(item.px), amount: number(item.sz) })).filter((item) => Number.isFinite(item.price) && Number.isFinite(item.amount));
    depth = { bids: parse(levels[0]), asks: parse(levels[1]) };
    if (overview) { overview = { ...overview, depth, updatedAt: now() }; send({ type: 'overview-patch', data: { depth, updatedAt: overview.updatedAt } }); }
    send({ type: 'full-depth', depth, updatedAt: now() });
  }

  function updateTrades(data) {
    if (!Array.isArray(data)) return;
    const incoming = data.map((item) => ({ id: String(item.tid), time: Math.floor(Number(item.time) / 1000), price: number(item.px), amount: number(item.sz), side: item.side === 'B' ? 'buy' : 'sell' })).filter((item) => item.price !== null && item.amount !== null && Number.isFinite(item.time));
    if (!incoming.length) return;
    const ids = new Set(incoming.map((item) => item.id));
    trades = [...incoming, ...trades.filter((item) => !ids.has(item.id))].sort((a, b) => b.time - a.time).slice(0, 20);
    if (overview) overview = { ...overview, trades, price: incoming.at(-1).price, updatedAt: now() };
    send({ type: 'trades', trades: incoming, price: incoming.at(-1).price, updatedAt: now() });
  }

  function connect() {
    if (!started || socket) return;
    const current = new WebSocketImpl(WS);
    socket = current;
    current.on('open', () => {
      retry = 1000;
      lastWsAt = now();
      for (const subscription of [{ type: 'candle', coin, interval: '1m' }, { type: 'l2Book', coin }, { type: 'trades', coin }, { type: 'activeAssetCtx', coin }]) current.send(JSON.stringify({ method: 'subscribe', subscription }));
      void backfill().catch((error) => console.warn('Hyperliquid backfill:', error.message));
    });
    current.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      lastWsAt = now();
      if (frame.channel === 'candle') { const candle = normalizeHlCandle(frame.data); if (candle) saveCandle(candle); }
      else if (frame.channel === 'l2Book') updateDepth(frame.data);
      else if (frame.channel === 'trades') updateTrades(frame.data);
      else if (frame.channel === 'activeAssetCtx') applyContext(frame.data?.ctx ?? frame.data);
    });
    current.on('error', (error) => console.warn('Hyperliquid WS:', error.message));
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
    const validateAndConnect = async () => {
      if (!started) return;
      try {
        await validateContract();
        if (!started) return;
        connect();
        void backfill().catch((error) => console.warn('Hyperliquid backfill:', error.message));
      } catch (error) {
        console.warn('Hyperliquid contract validation:', error.message);
        validationTimer = setTimeout(validateAndConnect, retry);
        retry = Math.min(retry * 2, 30_000);
      }
    };
    void validateAndConnect();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) return;
      if (now() - lastWsAt > 20_000) socket.send(JSON.stringify({ method: 'ping' }));
      if (now() - lastWsAt > 65_000) socket.terminate();
    }, 10_000);
    backfillTimer = setInterval(() => { void backfill().catch((error) => console.warn('Hyperliquid backfill:', error.message)); }, 120_000);
    ctxTimer = setInterval(() => { void validateContract().catch((error) => console.warn('Hyperliquid context:', error.message)); }, 60_000);
  }

  function stop() {
    started = false;
    clearTimeout(reconnectTimer); clearTimeout(validationTimer); clearInterval(heartbeatTimer); clearInterval(backfillTimer); clearInterval(ctxTimer);
    socket?.terminate(); socket = null;
    db.close();
  }

  function getOverview() {
    if (!contract) throw new Error('Contract not validated');
    return overview ?? { pair: pair(), price: null, stats24h: null, depth, trades, marketError: '等待实时行情', updatedAt: now(), contract, recordingSince: recordingSince() };
  }

  function getCandles(interval) {
    if (!PERIODS[interval]) throw new Error('Unsupported interval');
    const candles = recent.all(coin, interval).reverse().map((row) => ({ ...row, empty: false }));
    return { pair: pair(), interval, candles, updatedAt: now(), source: 'recorded', recordingSince: recordingSince(), syncedThrough: latest.get(coin, '1m')?.time ?? null };
  }

  return { start, stop, getOverview, getCandles, getFullDepth: () => depth, backfill, contract: () => contract };
}
