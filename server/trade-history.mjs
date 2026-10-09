import { DatabaseSync } from 'node:sqlite';

const SOURCES = new Set(['safetrade', 'hyperliquid', 'lighter', 'aster']);

export function createTradeHistory(path, { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS trades (
      source TEXT NOT NULL, market TEXT NOT NULL, id TEXT NOT NULL,
      time INTEGER NOT NULL, price REAL NOT NULL, amount REAL NOT NULL,
      side TEXT NOT NULL, PRIMARY KEY (source, market, id)
    );
    CREATE INDEX IF NOT EXISTS trades_recent ON trades(source, market, time DESC, id DESC);`);
  const insert = db.prepare('INSERT OR IGNORE INTO trades(source,market,id,time,price,amount,side) VALUES(?,?,?,?,?,?,?)');
  const earliest = db.prepare('SELECT MIN(time) AS time FROM trades WHERE source=? AND market=?');
  const pending = [];
  let timer = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending.length) return;
    const batch = pending.splice(0);
    db.exec('BEGIN');
    try {
      for (const row of batch) insert.run(...row);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      pending.unshift(...batch);
      throw error;
    }
  }

  function add(source, market, trades) {
    if (!SOURCES.has(source) || !market || !Array.isArray(trades)) return;
    for (const trade of trades) {
      const time = Number(trade.time), price = Number(trade.price), amount = Number(trade.amount);
      if (typeof trade.id !== 'string' || !trade.id || !Number.isSafeInteger(time) || time <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0 || !['buy', 'sell'].includes(trade.side)) continue;
      pending.push([source, market, trade.id, time, price, amount, trade.side]);
    }
    if (pending.length >= 1000) { try { flush(); } catch (error) { console.warn('Trade history:', error.message); } }
    else if (pending.length && !timer) timer = setTimeout(() => { try { flush(); } catch (error) { console.warn('Trade history:', error.message); } }, 500);
  }

  function query(source, market, filters = {}) {
    if (!SOURCES.has(source) || !market) throw new Error('Unsupported market');
    flush();
    const clauses = ['source=?', 'market=?'];
    const params = [source, market];
    for (const [name, operator] of [['from', '>='], ['to', '<='], ['minPrice', '>='], ['maxPrice', '<='], ['minAmount', '>=']]) {
      const value = filters[name];
      if (value === undefined || value === '') continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new Error('Invalid filter');
      const column = name === 'from' || name === 'to' ? 'time' : name === 'minAmount' ? 'amount' : 'price';
      clauses.push(`${column}${operator}?`);
      params.push(number);
    }
    if (filters.side) {
      if (!['buy', 'sell'].includes(filters.side)) throw new Error('Invalid side');
      clauses.push('side=?'); params.push(filters.side);
    }
    if (filters.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8')); } catch { throw new Error('Invalid cursor'); }
      if (!Number.isSafeInteger(cursor?.time) || typeof cursor?.id !== 'string' || cursor.id.length > 128) throw new Error('Invalid cursor');
      clauses.push('(time<? OR (time=? AND id<?))');
      params.push(cursor.time, cursor.time, cursor.id);
    }
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 100));
    const rows = db.prepare(`SELECT id,time,price,amount,side FROM trades WHERE ${clauses.join(' AND ')} ORDER BY time DESC,id DESC LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { trades: items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ time: last.time, id: last.id })).toString('base64url') : null,
      recordingSince: earliest.get(source, market)?.time ?? null };
  }

  function prune() {
    flush();
    const cutoff = Math.floor(now() / 1000);
    db.prepare('DELETE FROM trades WHERE source=? AND market=? AND time<?').run('hyperliquid', 'BTC/USDC', cutoff - 24 * 3600);
    db.prepare('DELETE FROM trades WHERE NOT (source=? AND market=?) AND time<?').run('hyperliquid', 'BTC/USDC', cutoff - 30 * 86400);
    db.exec(`DELETE FROM trades WHERE rowid IN (
      SELECT rowid FROM trades WHERE source='hyperliquid' AND market='BTC/USDC' ORDER BY time DESC,id DESC LIMIT -1 OFFSET 100000
    )`);
  }

  prune();
  return { add, flush, query, prune, close: () => { flush(); db.close(); } };
}
