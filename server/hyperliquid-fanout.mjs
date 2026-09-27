import { WebSocket } from 'ws';

export function createHyperliquidFanout({ now = Date.now } = {}) {
  const clients = new Set();
  let mode = 'full', highSince = 0, lowSince = 0, sent = [];
  let pendingTrades = [], pendingCount = 0;
  const bytesPerSecond = () => {
    const cutoff = now() - 5_000;
    sent = sent.filter((entry) => entry.time >= cutoff);
    return sent.reduce((sum, entry) => sum + entry.bytes, 0) / 5;
  };
  function send(client, frame) {
    if (client.readyState !== WebSocket.OPEN) return false;
    if (client.bufferedAmount > 512_000) { client.close(1008, 'Slow consumer'); return false; }
    if (frame.type === 'trades' && client.bufferedAmount > 64_000) {
      client.slowTrades = [...(client.slowTrades || []), ...frame.trades].slice(-10);
      client.slowSkipped = (client.slowSkipped || 0) + frame.trades.length;
      return false;
    }
    const value = JSON.stringify(frame);
    client.send(value);
    const second = Math.floor(now() / 1000) * 1000;
    const bucket = sent.at(-1);
    if (bucket?.time === second) bucket.bytes += Buffer.byteLength(value);
    else sent.push({ time: second, bytes: Buffer.byteLength(value) });
    return true;
  }
  function evaluate() {
    const bps = bytesPerSecond() * 8;
    if (mode === 'full') {
      if (clients.size >= 100) { mode = 'batched'; highSince = 0; }
      else if (bps > 5_000_000) {
        if (!highSince) highSince = now();
        if (now() - highSince >= 60_000) { mode = 'batched'; highSince = 0; }
      } else highSince = 0;
    } else if (clients.size < 60 && bps < 2_000_000) {
      if (!lowSince) lowSince = now();
      if (now() - lowSince >= 300_000) { mode = 'full'; lowSince = 0; }
    } else lowSince = 0;
    return mode;
  }
  function broadcast(frame) {
    if (frame.type === 'trades') {
      if (evaluate() === 'batched') {
        pendingTrades.push(...frame.trades);
        pendingCount += frame.trades.length;
        if (pendingTrades.length > 10) pendingTrades = pendingTrades.slice(-10);
        return;
      }
    }
    for (const client of clients) {
      if (frame.type === 'candle' && frame.interval !== client.marketInterval) continue;
      send(client, frame);
    }
  }
  function flushTrades() {
    evaluate();
    for (const client of clients) {
      if (!client.slowSkipped || client.bufferedAmount > 64_000) continue;
      const trades = client.slowTrades;
      const skipped = Math.max(0, client.slowSkipped - trades.length);
      client.slowTrades = []; client.slowSkipped = 0;
      send(client, { type: 'trades', trades, price: trades.at(-1)?.price, updatedAt: now(), sampled: true, skipped });
    }
    if (!pendingCount) return;
    const trades = pendingTrades;
    const skipped = Math.max(0, pendingCount - trades.length);
    const frame = { type: 'trades', trades, price: trades.at(-1)?.price, updatedAt: now(), sampled: true, skipped };
    for (const client of clients) send(client, frame);
    pendingTrades = []; pendingCount = 0;
  }
  const timer = setInterval(flushTrades, 1000);
  timer.unref?.();
  return {
    clients, send, broadcast, flushTrades,
    mode: () => mode,
    stats: () => ({ viewers: clients.size, egressMbps: Number((bytesPerSecond() * 8 / 1_000_000).toFixed(3)), tradesMode: mode }),
    stop: () => clearInterval(timer),
  };
}
