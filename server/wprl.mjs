import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { normalizeCandle, PERIODS } from './safetrade-data.mjs';

export const WPRL_POOL = '0x89a67c6dee35db9815da2fb9191f0998a8b37c39';
export const WPRL_TOKEN = '0x07696dcab55e62cfef953666b29fe1970518cb00';
export const USDT_TOKEN = '0xdac17f958d2ee523a2206206994597c13d831ec7';
export const SWAP_TOPIC = `0x${bytesToHex(keccak_256(new TextEncoder().encode('Swap(address,address,int256,int256,uint160,uint128,int24)')))}`;
const GECKO_BASE = `https://api.geckoterminal.com/api/v2/networks/eth/pools/${WPRL_POOL}`;
const FRAMES = Object.freeze({ '1m': ['minute', 1], '5m': ['minute', 5], '15m': ['minute', 15], '1h': ['hour', 1], '4h': ['hour', 4], '1d': ['day', 1] });
const signed = (hex) => { const value = BigInt(hex); return value >= 1n << 255n ? value - (1n << 256n) : value; };
const number = (value) => { const result = Number(value); return Number.isFinite(result) ? result : null; };

export function parseSwap(log, time) {
  if (log?.address?.toLowerCase() !== WPRL_POOL || log?.topics?.[0]?.toLowerCase() !== SWAP_TOPIC || !Number.isFinite(time)) return null;
  const data = String(log.data || '').replace(/^0x/, '');
  if (!/^[0-9a-f]{320}$/i.test(data)) return null;
  const words = data.match(/.{64}/g);
  const amount0 = signed(`0x${words[0]}`);
  const amount1 = signed(`0x${words[1]}`);
  const sqrt = BigInt(`0x${words[2]}`);
  const price = (Number(sqrt) / 2 ** 96) ** 2 * 100;
  const amount = Number(amount0 < 0n ? -amount0 : amount0) / 1e8;
  const turnover = Number(amount1 < 0n ? -amount1 : amount1) / 1e6;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) return null;
  return { id: `${log.transactionHash}:${log.logIndex}`, price, amount, turnover, time, side: amount0 < 0n ? 'buy' : 'sell', blockNumber: Number(BigInt(log.blockNumber)) };
}

export function normalizeWprlCandles(payload, interval) {
  if (!FRAMES[interval] || !Array.isArray(payload?.data?.attributes?.ohlcv_list)) throw new Error('Invalid WPRL candles');
  return payload.data.attributes.ohlcv_list.map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time).slice(-300);
}

function normalizeGeckoTrade(row) {
  const item = row?.attributes;
  if (!item || (item.kind !== 'buy' && item.kind !== 'sell')) return null;
  const wprlFrom = item.from_token_address?.toLowerCase() === WPRL_TOKEN;
  const wprlTo = item.to_token_address?.toLowerCase() === WPRL_TOKEN;
  if (!wprlFrom && !wprlTo) return null;
  const amount = number(wprlFrom ? item.from_token_amount : item.to_token_amount);
  const quoteAmount = number(wprlFrom ? item.to_token_amount : item.from_token_amount);
  const price = amount && quoteAmount ? quoteAmount / amount : null;
  const time = Math.floor(Date.parse(item.block_timestamp) / 1000);
  if (!amount || !price || !Number.isFinite(time)) return null;
  return { id: String(row.id), price, amount, time, side: item.kind };
}

export function readInfuraKeys(path) {
  if (!path) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT api_key FROM infura_keys WHERE available = 1').all()
      .map((row) => String(row.api_key)).filter((key) => /^[a-f0-9]{32}$/i.test(key));
  } finally { db.close(); }
}

