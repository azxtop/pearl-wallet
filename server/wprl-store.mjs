import { DatabaseSync } from 'node:sqlite';
import { PERIODS } from './safetrade-data.mjs';

const minute = (time) => Math.floor(time / 60) * 60;
const DAY = 86_400;

export function createWprlStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS swaps (
      id TEXT PRIMARY KEY, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL, time INTEGER NOT NULL, side TEXT NOT NULL,
      price REAL NOT NULL, amount REAL NOT NULL, turnover REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS swaps_block ON swaps(block_number);
    CREATE INDEX IF NOT EXISTS swaps_time ON swaps(time DESC);
    CREATE TABLE IF NOT EXISTS candles_1m (
      time INTEGER PRIMARY KEY, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
      turnover REAL NOT NULL, trades INTEGER NOT NULL
    );`);
  const getState = db.prepare('SELECT value FROM state WHERE key=?');
  const putState = db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const insertSwap = db.prepare(`INSERT INTO swaps(id,block_number,block_hash,log_index,time,side,price,amount,turnover)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    block_number=excluded.block_number,block_hash=excluded.block_hash,log_index=excluded.log_index,
    time=excluded.time,side=excluded.side,price=excluded.price,amount=excluded.amount,turnover=excluded.turnover`);
  const swapAt = db.prepare('SELECT time,block_hash FROM swaps WHERE id=?');
  const swapRange = db.prepare('SELECT time FROM swaps WHERE block_number BETWEEN ? AND ?');
  const deleteRange = db.prepare('DELETE FROM swaps WHERE block_number BETWEEN ? AND ?');
  const deleteSwap = db.prepare('DELETE FROM swaps WHERE id=?');
  const minuteSwaps = db.prepare('SELECT price,amount,turnover FROM swaps WHERE time>=? AND time<? ORDER BY block_number,log_index');
  const putCandle = db.prepare(`INSERT INTO candles_1m(time,open,high,low,close,volume,turnover,trades) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(time) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,
    close=excluded.close,volume=excluded.volume,turnover=excluded.turnover,trades=excluded.trades`);
  const deleteCandle = db.prepare('DELETE FROM candles_1m WHERE time=?');
  const candleRange = db.prepare('SELECT * FROM candles_1m WHERE time>=? AND time<=? ORDER BY time');
  const priorCandle = db.prepare('SELECT close FROM candles_1m WHERE time<? ORDER BY time DESC LIMIT 1');
  const firstCandle = db.prepare('SELECT time FROM candles_1m ORDER BY time LIMIT 1');
  const windowCandles = db.prepare('SELECT open,high,low,close,volume,turnover FROM candles_1m WHERE time>=? AND time<=? ORDER BY time');
  const recentSwaps = db.prepare('SELECT id,price,amount,turnover,time,side,block_number AS blockNumber FROM swaps ORDER BY block_number DESC,log_index DESC LIMIT ?');
  const latestSwap = db.prepare('SELECT id,price,amount,turnover,time,side,block_number AS blockNumber FROM swaps ORDER BY block_number DESC,log_index DESC LIMIT 1');
  const pruneSwaps = db.prepare('DELETE FROM swaps WHERE time<? AND block_number<=?');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function state() {
    const startBlock = getState.get('start_block');
    return startBlock ? {
      startBlock: Number(startBlock.value), cursor: Number(getState.get('cursor').value),
      startTime: Number(getState.get('start_time').value),
      coveredTime: Number(getState.get('covered_time')?.value || 0),
    } : null;
  }
  function initialize(head, time) {
    if (!Number.isSafeInteger(head) || head < 0 || !Number.isFinite(time)) throw new Error('Invalid WPRL start');
    return transaction(() => {
      if (!getState.get('start_block')) {
        putState.run('start_block', String(head + 1));
        putState.run('cursor', String(head));
        putState.run('start_time', String(time));
        putState.run('covered_time', String(time));
      }
      return state();
    });
  }
  function rebuildMinute(time) {
    const rows = minuteSwaps.all(time, time + 60);
    if (!rows.length) { deleteCandle.run(time); return; }
    putCandle.run(time, rows[0].price, Math.max(...rows.map((row) => row.price)),
      Math.min(...rows.map((row) => row.price)), rows.at(-1).price,
      rows.reduce((sum, row) => sum + row.amount, 0),
      rows.reduce((sum, row) => sum + row.turnover, 0), rows.length);
  }
  function insert(trade, blockHash, affected) {
    if (!trade || !/^0x[0-9a-f]{64}$/i.test(blockHash || '') || !Number.isFinite(trade.time)
      || !Number.isSafeInteger(trade.blockNumber) || !Number.isSafeInteger(trade.logIndex)) throw new Error('Invalid WPRL swap');
    const previous = swapAt.get(trade.id);
    if (previous) affected.add(minute(previous.time));
    insertSwap.run(trade.id, trade.blockNumber, blockHash.toLowerCase(), trade.logIndex,
      trade.time, trade.side, trade.price, trade.amount, trade.turnover);
    affected.add(minute(trade.time));
  }
  function live(trade, blockHash) {
    const current = state();
    if (!current || trade.blockNumber < current.startBlock) return false;
    transaction(() => { const affected = new Set(); insert(trade, blockHash, affected); for (const time of affected) rebuildMinute(time); });
    return true;
  }
  function remove(id, blockHash) {
    return transaction(() => {
      const previous = swapAt.get(id);
      if (!previous || previous.block_hash !== blockHash?.toLowerCase()) return false;
      deleteSwap.run(id);
      rebuildMinute(minute(previous.time));
      return true;
    });
  }
  function reconcile(from, to, trades, coveredTime) {
    const current = state();
    if (!current || from < current.startBlock || to < from || !Number.isFinite(coveredTime)) throw new Error('Invalid WPRL range');
    return transaction(() => {
      const affected = new Set(swapRange.all(from, to).map((row) => minute(row.time)));
      deleteRange.run(from, to);
      for (const { trade, blockHash } of trades) {
        if (trade.blockNumber < from || trade.blockNumber > to) throw new Error('WPRL swap outside range');
        insert(trade, blockHash, affected);
      }
      for (const time of affected) rebuildMinute(time);
      if (to >= current.cursor) {
        putState.run('cursor', String(to));
        putState.run('covered_time', String(coveredTime));
      }
      return [...affected].sort((a, b) => a - b);
    });
  }
  function candles(interval, limit = 300) {
    const period = PERIODS[interval] * 60;
    if (!period || !Number.isSafeInteger(limit) || limit < 1 || limit > 300) throw new Error('Invalid candle query');
    const current = state();
    const earliest = firstCandle.get()?.time;
    if (!current || earliest === undefined) return [];
    const latestTime = latestSwap.get()?.time || 0;
    const end = Math.floor(Math.max(current.coveredTime, latestTime) / period) * period;
    const from = Math.max(Math.floor(earliest / period) * period, end - (limit - 1) * period);
    const rows = candleRange.all(from, end + period - 60);
    const byMinute = new Map(rows.map((row) => [row.time, row]));
    let close = priorCandle.get(from)?.close ?? null;
    const result = [];
    for (let time = from; time <= end; time += period) {
      let bucket = null;
      for (let tick = time; tick < time + period && tick <= Math.max(current.coveredTime, latestTime); tick += 60) {
        const row = byMinute.get(tick);
        if (row) {
          if (!bucket) bucket = { time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, empty: false };
          else { bucket.high = Math.max(bucket.high, row.high); bucket.low = Math.min(bucket.low, row.low); bucket.close = row.close; bucket.volume += row.volume; bucket.empty = false; }
          close = row.close;
        } else if (tick <= current.coveredTime && close !== null && !bucket) bucket = { time, open: close, high: close, low: close, close, volume: 0, empty: true };
      }
      if (bucket) result.push(bucket);
    }
    return result.slice(-limit);
  }
  function prune(now = Math.floor(Date.now() / 1000)) {
    const current = state();
    if (!current) return 0;
    return transaction(() => Number(pruneSwaps.run(now - 30 * DAY, current.cursor - 64).changes));
  }
  function stats24h() {
    const current = state();
    if (!current || current.coveredTime - current.startTime < DAY) return null;
    const from = minute(current.coveredTime - DAY);
    const rows = windowCandles.all(from, current.coveredTime);
    const previousClose = priorCandle.get(from)?.close;
    const opening = previousClose ?? rows[0]?.open;
    const closing = rows.at(-1)?.close ?? opening;
    if (!opening) return null;
    return {
      high: rows.length ? Math.max(...rows.map((row) => row.high)) : opening,
      low: rows.length ? Math.min(...rows.map((row) => row.low)) : opening,
      volume: rows.reduce((sum, row) => sum + row.volume, 0),
      turnover: rows.reduce((sum, row) => sum + row.turnover, 0),
      changePercent: (closing / opening - 1) * 100,
    };
  }
  return { state, initialize, live, remove, reconcile, candles, stats24h, recent: (limit = 20) => recentSwaps.all(limit), latest: () => latestSwap.get() || null, prune, close: () => db.close() };
}
