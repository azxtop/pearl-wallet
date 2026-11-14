import { expect, it, vi } from 'vitest';
const { post } = vi.hoisted(() => ({ post: vi.fn().mockResolvedValue({ status: 204 }) }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { post } }));
import { createMarketUsageTracker, MARKET_USAGE_TIMESTAMP_KEY } from './market-usage';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

it('sends only the fixed timestamp in the native request body', () => {
  post.mockClear();
  const tracker = createMarketUsageTracker({ storage: storage(), now: () => 1794643200123 });
  tracker.enter('wallet'); tracker.enter('setting'); tracker.enter('market');
  expect(post).toHaveBeenCalledExactlyOnceWith({
    url: 'https://pearlwallet.az1993.xyz/api/market-usage',
    headers: { 'Content-Type': 'application/json' }, data: { firstRunAt: 1794643200123 },
    connectTimeout: 3000, readTimeout: 3000,
  });
});

it('keeps the first-run timestamp across app upgrades/restarts and wallet changes', () => {
  const saved = storage(), report = vi.fn().mockResolvedValue(undefined);
  const first = createMarketUsageTracker({ native: true, storage: saved, now: () => 1794643200123, report });
  expect(saved.getItem(MARKET_USAGE_TIMESTAMP_KEY)).toBe('1794643200123');
  first.enter('wallet');
  first.enter('setting');
  expect(report).not.toHaveBeenCalled();
  first.enter('market'); first.enter('market'); first.enter('market');
  expect(report.mock.calls).toEqual([[1794643200123]]);
  first.enter('wallet'); first.enter('setting'); first.enter('market');
  expect(report.mock.calls).toEqual([[1794643200123], [1794643200123]]);
  const upgraded = createMarketUsageTracker({ native: true, storage: saved, now: () => 1795643200456, report });
  upgraded.enter('wallet'); upgraded.enter('market');
  expect(report.mock.calls.at(-1)).toEqual([1794643200123]);
});

it('stays silent on web, hidden navigation, failed persistence, and corrupted IDs', () => {
  const report = vi.fn().mockResolvedValue(undefined), saved = storage();
  createMarketUsageTracker({ native: false, storage: saved, report }).enter('market');
  expect(saved.getItem(MARKET_USAGE_TIMESTAMP_KEY)).toBeNull();
  const hidden = createMarketUsageTracker({ native: true, storage: saved, now: () => 1794643200123, report });
  hidden.enter('market', false); hidden.enter('market', true);
  const blocked = { getItem: () => null, setItem: () => { throw new Error('storage full'); } };
  createMarketUsageTracker({ native: true, storage: blocked, report }).enter('market');
  saved.setItem(MARKET_USAGE_TIMESTAMP_KEY, 'broken');
  createMarketUsageTracker({ native: true, storage: saved, report }).enter('market');
  expect(report).not.toHaveBeenCalled();
});

it('does not retry a failed report until another explicit Market entry', async () => {
  const report = vi.fn().mockRejectedValue(new Error('offline'));
  const tracker = createMarketUsageTracker({ native: true, storage: storage(), now: () => 1794643200123, report });
  tracker.enter('market');
  await Promise.resolve();
  tracker.enter('market'); tracker.enter('wallet'); tracker.enter('setting');
  expect(report).toHaveBeenCalledTimes(1);
  tracker.enter('market');
  await Promise.resolve();
  expect(report).toHaveBeenCalledTimes(2);
});