export function createWprlFeed({ keyDbPath = '', onFrame = () => {}, fetcher = fetch } = {}) {
  const keys = readInfuraKeys(keyDbPath);
  let nextKey = 0;
  const cooling = new Map();
  const series = new Map();
  const blockTimes = new Map();
  const seen = new Set();
  let overview = null;
  let overviewAt = 0;
  let overviewPending = null;
  let lastBlock = null;
  let latestTrade = null;
  let socket = null;
  let timer = null;
  let reconnect = null;
  let stopped = false;
  let polling = false;

  function pickKey() {
    if (!keys.length) throw new Error('Infura keys unavailable');
    for (let checked = 0; checked < keys.length; checked++) {
      const index = nextKey++ % keys.length;
      if ((cooling.get(index) || 0) <= Date.now()) return { key: keys[index], index };
    }
    throw new Error('Infura keys cooling down');
  }

  async function rpc(method, params) {
    let failure;
    for (let attempt = 0; attempt < Math.min(keys.length, 4); attempt++) {
      const { key, index } = pickKey();
      try {
        const response = await fetcher(`https://mainnet.infura.io/v3/${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(`RPC ${response.status} ${body.error?.code || ''}`);
        return body.result;
      } catch (error) {
        failure = error;
        cooling.set(index, Date.now() + 60_000);
      }
    }
    throw failure || new Error('RPC unavailable');
  }

  async function gecko(path) {
    const response = await fetcher(`${GECKO_BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'PearlWallet/0.2' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`GeckoTerminal ${response.status}`);
    return response.json();
  }

  function candlePath(interval) {
    const [frame, aggregate] = FRAMES[interval];
    return `/ohlcv/${frame}?aggregate=${aggregate}&limit=300&currency=token&token=base`;
  }

  async function getCandles(interval) {
    if (!FRAMES[interval]) throw new Error('Unsupported interval');
    const cached = series.get(interval);
    if (cached?.value && Date.now() - cached.at < 30_000) return cached.value;
    if (cached?.pending) return cached.value || cached.pending;
    const pending = gecko(candlePath(interval)).then((payload) => {
      const candles = normalizeWprlCandles(payload, interval);
      if (latestTrade && candles.length) {
        const time = Math.floor(latestTrade.time / (PERIODS[interval] * 60)) * PERIODS[interval] * 60;
        const last = candles.at(-1);
        if (time === last.time) candles[candles.length - 1] = { ...last, high: Math.max(last.high, latestTrade.price), low: Math.min(last.low, latestTrade.price), close: latestTrade.price, empty: false };
        else if (time > last.time) candles.push({ time, open: latestTrade.price, high: latestTrade.price, low: latestTrade.price, close: latestTrade.price, volume: latestTrade.turnover, empty: false });
      }
      const value = { interval, candles: candles.slice(-300), updatedAt: Date.now() };
      series.set(interval, { value, at: Date.now() });
      return value;
    }).catch((error) => {
      series.set(interval, { value: cached?.value, at: Date.now() - 15_000 });
      if (cached?.value) return cached.value;
      throw error;
    });
    series.set(interval, { ...cached, pending });
    return cached?.value || pending;
  }

  async function getOverview() {
    if (overview && Date.now() - overviewAt < 15_000) return overview;
    if (overviewPending) return overview || overviewPending;
    overviewPending = (async () => {
      const [pool, trades, hourly] = await Promise.allSettled([
        gecko(''), gecko('/trades?trade_volume_in_usd_greater_than=0'),
        gecko('/ohlcv/hour?aggregate=1&limit=24&currency=token&token=base'),
      ]);
      if (pool.status === 'rejected' && !overview) throw new Error('WPRL market unavailable');
      const attr = pool.status === 'fulfilled' ? pool.value?.data?.attributes : null;
      const recent = trades.status === 'fulfilled' ? trades.value?.data?.map(normalizeGeckoTrade).filter(Boolean) || [] : [];
      const candles24h = hourly.status === 'fulfilled' ? normalizeWprlCandles(hourly.value, '1h') : [];
      const price = number(attr?.base_token_price_quote_token) ?? overview?.price ?? null;
      const turnover = number(attr?.volume_usd?.h24);
      const rpcTrade = latestTrade && latestTrade.time > Date.now() / 1000 - 120 ? latestTrade : null;
      const combined = [...(rpcTrade ? [rpcTrade] : []), ...recent].filter((item, index, rows) => rows.findIndex((other) => other.id === item.id) === index)
        .sort((a, b) => b.time - a.time).slice(0, 20);
      overview = {
        pair: 'WPRL/USDT', price: rpcTrade?.price ?? price,
        stats24h: {
          high: candles24h.length ? Math.max(...candles24h.map((item) => item.high)) : overview?.stats24h?.high ?? null,
          low: candles24h.length ? Math.min(...candles24h.map((item) => item.low)) : overview?.stats24h?.low ?? null,
          volume: price && turnover ? turnover / price : null, turnover: turnover ?? overview?.stats24h?.turnover ?? null,
          changePercent: number(attr?.price_change_percentage?.h24) ?? overview?.stats24h?.changePercent ?? null,
        },
        depth: { asks: [], bids: [] }, trades: combined, liquidityUsd: number(attr?.reserve_in_usd),
        marketError: pool.status === 'rejected' || trades.status === 'rejected' || hourly.status === 'rejected' ? '部分链上行情暂不可用' : null,
        updatedAt: Date.now(),
      };
      overviewAt = Date.now();
      onFrame({ type: 'overview', data: overview });
      return overview;
    })().finally(() => { overviewPending = null; });
    return overview || overviewPending;
  }

  async function blockTime(blockHex) {
    if (blockTimes.has(blockHex)) return blockTimes.get(blockHex);
    const block = await rpc('eth_getBlockByNumber', [blockHex, false]);
    if (!block?.timestamp) throw new Error('Block timestamp unavailable');
    const time = Number(BigInt(block.timestamp));
    blockTimes.set(blockHex, time);
    if (blockTimes.size > 250) blockTimes.delete(blockTimes.keys().next().value);
    return time;
  }

  async function processLog(log) {
    if (log?.removed || !log?.transactionHash || !log?.blockNumber) return;
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id)) return;
    const trade = parseSwap(log, await blockTime(log.blockNumber));
    if (!trade) return;
    seen.add(id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    if (!latestTrade || trade.blockNumber >= latestTrade.blockNumber) latestTrade = trade;
    if (overview) {
      overview = { ...overview, price: latestTrade.price, trades: [trade, ...overview.trades.filter((item) => item.id !== id)].sort((a, b) => b.time - a.time).slice(0, 20), updatedAt: Date.now() };
      overviewAt = Date.now();
      onFrame({ type: 'overview-patch', data: { price: overview.price, trades: overview.trades, updatedAt: overview.updatedAt } });
    }
    for (const [interval, entry] of series) {
      if (!entry.value?.candles.length) continue;
      const candleTime = Math.floor(trade.time / (PERIODS[interval] * 60)) * PERIODS[interval] * 60;
      const candles = entry.value.candles.slice();
      const last = candles.at(-1);
      if (candleTime < last.time) continue;
      const candle = candleTime === last.time
        ? { ...last, high: Math.max(last.high, trade.price), low: Math.min(last.low, trade.price), close: trade.price, empty: false }
        : { time: candleTime, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.turnover, empty: false };
      if (candleTime === last.time) candles[candles.length - 1] = candle;
      else { candles.push(candle); if (candles.length > 300) candles.shift(); }
      const value = { interval, candles, updatedAt: Date.now() };
      series.set(interval, { value, at: entry.at });
      onFrame({ type: 'candle', interval, candle, updatedAt: value.updatedAt });
    }
  }

  async function poll() {
    if (polling || stopped || !keys.length) return;
    polling = true;
    try {
      const head = Number(BigInt(await rpc('eth_blockNumber', [])));
      if (lastBlock === null) lastBlock = Math.max(0, head - 150);
      while (lastBlock < head) {
        const end = Math.min(head, lastBlock + 250);
        const logs = await rpc('eth_getLogs', [{ fromBlock: `0x${(lastBlock + 1).toString(16)}`, toBlock: `0x${end.toString(16)}`, address: WPRL_POOL, topics: [SWAP_TOPIC] }]);
        for (const log of logs || []) await processLog(log);
        lastBlock = end;
      }
    } catch { /* The next poll retries with another key; REST market data remains available. */ }
    finally { polling = false; }
  }

  function connect() {
    if (stopped || !keys.length || socket) return;
    let selected;
    try { selected = pickKey(); } catch { reconnect = setTimeout(connect, 30_000); return; }
    const current = new WebSocket(`wss://mainnet.infura.io/ws/v3/${selected.key}`, { handshakeTimeout: 10_000 });
    socket = current;
    current.on('open', () => current.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: WPRL_POOL, topics: [SWAP_TOPIC] }] })));
    current.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.error) { cooling.set(selected.index, Date.now() + 60_000); current.close(); return; }
      if (frame.method === 'eth_subscription') void processLog(frame.params?.result).catch(() => {});
    });
    current.on('error', () => current.close());
    current.on('close', () => {
      if (socket !== current) return;
      socket = null;
      if (!stopped) reconnect = setTimeout(connect, 5_000);
    });
  }

  return {
    getOverview, getCandles, currentOverview: () => overview,
    start() {
      stopped = false;
      void getOverview().catch(() => {});
      void getCandles('1m').catch(() => {});
      if (keys.length) { void poll(); timer = setInterval(poll, 15_000); connect(); }
    },
    stop() { stopped = true; if (timer) clearInterval(timer); if (reconnect) clearTimeout(reconnect); socket?.close(); },
    keyCount: keys.length,
  };
}
