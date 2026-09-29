import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLighterFeed, normalizeLighterCandle, normalizeLighterTrade } from './lighter.mjs';

test('normalizes Lighter public candle and trade fields', () => {
  assert.deepEqual(normalizeLighterCandle({ t: 120000, o: '2', h: '3', l: '1', c: '2.5', v: '4' }),
    { time: 120, open: 2, high: 3, low: 1, close: 2.5, volume: 4, empty: false });
  assert.equal(normalizeLighterCandle({ t: 120000, o: '2', h: '1', l: '1', c: '2.5', v: '4' }), null);
  assert.deepEqual(normalizeLighterTrade({ trade_id_str: '42', price: '2.5', size: '4', timestamp: 120000, is_maker_ask: true }),
    { id: '42', price: 2.5, amount: 4, time: 120, side: 'buy' });
  assert.equal(normalizeLighterTrade({ trade_id_str: '42', price: '2.5', size: '0', timestamp: 120000 }), null);
});

test('discovers PRL perpetual, records sparse minute bars, and keeps them after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pearl-lighter-'));
  const path = join(dir, 'lighter.sqlite');
  const base = 1_800_000_000_000;
  const end = base + 5 * 60_000;
  const market = { market_id: 4097, symbol: 'PRL', market_type: 'perp', status: 'active', is_frozen: false,
    last_trade_price: '2.5', daily_price_high: '3', daily_price_low: '2', daily_base_token_volume: '100', daily_quote_token_volume: '250', daily_price_change: '1.2', mark_price: '2.4', index_price: '2.3', current_funding_rate: '0.0001', open_interest: '20' };
  const candle = (minute, o, h, l, c, v) => ({ t: base + minute * 60_000, o, h, l, c, v });
  const rows = [candle(0, '2', '3', '1', '2.5', '4'), candle(2, '2.5', '4', '2', '3', '6')];
  const calls = [];
  const frames = [];
  const fetcher = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const body = path.endsWith('/orderBookDetails') ? { order_book_details: [market] }
      : path.endsWith('/orderBookOrders') ? { bids: [{ price: '2', remaining_base_amount: '5' }], asks: [{ price: '3', remaining_base_amount: '7' }] }
      : path.endsWith('/recentTrades') ? { trades: [
        { trade_id_str: 'new', price: '2.6', size: '1', timestamp: base + 60_000, is_maker_ask: true },
        { trade_id_str: 'old', price: '2.4', size: '1', timestamp: base, is_maker_ask: false },
      ] }
      : path.endsWith('/candles') ? { c: rows } : null;
    assert.ok(body, url);
    return { ok: true, json: async () => ({ code: 200, ...body }) };
  };
  try {
    const feed = createLighterFeed({ storePath: path, fetcher, now: () => end, onFrame: (frame) => frames.push(frame) });
    await feed.refresh();
    assert.equal(feed.contract().marketId, 4097);
    assert.equal(frames[0].type, 'overview');
    assert.equal(feed.getOverview().price, 2.6);
    assert.equal(feed.getOverview().funding, 0.000001);
    assert.equal(feed.getOverview().depth.bids[0].amount, 5);
    await feed.backfill();
    await feed.refresh();
    const minutes = feed.getCandles('1m').candles;
    assert.equal(minutes.find((row) => row.time === base / 1000).close, 2.5);
    assert.equal(minutes.find((row) => row.time === base / 1000 + 60).empty, true);
    assert.equal(minutes.find((row) => row.time === base / 1000 + 120).close, 3);
    const five = feed.getCandles('5m').candles.find((row) => row.time === base / 1000);
    assert.equal(five.high, 4);
    assert.equal(five.low, 1);
    assert.equal(five.volume, 10);
    feed.stop();
    const reopened = createLighterFeed({ storePath: path, fetcher, now: () => end });
    await reopened.refresh();
    assert.equal(reopened.getCandles('1m').candles.find((row) => row.time === base / 1000 + 120).close, 3);
    reopened.stop();
    assert.ok(calls.some((url) => url.includes('orderBookDetails?market_id=4097')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
