import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createMarketUsage, marketUsageStats, validateMarketUsage } from './market-usage.mjs';

test('market activity deduplicates devices and uses Beijing calendar days across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pearl-usage-'));
  const path = join(directory, 'market-usage.sqlite');
  const beforeMidnight = Date.parse('2026-11-14T15:59:59Z');
  const afterMidnight = beforeMidnight + 2000;
  const body = { firstRunAt: Date.parse('2026-11-01T12:00:00Z') };
  const other = { firstRunAt: body.firstRunAt + 1 };
  let store;
  try {
    store = createMarketUsage(path);
    store.record(body, beforeMidnight); store.record(body, beforeMidnight + 1);
    store.record(other, beforeMidnight); store.close();
    store = createMarketUsage(path); store.record(body, afterMidnight);
    const reader = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(marketUsageStats(reader, afterMidnight), {
      asOf: new Date(afterMidnight).toISOString(), timeZone: 'Asia/Shanghai', metric: 'market_active_timestamp_estimate',
      total: 2, daily: 1, weekly: 2, monthly: 2, firstReportedToday: 0,
    });
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM market_activity').get().n, 3);
    assert.deepEqual(reader.prepare('PRAGMA table_info(market_devices)').all().map((c) => c.name), ['first_run_at', 'first_reported_at', 'last_reported_at']);
    assert.equal(marketUsageStats(reader, afterMidnight + 7 * 86400_000).weekly, 0);
    assert.equal(marketUsageStats(reader, afterMidnight + 30 * 86400_000).monthly, 0);
    reader.close();
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('usage rejects invalid IDs and extra wallet or device fields', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');
  for (const invalid of [null, [], {}, { firstRunAt: '1794643200123' }, { firstRunAt: 1 },
    { firstRunAt: now + 3600_000 }, { firstRunAt: now, address: 'private' }, { firstRunAt: now, version: '0.2.44' }]) {
    assert.throws(() => validateMarketUsage(invalid, now));
  }
  assert.equal(validateMarketUsage({ firstRunAt: now - 1000 }, now), now - 1000);
});
