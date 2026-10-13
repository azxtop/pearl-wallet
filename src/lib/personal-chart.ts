import type { PersonalTrade } from './safetrade';
import type { MarketInterval } from './market-cache';

const SECONDS: Record<MarketInterval, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };
export type CandlePersonalTrades = { buy: PersonalTrade[]; sell: PersonalTrade[] };

export function groupPersonalTrades(trades: PersonalTrade[], interval: MarketInterval): Map<number, CandlePersonalTrades> {
  const grouped = new Map<number, CandlePersonalTrades>();
  const seconds = SECONDS[interval];
  for (const trade of trades) {
    const time = Math.floor(trade.time / seconds) * seconds;
    const group = grouped.get(time) ?? { buy: [], sell: [] };
    group[trade.side].push(trade);
    grouped.set(time, group);
  }
  return grouped;
}

export function summarizePersonalTrades(trades: PersonalTrade[]): { amount: number; price: number; count: number } | null {
  if (!trades.length) return null;
  const amount = trades.reduce((sum, trade) => sum + trade.amount, 0);
  if (amount <= 0) return null;
  return { amount, price: trades.reduce((sum, trade) => sum + trade.price * trade.amount, 0) / amount, count: trades.length };
}
