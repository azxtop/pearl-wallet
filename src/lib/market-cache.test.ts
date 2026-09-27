import { describe, expect, it } from 'vitest';
import { parsePublicMarketCache } from './market-cache';

describe('public market cache', () => {
  it('keeps only valid interval candles and ignores corrupted saved data', () => {
    const now = Date.now();
    const candle = { time: Math.floor(now / 1000), open: 1, high: 2, low: 1, close: 2, volume: 3, empty: false };
    const parsed = parsePublicMarketCache(JSON.stringify({
      overview: null,
      series: { '1m': { interval: '1m', candles: [candle], updatedAt: now }, '5m': { interval: '5m', candles: [{ ...candle, close: 'bad' }], updatedAt: now } },
    }));
    expect(parsed.series['1m']?.candles).toHaveLength(1);
    expect(parsed.series['5m']).toBeUndefined();
    expect(parsePublicMarketCache('{broken').series).toEqual({});
  });
});
