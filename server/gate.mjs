import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';

const API = 'https://api.gateio.ws/api/v4/spot';
const STREAM = 'wss://api.gateio.ws/ws/v4/';
const PAIR = 'PEARL_USDT';
const PERIODS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const numeric = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export function normalizeGateCandle(row) {
  const time = numeric(Array.isArray(row) ? row[0] : row?.t);
  const open = numeric(Array.isArray(row) ? row[5] : row?.o);
  const high = numeric(Array.isArray(row) ? row[3] : row?.h);
  const low = numeric(Array.isArray(row) ? row[4] : row?.l);
  const close = numeric(Array.isArray(row) ? row[2] : row?.c);
  // Gate's v / REST index 1 is USDT turnover; a / index 6 is PEARL volume.
  const volume = numeric(Array.isArray(row) ? row[6] : row?.a);
  return Number.isSafeInteger(time) && time > 0 && [open, high, low, close, volume].every((value) => value !== null)
    && low > 0 && high >= Math.max(open, close, low) && low <= Math.min(open, close) && volume >= 0
    ? { time, open, high, low, close, volume, empty: false } : null;
}

export function normalizeGateTrade(row) {
  if (row?.currency_pair && row.currency_pair !== PAIR) return null;
  const price = numeric(row?.price), amount = numeric(row?.amount);
  const time = Math.floor(row?.create_time_ms != null ? Number(row.create_time_ms) / 1000 : Number(row?.create_time));
  if (row?.id == null || !Number.isSafeInteger(time) || time <= 0 || price === null || price <= 0
    || amount === null || amount <= 0 || !['buy', 'sell'].includes(row?.side)) return null;
  return { id: String(row.id), price, amount, time, side: row.side };
}

export function normalizeGateTicker(row) {
  if (row?.currency_pair !== PAIR) return null;
  return { price: numeric(row.last), stats24h: { high: numeric(row.high_24h), low: numeric(row.low_24h),
    volume: numeric(row.base_volume), turnover: numeric(row.quote_volume), changePercent: numeric(row.change_percentage) } };
}

