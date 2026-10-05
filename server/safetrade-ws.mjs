import WebSocket from 'ws';
import { normalizePublicTrades, normalizeTicker } from './safetrade-data.mjs';

const STREAMS = ['global.tickers', 'prlusdt.depth', 'prlusdt.trades'];

function orderBook(raw) {
  const read = (rows) => new Map((Array.isArray(rows) ? rows : []).flatMap((row) => {
    const price = Number(row?.[0]);
    const amount = Number(row?.[1]);
    return Number.isFinite(price) && price > 0 && Number.isFinite(amount) && amount >= 0 ? [[price, amount]] : [];
  }));
  return { asks: read(raw?.asks), bids: read(raw?.bids) };
}

function topOfBook(book, limit = 10) {
  const levels = (side, descending) => [...side].filter(([, amount]) => amount > 0)
    .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
    .slice(0, limit).map(([price, amount]) => ({ price, amount }));
  return { asks: levels(book.asks, false), bids: levels(book.bids, true) };
}

export function createSafeTradeFeed({ apiBase, fetchDepth, onTicker, onDepth, onTrades, onFullDepth = () => {}, onStatus = () => {}, WebSocketClass = WebSocket }) {
  const endpoint = `${apiBase.replace(/^http/, 'ws').replace(/\/$/, '')}/websocket/public`;
  let socket;
  let running = false;
  let retryTimer;
  let heartbeat;
  let retryMs = 1000;
  let syncing = false;
  let queuedDepth = [];
  let book;
  let sequence = -1;
  let lastMessage = 0;
  const seenTrades = new Set();

  function applyDepth(raw) {
    const next = Number(raw?.sequence);
    if (!Number.isSafeInteger(next) || next < 0 || !book) return false;
    if (next <= sequence) return true;
    if (next !== sequence + 1) return false;
    for (const side of ['asks', 'bids']) {
      for (const row of Array.isArray(raw[side]) ? raw[side] : []) {
        const price = Number(row?.[0]);
        const amount = Number(row?.[1]);
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount < 0) continue;
        if (amount === 0) book[side].delete(price);
        else book[side].set(price, amount);
      }
    }
    sequence = next;
    onDepth(topOfBook(book));
    onFullDepth({ type: 'depth-delta', sequence, asks: raw.asks ?? [], bids: raw.bids ?? [] });
    return true;
  }

  async function syncDepth() {
    if (syncing || !running || socket?.readyState !== WebSocketClass.OPEN) return;
    syncing = true;
    let retry = false;
    const currentSocket = socket;
    try {
      const raw = await fetchDepth();
      if (!running || currentSocket !== socket || currentSocket.readyState !== WebSocketClass.OPEN) return;
      const snapshotSequence = Number(raw?.sequence);
      if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0) throw new Error('Depth snapshot has no sequence');
      book = orderBook(raw);
      sequence = snapshotSequence;
      const pending = queuedDepth;
      queuedDepth = [];
      let gap = false;
      for (const delta of pending) {
        if (!applyDepth(delta)) { gap = true; break; }
      }
      onDepth(topOfBook(book));
      if (!gap) onFullDepth({ type: 'depth-snapshot', sequence, depth: topOfBook(book, 200) });
      if (gap) { book = undefined; retry = true; }
    } catch {
      book = undefined;
      const timer = setTimeout(syncDepth, 5000);
      timer.unref?.();
    } finally {
      syncing = false;
      if (retry) queueMicrotask(syncDepth);
    }
  }

  function receive(payload) {
    let data;
    try { data = JSON.parse(String(payload)); } catch { return; }
    lastMessage = Date.now();
    const ticker = normalizeTicker(data?.['global.tickers']?.prlusdt);
    if (ticker) onTicker(ticker);
    if (Array.isArray(data?.['prlusdt.trades'])) {
      const trades = normalizePublicTrades(data['prlusdt.trades']).filter((trade) => {
        if (seenTrades.has(trade.id)) return false;
        seenTrades.add(trade.id);
        if (seenTrades.size > 500) seenTrades.delete(seenTrades.values().next().value);
        return true;
      });
      if (trades.length) onTrades(trades);
    }
    if (data?.['prlusdt.depth']) {
      const delta = data['prlusdt.depth'];
      if (syncing || !book) {
        queuedDepth.push(delta);
        if (queuedDepth.length > 1000) queuedDepth = queuedDepth.slice(-1000);
        if (!syncing) void syncDepth();
      } else if (!applyDepth(delta)) {
        queuedDepth = [delta];
        book = undefined;
        void syncDepth();
      }
    }
  }

  function connect() {
    if (!running) return;
    socket = new WebSocketClass(endpoint, { handshakeTimeout: 10_000 });
    socket.on('open', () => {
      retryMs = 1000;
      lastMessage = Date.now();
      queuedDepth = [];
      book = undefined;
      sequence = -1;
      socket.send(JSON.stringify({ event: 'subscribe', streams: STREAMS }));
      onStatus(true);
      void syncDepth();
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 60_000) socket.terminate();
        else if (socket.readyState === WebSocketClass.OPEN) socket.ping();
      }, 25_000);
    });
    socket.on('message', receive);
    socket.on('error', () => {});
    socket.on('close', () => {
      clearInterval(heartbeat);
      book = undefined;
      onStatus(false);
      if (running) {
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    });
  }

  return {
    getFullDepth() { return book ? { sequence, depth: topOfBook(book, 200), updatedAt: Date.now() } : null; },
    start() { if (!running) { running = true; connect(); } },
    stop() { running = false; clearTimeout(retryTimer); clearInterval(heartbeat); socket?.close(); },
  };
}
