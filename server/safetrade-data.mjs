const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const PERIODS = Object.freeze({ '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 });

export function normalizeCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const [time, open, high, low, close, volume] = row.map(finite);
  if (![time, open, high, low, close, volume].every((value) => value !== null)) return null;
  if (time <= 0 || open <= 0 || high < low || volume < 0) return null;
  return { time, open, high, low, close, volume, empty: volume === 0 };
}

export function normalizeTicker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = finite(raw.last);
  if (price === null || price <= 0) return null;
  return {
    price,
    stats24h: {
      high: finite(raw.high), low: finite(raw.low), volume: finite(raw.volume),
      turnover: finite(raw.amount), changePercent: finite(String(raw.price_change_percent ?? '').replace('%', '')),
    },
  };
}

export function normalizeDepth(raw) {
  const levels = (value) => Array.isArray(value) ? value.slice(0, 15).map((row) => {
    if (!Array.isArray(row)) return null;
    const price = finite(row[0]);
    const amount = finite(row[1]);
    return price !== null && price > 0 && amount !== null && amount >= 0 ? { price, amount } : null;
  }).filter(Boolean) : [];
  return { asks: levels(raw?.asks), bids: levels(raw?.bids) };
}

export function normalizePublicTrades(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map((row) => {
    const price = finite(row?.price);
    const amount = finite(row?.amount);
    const time = Math.floor(Date.parse(row?.created_at) / 1000);
    if (!row?.id || price === null || amount === null || !Number.isFinite(time)) return null;
    return { id: String(row.id), price, amount, time, side: row.side === 'buy' ? 'buy' : 'sell' };
  }).filter(Boolean);
}
