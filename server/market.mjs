export function normalizeTrade(input) {
  if (!input || typeof input !== 'object') return null;
  const id = String(input.id ?? input.trade_id ?? input.tid ?? '');
  const price = Number(input.price ?? input.p);
  const amount = Number(input.amount ?? input.volume ?? input.q);
  const rawTime = input.created_at ?? input.time ?? input.timestamp ?? input.at;
  const numericTime = Number(rawTime);
  const ts = Number.isFinite(numericTime)
    ? (numericTime > 1e12 ? Math.floor(numericTime / 1000) : Math.floor(numericTime))
    : Math.floor(Date.parse(String(rawTime)) / 1000);
  if (!id || !Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(ts) || ts <= 0) return null;
  return { id, price, amount, ts };
}

export function candlesFromTrades(trades, startMinute, endMinute, previousClose = null, intervalSeconds = 60) {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds % 60 !== 0) {
    throw new Error('K 线周期无效');
  }
  const grouped = new Map();
  const ordered = [...trades].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  for (const trade of ordered) {
    const minute = Math.floor(trade.ts / intervalSeconds) * intervalSeconds;
    if (minute < startMinute || minute > endMinute) continue;
    let candle = grouped.get(minute);
    if (!candle) {
      candle = { time: minute, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: 0, trades: 0, empty: false };
      grouped.set(minute, candle);
    }
    candle.high = Math.max(candle.high, trade.price);
    candle.low = Math.min(candle.low, trade.price);
    candle.close = trade.price;
    candle.volume += trade.amount;
    candle.trades++;
  }
  const result = [];
  let lastClose = previousClose;
  for (let time = startMinute; time <= endMinute; time += intervalSeconds) {
    const candle = grouped.get(time);
    if (candle) {
      result.push(candle);
      lastClose = candle.close;
    } else if (lastClose !== null) {
      result.push({ time, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0, trades: 0, empty: true });
    }
  }
  return result;
}

/**
 * 24h market stats for a list of trades inside the trailing window.
 *
 * `referencePrice` must be the last trade BEFORE the window (or null): the
 * change percentage is measured against it so it always spans a full day.
 * Using the first trade *inside* the window would silently shrink the window
 * to minutes on low-volume pairs.
 */
export function stats24h(trades, referencePrice) {
  const high = trades.reduce((value, trade) => Math.max(value, trade.price), -Infinity);
  const low = trades.reduce((value, trade) => Math.min(value, trade.price), Infinity);
  const volume = trades.reduce((sum, trade) => sum + trade.amount, 0);
  const turnover = trades.reduce((sum, trade) => sum + trade.amount * trade.price, 0);
  const last = trades.at(-1)?.price;
  const changePercent = referencePrice && last ? (last / referencePrice - 1) * 100 : null;
  return {
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    volume,
    turnover,
    changePercent,
  };
}
