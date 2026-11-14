import { Capacitor, CapacitorHttp } from '@capacitor/core';

export const MARKET_USAGE_TIMESTAMP_KEY = 'pearl-market-first-run-at-v1';
const ENDPOINT = 'https://pearlwallet.az1993.xyz/api/market-usage';
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
type Report = (firstRunAt: number) => Promise<unknown>;

function firstRunTimestamp(storage: StorageAccess, now: () => number): number | null {
  try {
    const saved = storage.getItem(MARKET_USAGE_TIMESTAMP_KEY);
    if (saved !== null) {
      const value = Number(saved);
      return /^\d{13}$/.test(saved) && Number.isSafeInteger(value) ? value : null;
    }
    const value = now();
    if (!Number.isSafeInteger(value) || !/^\d{13}$/.test(String(value))) return null;
    storage.setItem(MARKET_USAGE_TIMESTAMP_KEY, String(value));
    // Do not report a temporary identifier if storage is unavailable.
    return storage.getItem(MARKET_USAGE_TIMESTAMP_KEY) === String(value) ? value : null;
  } catch { return null; }
}

async function report(firstRunAt: number): Promise<unknown> {
  return CapacitorHttp.post({
    url: ENDPOINT,
    headers: { 'Content-Type': 'application/json' },
    data: { firstRunAt },
    connectTimeout: 3000,
    readTimeout: 3000,
  });
}

export function createMarketUsageTracker(options: {
  native?: boolean;
  storage?: StorageAccess;
  now?: () => number;
  report?: Report;
} = {}) {
  const enabled = options.native ?? Capacitor.isNativePlatform();
  let timestamp: number | null = null;
  try {
    if (enabled) timestamp = firstRunTimestamp(options.storage ?? localStorage, options.now ?? Date.now);
  } catch { /* A blocked storage accessor must not affect Wallet startup. */ }
  const send = options.report ?? report;
  let previousPage: string | null = null;
  return {
    enter(page: string, visible = true): void {
      const enteredMarket = page === 'market' && previousPage !== 'market';
      previousPage = page;
      if (!enteredMarket || !visible || timestamp === null) return;
      // No retries, timers, wallet/account data, or reports on other pages.
      try { void send(timestamp).catch(() => {}); } catch { /* Statistics never block navigation. */ }
    },
  };
}
