import type { CandleSeries, MarketOverview } from './safetrade';

export const MARKET_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type MarketInterval = typeof MARKET_INTERVALS[number];
export type PublicMarketCache = { overview: MarketOverview | null; series: Partial<Record<MarketInterval, CandleSeries>> };

const KEY = 'pearl-public-market-cache-v1';
const WPRL_KEY = 'pearl-wprl-market-cache-v1';
const EMPTY = (): PublicMarketCache => ({ overview: null, series: {} });
const validTime = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  && value > Date.now() - 7 * 24 * 60 * 60 * 1000 && value <= Date.now() + 60_000;
const validCandle = (value: unknown) => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return ['time', 'open', 'high', 'low', 'close', 'volume'].every((field) => typeof row[field] === 'number' && Number.isFinite(row[field]));
};

export function parsePublicMarketCache(raw: string | null): PublicMarketCache {
  if (!raw) return EMPTY();
  try {
    const parsed = JSON.parse(raw) as Partial<PublicMarketCache>;
    const overview = parsed.overview && validTime(parsed.overview.updatedAt)
      && typeof parsed.overview.pair === 'string' && Array.isArray(parsed.overview.trades)
      && Array.isArray(parsed.overview.depth?.asks) && Array.isArray(parsed.overview.depth?.bids)
      ? parsed.overview : null;
    const series: PublicMarketCache['series'] = {};
    for (const interval of MARKET_INTERVALS) {
      const entry = parsed.series?.[interval];
      if (entry?.interval === interval && validTime(entry.updatedAt)
        && Array.isArray(entry.candles) && entry.candles.length <= 300 && entry.candles.every(validCandle)) {
        series[interval] = entry;
      }
    }
    return { overview, series };
  } catch { return EMPTY(); }
}

export function loadPublicMarketCache(): PublicMarketCache {
  try { return parsePublicMarketCache(localStorage.getItem(KEY)); }
  catch { return EMPTY(); }
}

export function savePublicMarketCache(cache: PublicMarketCache): void {
  try { localStorage.setItem(KEY, JSON.stringify(cache)); }
  catch { /* Public cache is optional if storage is full. */ }
}

export function loadWprlMarketCache(): PublicMarketCache {
  try { return parsePublicMarketCache(localStorage.getItem(WPRL_KEY)); }
  catch { return EMPTY(); }
}

export function saveWprlMarketCache(cache: PublicMarketCache): void {
  try { localStorage.setItem(WPRL_KEY, JSON.stringify(cache)); }
  catch { /* Public cache is optional if storage is full. */ }
}
