import { describe, expect, it } from 'vitest';
import { aggregateDepth, applyDepthDelta } from './full-depth';

describe('full SafeTrade order book', () => {
  it('applies consecutive changes and rejects a sequence gap', () => {
    const first = { sequence: 8, updatedAt: 1, depth: {
      bids: [{ price: 1.14, amount: 10 }], asks: [{ price: 1.15, amount: 5 }],
    } };
    const next = applyDepthDelta(first, { sequence: 9, bids: [['1.14', '0'], ['1.13', '8']], asks: [['1.16', '2']] });
    expect(next?.depth).toEqual({ bids: [{ price: 1.13, amount: 8 }], asks: [{ price: 1.15, amount: 5 }, { price: 1.16, amount: 2 }] });
    expect(applyDepthDelta(first, { sequence: 10, bids: [], asks: [] })).toBeNull();
  });

  it('groups asks upward and bids downward without changing total amounts', () => {
    const grouped = aggregateDepth({
      asks: [{ price: 1.151, amount: 2 }, { price: 1.159, amount: 3 }],
      bids: [{ price: 1.149, amount: 4 }, { price: 1.141, amount: 5 }],
    }, 0.01);
    expect(grouped.asks).toEqual([{ price: 1.16, amount: 5 }]);
    expect(grouped.bids).toEqual([{ price: 1.14, amount: 9 }]);
  });
});
