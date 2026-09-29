import { describe, expect, it } from 'vitest';
import { displayLighterCandles } from './chart-candles';

describe('Lighter chart display', () => {
  const candle = { time: 120, open: 2, high: 3, low: 1, close: 2.5, volume: 4, empty: false };

  it('shows empty current minutes without changing the recorded candle', () => {
    const recorded = [candle];
    const display = displayLighterCandles(recorded, '1m', 240_500);
    expect(display.map((item) => item.time)).toEqual([120, 180, 240]);
    expect(display.at(-1)).toEqual({ time: 240, open: 2.5, high: 2.5, low: 2.5, close: 2.5, volume: 0, empty: true });
    expect(recorded).toHaveLength(1);
  });

  it('uses a real candle as soon as it arrives and aligns longer intervals', () => {
    const real = { ...candle, time: 240, close: 2.7 };
    expect(displayLighterCandles([candle, real], '1m', 240_500).at(-1)).toEqual(real);
    expect(displayLighterCandles([{ ...candle, time: 0 }], '5m', 600_100).at(-1)?.time).toBe(600);
  });
});
