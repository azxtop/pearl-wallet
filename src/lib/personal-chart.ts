import type { PersonalTrade } from './safetrade';
import type { MarketInterval } from './market-cache';

const SECONDS: Record<MarketInterval, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 };
export type CandlePersonalTrades = { buy: PersonalTrade[]; sell: PersonalTrade[] };
export type PersonalTradePeriod = 'all' | '7d' | '30d' | '90d' | 'custom';
export type PersonalTradeRange = { period: PersonalTradePeriod; from: string; to: string };

function localDayStart(date: string, nextDay = false): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const local = new Date(year!, month! - 1, day!);
  if (local.getFullYear() !== year || local.getMonth() !== month! - 1 || local.getDate() !== day) return null;
  return new Date(year!, month! - 1, day! + Number(nextDay)).getTime() / 1000;
}

export function filterPersonalTrades(trades: PersonalTrade[], range: PersonalTradeRange, now = Date.now()): PersonalTrade[] {
  if (range.period === 'all') return trades;
  if (range.period === 'custom') {
    const from = localDayStart(range.from);
    const until = localDayStart(range.to, true);
    return from === null || until === null || from >= until ? [] : trades.filter((trade) => trade.time >= from && trade.time < until);
  }
  const days = range.period === '7d' ? 7 : range.period === '30d' ? 30 : 90;
  const from = now / 1000 - days * 86_400;
  return trades.filter((trade) => trade.time >= from && trade.time <= now / 1000);
}

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
