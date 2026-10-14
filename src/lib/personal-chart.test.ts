import { describe, expect, it } from 'vitest';
import { filterPersonalTrades, groupPersonalTrades, summarizePersonalTrades } from './personal-chart';
import type { PersonalTrade } from './safetrade';

describe('personal trade chart labels', () => {
  it('groups fills into their candle and weights the displayed execution price by quantity', () => {
    const trades: PersonalTrade[] = [
      { id: '1', time: 3_601, side: 'buy', price: 2, amount: 3 },
      { id: '2', time: 3_659, side: 'buy', price: 5, amount: 1 },
      { id: '3', time: 3_660, side: 'sell', price: 4, amount: 2 },
    ];
    const minutes = groupPersonalTrades(trades, '1m');
    expect(minutes.get(3_600)?.buy).toHaveLength(2);
    expect(minutes.get(3_660)?.sell).toHaveLength(1);
    expect(summarizePersonalTrades(minutes.get(3_600)!.buy)).toEqual({ amount: 4, price: 2.75, count: 2 });
    const hours = groupPersonalTrades(trades, '1h');
    expect(hours.get(3_600)?.sell).toHaveLength(1);
  });
  it('applies the same selected time range to fills and weighted averages', () => {
    const day = (value: number) => Math.floor(new Date(2026, 4, value, 12).getTime() / 1000);
    const trades: PersonalTrade[] = [
      { id: 'old', time: day(24), side: 'buy', price: 1, amount: 100 },
      { id: 'buy', time: day(25), side: 'buy', price: 2, amount: 3 },
      { id: 'sell', time: day(26), side: 'sell', price: 4, amount: 1 },
      { id: 'later', time: day(27), side: 'buy', price: 9, amount: 100 },
    ];
    const chosen = filterPersonalTrades(trades, { period: 'custom', from: '2026-05-25', to: '2026-05-26' });
    expect(chosen.map((trade) => trade.id)).toEqual(['buy', 'sell']);
    expect(summarizePersonalTrades(chosen.filter((trade) => trade.side === 'buy'))?.price).toBe(2);
    expect(filterPersonalTrades(trades, { period: '7d', from: '', to: '' }, day(27) * 1000)).toHaveLength(4);
  });
  it('keeps a custom range with an open end current as time advances', () => {
    const at = (day: number) => Math.floor(new Date(2026, 9, day, 12).getTime() / 1000);
    const trades: PersonalTrade[] = [14, 15].map((day) => ({ id: String(day), time: at(day), side: 'buy', price: 1, amount: 1 }));
    const range = { period: 'custom' as const, from: '2026-10-14', to: 'now' };
    expect(filterPersonalTrades(trades, range, at(14) * 1000)).toHaveLength(1);
    expect(filterPersonalTrades(trades, range, at(15) * 1000)).toHaveLength(2);
  });
});
