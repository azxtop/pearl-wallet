import type { MarketData } from './safetrade';

export type DepthBook = MarketData['depth'];
export type DepthSnapshot = { sequence: number; depth: DepthBook; updatedAt: number };
export type DepthDelta = { sequence: number; asks: [string | number, string | number][]; bids: [string | number, string | number][] };

const validLevel = (price: unknown, amount: unknown) => {
  const p = Number(price), a = Number(amount);
  return Number.isFinite(p) && p > 0 && Number.isFinite(a) && a >= 0 ? { price: p, amount: a } : null;
};

export function applyDepthDelta(snapshot: DepthSnapshot, delta: DepthDelta): DepthSnapshot | null {
  if (!Number.isSafeInteger(delta.sequence) || delta.sequence !== snapshot.sequence + 1) return null;
  const update = (side: DepthBook['asks'], rows: DepthDelta['asks'], descending: boolean) => {
    const levels = new Map(side.map(({ price, amount }) => [price, amount]));
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const level = validLevel(row[0], row[1]);
      if (!level) continue;
      if (level.amount === 0) levels.delete(level.price);
      else levels.set(level.price, level.amount);
    }
    return [...levels].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
      .slice(0, 200).map(([price, amount]) => ({ price, amount }));
  };
  return { sequence: delta.sequence, updatedAt: Date.now(), depth: {
    bids: update(snapshot.depth.bids, delta.bids, true), asks: update(snapshot.depth.asks, delta.asks, false),
  } };
}

export function aggregateDepth(depth: DepthBook, step: number): DepthBook {
  if (step === 0) return depth;
  const group = (side: DepthBook['asks'], isAsk: boolean) => {
    const levels = new Map<number, number>();
    for (const { price, amount } of side) {
      const units = isAsk ? Math.ceil(price / step - 1e-9) : Math.floor(price / step + 1e-9);
      const groupedPrice = Number((units * step).toFixed(8));
      levels.set(groupedPrice, (levels.get(groupedPrice) ?? 0) + amount);
    }
    return [...levels].sort((a, b) => isAsk ? a[0] - b[0] : b[0] - a[0])
      .map(([price, amount]) => ({ price, amount }));
  };
  return { asks: group(depth.asks, true), bids: group(depth.bids, false) };
}
