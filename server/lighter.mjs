import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const API = 'https://mainnet.zklighter.elliot.ai/api/v1';
const STREAM = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
const PERIODS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const number = (value) => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const bucket = (time, seconds) => Math.floor(time / seconds) * seconds;

export function normalizeLighterCandle(row) {
  const time = Math.floor(Number(row?.t) / 1000);
  const open = number(row?.o), high = number(row?.h), low = number(row?.l), close = number(row?.c), volume = number(row?.v);
  return Number.isFinite(time) && [open, high, low, close, volume].every((item) => item !== null)
    && high >= Math.max(open, close) && low <= Math.min(open, close) && low >= 0 && volume >= 0
    ? { time, open, high, low, close, volume, empty: false } : null;
}

export function normalizeLighterTrade(row) {
  const price = number(row?.price), amount = number(row?.size), timestamp = number(row?.timestamp);
  const id = row?.trade_id_str ?? row?.trade_id;
  if (id == null || price === null || price <= 0 || amount === null || amount <= 0 || timestamp === null) return null;
  return { id: String(id), price, amount, time: Math.floor(timestamp / 1000), side: row.is_maker_ask ? 'buy' : 'sell' };
}

export function createLighterFeed({ storePath, symbol = 'PRL', quote = 'USDC', onFrame = () => {}, fetcher = fetch, WebSocketImpl = WebSocket, now = Date.now }) {
  const db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS candles (market_id INTEGER NOT NULL, interval TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, empty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (market_id,interval,time)); CREATE TABLE IF NOT EXISTS sync (market_id INTEGER PRIMARY KEY, through INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO candles (market_id,interval,time,open,high,low,close,volume,empty) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(market_id,interval,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,empty=excluded.empty');
  const range = db.prepare('SELECT time,open,high,low,close,volume,empty FROM candles WHERE market_id=? AND interval=? AND time>=? AND time<? ORDER BY time');
  const at = db.prepare('SELECT time,open,high,low,close,volume,empty FROM candles WHERE market_id=? AND interval=? AND time=?');
  const recent = db.prepare('SELECT time,open,high,low,close,volume,empty FROM candles WHERE market_id=? AND interval=? ORDER BY time DESC LIMIT 300');
  const earliest = db.prepare('SELECT MIN(time) AS time FROM candles WHERE market_id=? AND interval=?');
  const previousMinute = db.prepare('SELECT time,close FROM candles WHERE market_id=? AND interval=? AND time<? ORDER BY time DESC LIMIT 1');
  const syncGet = db.prepare('SELECT through FROM sync WHERE market_id=?');
  const syncPut = db.prepare('INSERT INTO sync(market_id,through) VALUES (?,?) ON CONFLICT(market_id) DO UPDATE SET through=excluded.through');
  let market = null, overview = null, trades = [], socket = null, started = false, retry = 1000;
  let reconnectTimer, refreshTimer, backfillTimer, heartbeatTimer, depthTimer;
  let lastWsAt = 0, syncing = null, bookNonce = null, bookReady = false;
  const bids = new Map(), asks = new Map();
  const pair = () => `${symbol}/${quote}`;
  const recordingSince = () => market ? earliest.get(market.market_id, '1m')?.time ?? null : null;
  const depth = () => ({
    bids: [...bids].sort((a, b) => b[0] - a[0]).slice(0, 20).map(([price, amount]) => ({ price, amount })),
    asks: [...asks].sort((a, b) => a[0] - b[0]).slice(0, 20).map(([price, amount]) => ({ price, amount })),
  });
  const fullDepth = () => ({
    bids: [...bids].sort((a, b) => b[0] - a[0]).slice(0, 200).map(([price, amount]) => ({ price, amount })),
    asks: [...asks].sort((a, b) => a[0] - b[0]).slice(0, 200).map(([price, amount]) => ({ price, amount })),
  });

  async function get(path) {
    const response = await fetcher(`${API}${path}`, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Lighter HTTP ${response.status}`);
    const data = await response.json();
    if (data?.code !== 200) throw new Error(`Lighter API ${data?.code ?? 'invalid response'}`);
    return data;
  }

  function updateOverview(change) {
    const first = !overview;
    overview = { pair: pair(), price: null, stats24h: null, depth: depth(), trades, marketError: null, updatedAt: now(),
      ...overview, ...change, updatedAt: now(), contract: market && { coin: symbol, pair: pair(), quote, marketId: market.market_id, example: false }, recordingSince: recordingSince() };
    onFrame(first ? { type: 'overview', data: overview } : { type: 'overview-patch', data: { ...change, updatedAt: overview.updatedAt } });
  }

  function applyStats(row) {
    if (!row || Number(row.market_id) !== market?.market_id) return;
    const price = number(row.last_trade_price) ?? number(row.mid_price) ?? number(row.mark_price);
    const fundingPercent = number(row.current_funding_rate);
    updateOverview({ price, stats24h: { high: number(row.daily_price_high), low: number(row.daily_price_low), volume: number(row.daily_base_token_volume), turnover: number(row.daily_quote_token_volume), changePercent: number(row.daily_price_change) }, markPrice: number(row.mark_price), oraclePrice: number(row.index_price), funding: fundingPercent === null ? overview?.funding ?? null : fundingPercent / 100, openInterest: number(row.open_interest) });
  }

  async function validateMarket() {
    const data = await get(market ? `/orderBookDetails?market_id=${market.market_id}` : '/orderBookDetails');
    const found = data.order_book_details?.find((row) => row.symbol === symbol && row.market_type === 'perp' && row.status === 'active' && !row.is_frozen);
    if (!found || !Number.isInteger(found.market_id)) throw new Error(`Lighter ${symbol} perpetual unavailable`);
    if (market && market.market_id !== found.market_id) { bids.clear(); asks.clear(); bookReady = false; bookNonce = null; trades = []; overview = null; socket?.close(); }
    market = found;
    applyStats(found);
  }

  function saveCandle(candle, emit = true) {
    if (!market) return;
    const id = market.market_id;
    db.exec('BEGIN');
    try {
      insert.run(id, '1m', candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.empty ? 1 : 0);
      for (const [interval, seconds] of Object.entries(PERIODS)) {
        if (interval === '1m') continue;
        const time = bucket(candle.time, seconds);
        const rows = range.all(id, '1m', time, time + seconds);
        if (rows.length) insert.run(id, interval, time, rows[0].open, Math.max(...rows.map((row) => row.high)), Math.min(...rows.map((row) => row.low)), rows.at(-1).close, rows.reduce((sum, row) => sum + row.volume, 0), rows.every((row) => row.empty) ? 1 : 0);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (emit) for (const [interval, seconds] of Object.entries(PERIODS)) {
      const row = at.get(id, interval, bucket(candle.time, seconds));
      if (row) onFrame({ type: 'candle', interval, candle: { ...row, empty: !!row.empty }, updatedAt: now() });
    }
  }

  async function backfill() {
    if (!market) return;
    if (syncing) return syncing;
    const id = market.market_id;
    syncing = (async () => {
      const end = Math.floor(now() / 1000 / 60) * 60;
      let through = syncGet.get(id)?.through ?? end - 480 * 60;
      for (let page = 0; page < 3 && through < end; page++) {
        const start = Math.max(0, through - 120);
        const stop = Math.min(through + 480 * 60, end);
        const query = new URLSearchParams({ market_id: String(id), resolution: '1m', start_timestamp: String(start), end_timestamp: String(stop), count_back: '500' });
        const data = await get(`/candles?${query}`);
        if (!Array.isArray(data.c)) throw new Error('Invalid Lighter candles');
        const rows = new Map(data.c.map(normalizeLighterCandle).filter(Boolean).map((row) => [row.time, row]));
        let previous = previousMinute.get(id, '1m', start)?.close ?? null;
        for (let time = bucket(start, 60); time < stop; time += 60) {
          const real = rows.get(time);
          const existing = at.get(id, '1m', time);
          if (real) { saveCandle(real, false); previous = real.close; }
          else if (existing) previous = existing.close;
          else if (previous !== null) saveCandle({ time, open: previous, high: previous, low: previous, close: previous, volume: 0, empty: true }, false);
        }
        through = stop;
        syncPut.run(id, through);
      }
      for (const interval of Object.keys(PERIODS)) {
        const row = recent.all(id, interval)[0];
        if (row) onFrame({ type: 'candle', interval, candle: { ...row, empty: !!row.empty }, updatedAt: now() });
      }
    })().finally(() => { syncing = null; });
    return syncing;
  }

  function applyBook(frame) {
    const data = frame?.order_book;
    if (!data || !Array.isArray(data.asks) || !Array.isArray(data.bids)) return;
    const snapshot = frame.type === 'subscribed/order_book';
    if (!snapshot && (!bookReady || data.begin_nonce !== bookNonce)) { bookReady = false; socket?.close(); return; }
    if (snapshot) { asks.clear(); bids.clear(); }
    const update = (map, rows) => { for (const row of rows) { const price = number(row.price), amount = number(row.size); if (price === null || amount === null || price <= 0 || amount < 0) continue; if (amount === 0) map.delete(price); else map.set(price, amount); } };
    update(asks, data.asks); update(bids, data.bids);
    bookNonce = data.nonce; bookReady = true;
    clearTimeout(depthTimer);
    depthTimer = setTimeout(() => { updateOverview({ depth: depth() }); onFrame({ type: 'full-depth', depth: fullDepth(), updatedAt: now() }); }, 250);
  }

  function applyTrades(rows) {
    if (!Array.isArray(rows)) return;
    const incoming = rows.map(normalizeLighterTrade).filter(Boolean);
    if (!incoming.length) return;
    const ids = new Set(incoming.map((row) => row.id));
    trades = [...incoming, ...trades.filter((row) => !ids.has(row.id))].sort((a, b) => b.time - a.time).slice(0, 20);
    const latest = incoming.reduce((current, row) => row.time >= current.time ? row : current);
    updateOverview({ trades, price: latest.price });
    onFrame({ type: 'trades', trades: incoming, price: latest.price, updatedAt: now() });
  }

  async function refresh() {
    await validateMarket();
    if (socket?.readyState === WebSocketImpl.OPEN) return;
    const id = market.market_id;
    const [book, recentTrades] = await Promise.all([
      get(`/orderBookOrders?market_id=${id}&limit=200`), get(`/recentTrades?market_id=${id}&limit=20`),
    ]);
    bids.clear(); asks.clear();
    for (const [map, rows] of [[bids, book.bids], [asks, book.asks]]) for (const row of rows ?? []) {
      const price = number(row.price), amount = number(row.remaining_base_amount);
      if (price !== null && amount !== null && price > 0 && amount > 0) map.set(price, (map.get(price) ?? 0) + amount);
    }
    applyTrades(recentTrades.trades);
    updateOverview({ depth: depth() });
    onFrame({ type: 'full-depth', depth: fullDepth(), updatedAt: now() });
  }

  function connect() {
    if (!started || !market || socket) return;
    const current = new WebSocketImpl(STREAM);
    socket = current;
    current.on('open', () => {
      retry = 1000; lastWsAt = now(); bookReady = false; bookNonce = null;
      for (const channel of [`candle/${market.market_id}/1m`, `market_stats/${market.market_id}`, `order_book/${market.market_id}`, `trade/${market.market_id}`]) current.send(JSON.stringify({ type: 'subscribe', channel }));
      void backfill().catch((error) => console.warn('Lighter backfill:', error.message));
    });
    current.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      lastWsAt = now();
      if (frame.channel === `candle:${market.market_id}:1m` && Array.isArray(frame.candles)) for (const row of frame.candles) { const candle = normalizeLighterCandle(row); if (candle) saveCandle(candle); }
      else if (frame.channel === `market_stats:${market.market_id}`) applyStats(frame.market_stats);
      else if (frame.channel === `order_book:${market.market_id}`) applyBook(frame);
      else if (frame.channel === `trade:${market.market_id}`) applyTrades(frame.trades);
    });
    current.on('error', (error) => console.warn('Lighter WS:', error.message));
    current.on('close', () => {
      if (socket !== current) return;
      socket = null; bookReady = false;
      if (!started) return;
      reconnectTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30_000);
    });
  }

  async function start() {
    if (started) return;
    started = true;
    try { await refresh(); connect(); void backfill().catch((error) => console.warn('Lighter backfill:', error.message)); }
    catch (error) { console.warn('Lighter start:', error.message); reconnectTimer = setTimeout(() => { if (started) void startRetry(); }, retry); }
    refreshTimer = setInterval(() => { void refresh().catch((error) => console.warn('Lighter refresh:', error.message)); }, 30_000);
    backfillTimer = setInterval(() => { void backfill().catch((error) => console.warn('Lighter backfill:', error.message)); }, 120_000);
    heartbeatTimer = setInterval(() => { if (socket?.readyState === WebSocketImpl.OPEN) { socket.ping(); if (now() - lastWsAt > 90_000) socket.terminate(); } else connect(); }, 30_000);
  }

  async function startRetry() {
    try { await refresh(); connect(); }
    catch (error) { console.warn('Lighter retry:', error.message); retry = Math.min(retry * 2, 30_000); reconnectTimer = setTimeout(startRetry, retry); }
  }

  function stop() {
    started = false;
    clearTimeout(reconnectTimer); clearTimeout(depthTimer); clearInterval(refreshTimer); clearInterval(backfillTimer); clearInterval(heartbeatTimer);
    socket?.terminate(); socket = null;
    db.close();
  }

  function getOverview() {
    if (!market) throw new Error('Lighter PRL contract not validated');
    return overview ?? { pair: pair(), price: null, stats24h: null, depth: depth(), trades, marketError: '等待实时行情', updatedAt: now(), contract: { coin: symbol, pair: pair(), quote, marketId: market.market_id, example: false }, recordingSince: recordingSince() };
  }

  function getCandles(interval) {
    if (!PERIODS[interval]) throw new Error('Unsupported interval');
    if (!market) throw new Error('Lighter PRL contract not validated');
    return { pair: pair(), interval, candles: recent.all(market.market_id, interval).reverse().map((row) => ({ ...row, empty: !!row.empty })), updatedAt: now(), source: 'recorded', recordingSince: recordingSince(), syncedThrough: syncGet.get(market.market_id)?.through ?? null };
  }

  return { start, stop, refresh, backfill, getOverview, getCandles, getFullDepth: fullDepth, contract: () => market && { coin: symbol, pair: pair(), quote, marketId: market.market_id, example: false } };
}
