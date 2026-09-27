import { Capacitor, CapacitorHttp } from '@capacitor/core';

export type MarketData = {
  pair: string;
  price: number | null;
  stats24h: { high: number | null; low: number | null; volume: number | null; turnover: number | null; changePercent: number | null } | null;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number; empty: boolean }[];
  depth: { asks: { price: number; amount: number }[]; bids: { price: number; amount: number }[] };
  trades: { id: string; price: number; amount: number; time: number; side: 'buy' | 'sell' }[];
  marketError: string | null;
  updatedAt: number;
};

export type MarketOverview = Pick<MarketData, 'pair' | 'price' | 'stats24h' | 'depth' | 'trades' | 'marketError' | 'updatedAt'> & { liquidityUsd?: number | null; recordingSince?: number | null; statsSource?: 'provider' | 'recorded'; contract?: { coin: string; pair: string; quote: string; dex: string | null; example: boolean; szDecimals: number }; markPrice?: number | null; oraclePrice?: number | null; funding?: number | null; openInterest?: number | null };
export type CandleSeries = Pick<MarketData, 'candles' | 'updatedAt'> & { pair?: string; interval: string; source?: 'provider' | 'recorded' | 'mixed'; recordingSince?: number | null; syncedThrough?: number | null };
export type MarketStreamFrame =
  | { type: 'overview'; data: MarketOverview }
  | { type: 'overview-patch'; data: Partial<MarketOverview> & { updatedAt: number } }
  | { type: 'candle'; interval: string; candle: MarketData['candles'][number]; updatedAt: number }
  | { type: 'trades'; trades: MarketData['trades']; price: number | null; updatedAt: number; sampled?: boolean; skipped?: number };

export type AccountData = {
  balances: { PRL: { available: string; locked: string }; USDT: { available: string; locked: string } };
  updatedAt: number;
};

const API_URL = import.meta.env.VITE_SAFETRADE_API_URL || 'https://pearlwallet.az1993.xyz/api/safetrade';
const WPRL_API_URL = import.meta.env.VITE_WPRL_API_URL || 'https://pearlwallet.az1993.xyz/api/wprl';
const HYPERLIQUID_API_URL = import.meta.env.VITE_HYPERLIQUID_API_URL || 'https://pearlwallet.az1993.xyz/api/hyperliquid';
const TOKEN_KEY = 'pearl-safetrade-connection-v1';

export const savedConnectionToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const saveConnectionToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearConnectionToken = () => localStorage.removeItem(TOKEN_KEY);

async function request<T>(url: string, method = 'GET', data?: object, token?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (data) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({ url, method, headers, data, connectTimeout: 8000, readTimeout: 15000 });
    if (response.status < 200 || response.status >= 300) throw new Error(typeof response.data?.error === 'string' ? response.data.error : `HTTP ${response.status}`);
    return response.data as T;
  }
  const response = await fetch(url, { method, headers, body: data ? JSON.stringify(data) : undefined, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
  return body as T;
}

export const loadMarket = (interval: string) => request<MarketData>(`${API_URL}?interval=${encodeURIComponent(interval)}`);
export const loadMarketOverview = () => request<MarketOverview>(`${API_URL}/overview`);
export const loadMarketCandles = (interval: string) => request<CandleSeries>(`${API_URL}/candles?interval=${encodeURIComponent(interval)}`);
export const openMarketStream = () => new WebSocket(`${API_URL.replace(/^http/, 'ws')}/stream`);
export const loadWprlOverview = () => request<MarketOverview>(`${WPRL_API_URL}/overview`);
export const loadWprlCandles = (interval: string) => request<CandleSeries>(`${WPRL_API_URL}/candles?interval=${encodeURIComponent(interval)}`);
export const openWprlStream = () => new WebSocket(`${WPRL_API_URL.replace(/^http/, 'ws')}/stream`);
export const loadHyperliquidOverview = () => request<MarketOverview>(`${HYPERLIQUID_API_URL}/overview`);
export const loadHyperliquidCandles = (interval: string) => request<CandleSeries>(`${HYPERLIQUID_API_URL}/candles?interval=${encodeURIComponent(interval)}`);
export const openHyperliquidStream = () => new WebSocket(`${HYPERLIQUID_API_URL.replace(/^http/, 'ws')}/stream`);
export const connectAccount = (key: string, secret: string) => request<{ token: string }>(`${API_URL}/connection`, 'POST', { key, secret });
export const loadAccount = (token: string) => request<AccountData>(`${API_URL}/account`, 'GET', undefined, token);
export const accountStreamTicket = (token: string) => request<{ ticket: string }>(`${API_URL}/account-stream-ticket`, 'POST', undefined, token);
export const openAccountStream = (ticket: string) => new WebSocket(`${API_URL.replace(/^http/, 'ws')}/account-stream`, ['pearl-v1', `ticket.${ticket}`]);
export const disconnectAccount = (token: string) => request<{ disconnected: boolean }>(`${API_URL}/account`, 'DELETE', undefined, token);
