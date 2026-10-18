const DAY = 86_400;
export const BACKFILL_SECONDS = 165 * DAY;
const WINDOW_SECONDS = 70 * DAY;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_WINDOW = 100;

export function normalizePersonalTrade(row, market = row?.market || 'prlusdt') {
  if (!row || (typeof row.id !== 'number' && typeof row.id !== 'string')) return null;
  if (!['prlusdt', 'pearlusdt'].includes(market)) return null;
  const side = String(row.order_side || '').toLowerCase();
  const time = Math.floor(Date.parse(row.created_at) / 1000);
  const price = Number(row.price), amount = Number(row.amount);
  if (!['buy', 'sell'].includes(side) || !Number.isFinite(time) || !Number.isFinite(price) || !Number.isFinite(amount) || price <= 0 || amount <= 0) return null;
  return { id: `${market}:${row.id}`, time, side, price, amount };
}

export function personalTradeAverages(trades) {
  const totals = { buy: { quantity: 0, value: 0 }, sell: { quantity: 0, value: 0 } };
  for (const trade of trades) {
    if (!totals[trade.side]) continue;
    totals[trade.side].quantity += trade.amount;
    totals[trade.side].value += trade.amount * trade.price;
  }
  return {
    buy: totals.buy.quantity ? totals.buy.value / totals.buy.quantity : null,
    sell: totals.sell.quantity ? totals.sell.value / totals.sell.quantity : null,
  };
}

export function mergePersonalTrades(...groups) {
  const unique = new Map();
  for (const trade of groups.flat()) {
    const rawId = String(trade.id).replace(/^(prlusdt|pearlusdt):/, '');
    const id = /^(prlusdt|pearlusdt):/.test(trade.id) ? trade.id : `prlusdt:${rawId}`;
    // SafeTrade migrated old fills to PEARL with the same ID and values.
    const identity = JSON.stringify([rawId, trade.time, trade.side, trade.price, trade.amount]);
    const previous = unique.get(identity);
    if (!previous || (id.startsWith('pearlusdt:') && !previous.id.startsWith('pearlusdt:'))) {
      unique.set(identity, { ...trade, id });
    }
  }
  return [...unique.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

export async function fetchPersonalTrades(from, to, fetchPage, market = 'prlusdt') {
  const seen = new Map();
  for (let start = from; start < to; start += WINDOW_SECONDS) {
    const end = Math.min(to, start + WINDOW_SECONDS);
    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
      const rows = await fetchPage({ from: start, to: end, page, limit: PAGE_SIZE });
      if (!Array.isArray(rows)) throw new Error('Invalid SafeTrade personal trades');
      for (const row of rows) {
        const trade = normalizePersonalTrade(row, market);
        if (trade && trade.time >= from && trade.time <= to) seen.set(trade.id, trade);
      }
      if (rows.length < PAGE_SIZE) break;
      if (page === MAX_PAGES_PER_WINDOW) throw new Error('SafeTrade personal trades exceed the page limit');
    }
  }
  return [...seen.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
