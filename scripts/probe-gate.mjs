import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateFeed } from '../server/gate.mjs';

const directory = mkdtempSync(join(tmpdir(), 'pearl-gate-probe-'));
const counts = {};
const feed = createGateFeed({ storePath: join(directory, 'gate.sqlite'), onFrame: (frame) => { counts[frame.type] = (counts[frame.type] ?? 0) + 1; } });
try {
  await feed.start();
  await new Promise((resolve) => setTimeout(resolve, 16000));
  const overview = feed.getOverview(), book = feed.getFullDepth();
  console.log(JSON.stringify({ pair: overview.pair, price: overview.price, stats24h: overview.stats24h, status: feed.getStatus(),
    bids: book.bids.length, asks: book.asks.length, trades: overview.trades.length, frames: counts,
    candles: Object.fromEntries(['1m', '5m', '15m', '1h', '4h', '1d'].map((interval) => {
      const series = feed.getCandles(interval);
      return [interval, { count: series.candles.length, from: series.candles[0]?.time, through: series.candles.at(-1)?.time }];
    })),
  }, null, 2));
} finally { feed.stop(); rmSync(directory, { recursive: true, force: true }); }