export function createGateFeed({ storePath, onFrame = () => {}, fetcher = fetch, WebSocketImpl = WebSocket, now = Date.now }) {
  const db = new DatabaseSync(storePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS candles (interval TEXT NOT NULL,time INTEGER NOT NULL,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,volume REAL NOT NULL,PRIMARY KEY(interval,time)); CREATE TABLE IF NOT EXISTS sync_progress (interval TEXT PRIMARY KEY, through INTEGER NOT NULL);');
  const put = db.prepare('INSERT INTO candles VALUES(?,?,?,?,?,?,?) ON CONFLICT(interval,time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume');
  const at = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE interval=? AND time=?');
  const progress = db.prepare('SELECT through FROM sync_progress WHERE interval=?');
  const saveProgress = db.prepare('INSERT INTO sync_progress VALUES(?,?) ON CONFLICT(interval) DO UPDATE SET through=excluded.through');
  const recent = db.prepare('SELECT time,open,high,low,close,volume FROM candles WHERE interval=? ORDER BY time DESC LIMIT 300');
  const first = db.prepare('SELECT MIN(time) AS time FROM candles');
  const bids = new Map(), asks = new Map(), liveCandleVersions = new Map();
  let overview = null, trades = [], started = false, closed = false, socket = null, retry = 1000, listingTime = 0;
  let lastWsAt = 0, bookId = null, bookEpoch = 0, bookMode = null, bookSyncing = null, candleSyncing = null;
  let reconnectTimer, statsTimer, bookTimer, candleTimer, heartbeatTimer, candleRevision = 0, priceRevision = 0;
  const contract = () => ({ coin: 'PEARL', pair: 'PEARL/USDT', quote: 'USDT', example: false });
  const recordingSince = () => first.get()?.time ?? null;
  const sorted = (map, descending, limit) => [...map].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).slice(0, limit).map(([price, amount]) => ({ price, amount }));
  const depth = (limit = 400) => ({ bids: sorted(bids, true, limit), asks: sorted(asks, false, limit) });

  async function get(path) {
    // Ask for current public data when the REST fallback is needed.
    const fresh = /^\/(order_book|tickers|trades)\?/.test(path) ? `&_t=${now()}` : '';
    const response = await fetcher(`${API}${path}${fresh}`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Gate HTTP ${response.status}`);
    return response.json();
  }
  function updateOverview(change) {
    if (closed) return;
    if (change.price != null) priceRevision++;
    const initial = !overview;
    overview = { pair: 'PEARL/USDT', price: null, stats24h: null, depth: depth(20), trades, marketError: null,
      ...overview, ...change, updatedAt: now(), contract: contract(), recordingSince: recordingSince() };
    onFrame(initial ? { type: 'overview', data: overview } : { type: 'overview-patch', data: { ...change, updatedAt: overview.updatedAt } });
  }
  function saveCandle(interval, candle, emit = true) {
    if (closed) return;
    const current = at.get(interval, candle.time);
    if (current && ['open', 'high', 'low', 'close', 'volume'].every((field) => current[field] === candle[field])) return;
    put.run(interval, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume);
    if (emit) onFrame({ type: 'candle', interval, candle, updatedAt: now() });
  }
  async function backfill() {
    if (candleSyncing) return candleSyncing;
    candleSyncing = (async () => {
      for (const [interval, seconds] of Object.entries(PERIODS)) {
        const end = Math.floor(now() / 1000);
        let from = progress.get(interval)?.through ?? Math.floor((listingTime || end - 1000 * seconds) / seconds) * seconds;
        // Bounded catch-up resumes from the persisted last candle on the next pass.
        for (let page = 0; page < 4 && from <= end && !closed; page++) {
          const to = Math.min(end, from + 999 * seconds);
          const revision = candleRevision;
          const rows = await get(`/candlesticks?currency_pair=${PAIR}&interval=${interval}&from=${from}&to=${to}`);
          if (!Array.isArray(rows)) throw new Error('Gate candles invalid');
          for (const row of rows) {
            const candle = normalizeGateCandle(row);
            if (candle && (liveCandleVersions.get(`${interval}:${candle.time}`) ?? 0) <= revision) saveCandle(interval, candle, false);
          }
          if (closed) return;
          saveProgress.run(interval, Math.floor(to / seconds) * seconds);
          if (to === end) break;
          from = to + seconds;
        }
        if (closed) return;
        const row = recent.all(interval)[0];
        if (row) onFrame({ type: 'candle', interval, candle: { ...row, empty: false }, updatedAt: now() });
      }
    })().finally(() => { candleSyncing = null; });
    return candleSyncing;
  }
  function emitDepth() {
    updateOverview({ depth: depth(20), marketError: null });
    onFrame({ type: 'full-depth', depth: depth(), updatedAt: now() });
  }
  function applyLevels(map, rows) {
    for (const [rawPrice, rawAmount] of rows ?? []) {
      const price = numeric(rawPrice), amount = numeric(rawAmount);
      if (price === null || price <= 0 || amount === null || amount < 0) continue;
      if (amount === 0) map.delete(price); else map.set(price, amount);
    }
  }
  function applyBookUpdate(row) {
    if (row?.s !== `ob.${PAIR}.400` || !Number.isSafeInteger(row.u)
      || (row.b != null && !Array.isArray(row.b)) || (row.a != null && !Array.isArray(row.a))) return;
    if (row.full === true) {
      bids.clear(); asks.clear(); applyLevels(bids, row.b); applyLevels(asks, row.a);
      bookId = row.u; bookMode = 'ws'; emitDepth();
      return;
    }
    if (bookMode === 'ws' && row.u <= bookId) return;
    if (bookMode !== 'ws' || !Number.isSafeInteger(row.U) || row.U !== bookId + 1 || row.u < row.U) {
      bookId = null; bookMode = null;
      updateOverview({ marketError: 'Gate 盘口正在同步' });
      // V2 sends a fresh complete snapshot on every new subscription.
      socket?.close();
      return;
    }
    applyLevels(bids, row.b); applyLevels(asks, row.a);
    bookId = row.u;
    for (const [map, descending] of [[bids, true], [asks, false]]) {
      const retained = [...map.keys()].sort((a, b) => descending ? b - a : a - b).slice(0, 400);
      const keep = new Set(retained);
      for (const price of map.keys()) if (!keep.has(price)) map.delete(price);
    }
    emitDepth();
  }
  async function refreshBook() {
    if (bookSyncing) return bookSyncing;
    const epoch = bookEpoch;
    bookSyncing = get(`/order_book?currency_pair=${PAIR}&limit=1000&with_id=true`).then((book) => {
      if (closed || epoch !== bookEpoch || bookMode === 'ws') return;
      if (!Number.isSafeInteger(book?.id) || !Array.isArray(book.bids) || !Array.isArray(book.asks)) throw new Error('Gate depth invalid');
      bids.clear(); asks.clear(); applyLevels(bids, book.bids); applyLevels(asks, book.asks);
      bookId = book.id; bookMode = 'rest'; emitDepth();
    }).finally(() => { bookSyncing = null; });
    return bookSyncing;
  }
  async function refreshStats() {
    const revision = priceRevision;
    const rows = await get(`/tickers?currency_pair=${PAIR}`);
    const ticker = normalizeGateTicker(Array.isArray(rows) ? rows[0] : null);
    if (ticker && revision === priceRevision) updateOverview(ticker);
  }
  function applyTrades(rows) {
    const incoming = rows.map(normalizeGateTrade).filter(Boolean);
    if (!incoming.length || closed) return;
    const ids = new Set(incoming.map((row) => row.id));
    trades = [...incoming, ...trades.filter((row) => !ids.has(row.id))].sort((a, b) => b.time - a.time || Number(b.id) - Number(a.id)).slice(0, 20);
    updateOverview({ trades, price: trades[0].price });
    onFrame({ type: 'trades', trades: incoming, price: trades[0].price, updatedAt: now() });
  }
  function connect() {
    if (!started || socket) return;
    const current = new WebSocketImpl(STREAM, { handshakeTimeout: 12_000 });
    socket = current;
    current.on('open', () => {
      retry = 1000; lastWsAt = now(); bookEpoch++; bookId = null; bookMode = null;
      const subscribe = (channel, payload) => current.send(JSON.stringify({ time: Math.floor(now() / 1000), channel, event: 'subscribe', payload }));
      subscribe('spot.tickers', [PAIR]); subscribe('spot.trades', [PAIR]);
      subscribe('spot.obu', [`ob.${PAIR}.400`]);
      for (const interval of Object.keys(PERIODS)) subscribe('spot.candlesticks', [interval, PAIR]);
      void refreshBook().catch((error) => console.warn('Gate depth:', error.message));
    });
    current.on('message', (raw) => {
      if (socket !== current || closed) return;
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      lastWsAt = now();
      if (frame.error) { console.warn('Gate subscription:', frame.error.message); current.close(); return; }
      if (frame.event !== 'update' && !(frame.channel === 'spot.obu' && frame.result?.s)) return;
      const row = frame.result;
      if (frame.channel === 'spot.tickers') { const ticker = normalizeGateTicker(row); if (ticker) updateOverview(ticker); }
      else if (frame.channel === 'spot.trades') applyTrades(Array.isArray(row) ? row : [row]);
      else if (frame.channel === 'spot.obu') applyBookUpdate(row);
      else if (frame.channel === 'spot.candlesticks') {
        const interval = Object.keys(PERIODS).find((value) => row?.n === `${value}_${PAIR}`);
        const candle = interval && normalizeGateCandle(row);
        if (candle) {
          liveCandleVersions.set(`${interval}:${candle.time}`, ++candleRevision);
          if (liveCandleVersions.size > 1000) liveCandleVersions.delete(liveCandleVersions.keys().next().value);
          saveCandle(interval, candle);
        }
      }
    });
    current.on('error', (error) => console.warn('Gate WS:', error.message));
    current.on('close', () => {
      if (socket !== current) return;
      socket = null; bookEpoch++; bookId = null; bookMode = null;
      if (started) updateOverview({ marketError: 'Gate 行情正在重连' });
      if (started) { reconnectTimer = setTimeout(connect, retry); retry = Math.min(retry * 2, 30_000); }
    });
  }
  async function start() {
    if (started || closed) return;
    const pair = await get(`/currency_pairs/${PAIR}`);
    if (pair?.id !== PAIR || pair.base !== 'PEARL' || pair.quote !== 'USDT' || pair.trade_status === 'untradable') throw new Error('Gate PEARL/USDT spot unavailable');
    listingTime = Number(pair.buy_start) || 0;
    started = true;
    connect();
    await Promise.allSettled([refreshStats(), backfill(), get(`/trades?currency_pair=${PAIR}&limit=100`).then((rows) => { if (Array.isArray(rows)) applyTrades(rows); })]);
    if (closed) return;
    statsTimer = setInterval(() => { void refreshStats().catch((error) => console.warn('Gate stats:', error.message)); }, 30_000);
    bookTimer = setInterval(() => { if (bookMode !== 'ws' || now() - lastWsAt > 15_000) void refreshBook().catch((error) => console.warn('Gate depth:', error.message)); }, 5000);
    candleTimer = setInterval(() => { void backfill().catch((error) => console.warn('Gate candles:', error.message)); }, 60_000);
    heartbeatTimer = setInterval(() => { if (socket?.readyState === WebSocketImpl.OPEN) { socket.ping(); if (now() - lastWsAt > 60_000) socket.terminate(); } else connect(); }, 20_000);
  }
  function stop() {
    if (closed) return;
    started = false; closed = true;
    clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(bookTimer); clearInterval(candleTimer); clearInterval(heartbeatTimer);
    socket?.terminate(); socket = null; db.close();
  }
  const getOverview = () => overview ?? { ...contract(), price: null, stats24h: null, depth: depth(20), trades, marketError: '等待 Gate 行情', updatedAt: now() };
  function getCandles(interval) {
    if (!PERIODS[interval]) throw new Error('Unsupported interval');
    return { pair: 'PEARL/USDT', interval, candles: recent.all(interval).reverse().map((row) => ({ ...row, empty: false })), updatedAt: now(), source: 'provider', recordingSince: recordingSince() };
  }
  const getStatus = () => ({ upstreamConnected: socket?.readyState === WebSocketImpl.OPEN, lastMessageAt: lastWsAt || null, bookSynchronized: bookId !== null });
  return { start, stop, getOverview, getCandles, getFullDepth: () => bookId === null ? { bids: [], asks: [] } : depth(), contract, getStatus };
}
