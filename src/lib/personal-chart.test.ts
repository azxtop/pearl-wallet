import { describe, expect, it } from 'vitest';
import { groupPersonalTrades, summarizePersonalTrades } from './personal-chart';
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
});
