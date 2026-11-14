import { DatabaseSync } from 'node:sqlite';

const DAY = 86400_000;
const dayInBeijing = (time) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);

export function validateMarketUsage(body, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
    || !Object.hasOwn(body, 'firstRunAt') || !Number.isSafeInteger(body.firstRunAt)
    || body.firstRunAt < Date.UTC(2026, 8, 1) || body.firstRunAt > now + 5 * 60_000) {
    throw new Error('Invalid market usage timestamp');
  }
  return body.firstRunAt;
}

export function createMarketUsage(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS market_devices (
      first_run_at INTEGER PRIMARY KEY, first_reported_at INTEGER NOT NULL, last_reported_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_activity (
      first_run_at INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(first_run_at, day)
    );
    CREATE INDEX IF NOT EXISTS market_activity_day ON market_activity(day);`);
  const device = db.prepare(`INSERT INTO market_devices VALUES (?, ?, ?)
    ON CONFLICT(first_run_at) DO UPDATE SET last_reported_at=MAX(last_reported_at, excluded.last_reported_at)`);
  const active = db.prepare('INSERT OR IGNORE INTO market_activity VALUES (?, ?)');
  return {
    record(body, now = Date.now()) {
      const firstRunAt = validateMarketUsage(body, now);
      db.exec('BEGIN');
      try {
        device.run(firstRunAt, now, now);
        active.run(firstRunAt, dayInBeijing(now));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}

export function marketUsageStats(db, now = Date.now()) {
  const today = dayInBeijing(now);
  const count = (from) => db.prepare('SELECT COUNT(DISTINCT first_run_at) AS count FROM market_activity WHERE day >= ? AND day <= ?').get(from, today).count;
  const startOfToday = Date.parse(`${today}T00:00:00+08:00`);
  return {
    asOf: new Date(now).toISOString(), timeZone: 'Asia/Shanghai', metric: 'market_active_timestamp_estimate',
    total: db.prepare('SELECT COUNT(*) AS count FROM market_devices').get().count,
    daily: count(today), weekly: count(dayInBeijing(now - 6 * DAY)), monthly: count(dayInBeijing(now - 29 * DAY)),
    firstReportedToday: db.prepare('SELECT COUNT(*) AS count FROM market_devices WHERE first_reported_at >= ? AND first_reported_at <= ?').get(startOfToday, now).count,
  };
}
