import type { MarketData } from './safetrade';
import type { MarketInterval } from './market-cache';

const SECONDS: Record<MarketInterval, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400,
};

// Lighter only sends trade-price candle updates when a trade occurs. Display
// zero-volume placeholders until the next real candle arrives.
export function displayLighterCandles(candles: MarketData['candles'], interval: MarketInterval, nowMs: number): MarketData['candles'] {
  const last = candles.at(-1);
  if (!last || !Number.isFinite(last.close)) return candles;
  const seconds = SECONDS[interval];
  const current = Math.floor(nowMs / 1000 / seconds) * seconds;
  if (last.time >= current) return candles;
  const result = candles.slice();
  const first = Math.max(last.time + seconds, current - 299 * seconds);
  for (let time = first; time <= current; time += seconds) {
    result.push({ time, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0, empty: true });
  }
  return result.slice(-300);
}
