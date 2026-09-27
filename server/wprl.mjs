import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
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

export function aggregateWprlCandles(candles, interval) {
  if (!PERIODS[interval]) throw new Error('Unsupported interval');
  const period = PERIODS[interval] * 60;
  const grouped = [];
  for (const candle of candles) {
    const time = Math.floor(candle.time / period) * period;
    const last = grouped.at(-1);
    if (last?.time === time) {
      last.high = Math.max(last.high, candle.high);
      last.low = Math.min(last.low, candle.low);
      last.close = candle.close;
      last.volume += candle.volume;
      last.empty = last.empty && candle.empty;
    } else grouped.push({ ...candle, time });
  }
  return grouped.slice(-300);
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

export function createWprlFeed({ keyDbPath = '', cachePath = '', onFrame = () => {}, fetcher = fetch } = {}) {
  const keys = readInfuraKeys(keyDbPath);
  let nextKey = 0;
  const cooling = new Map();
  const series = new Map();
  const geckoCache = new Map();
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
  let geckoCooldownUntil = 0;
  let persistTimer = null;

  if (cachePath) {
    try {
      const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (saved.overview?.pair === 'WPRL/USDT') {
        overview = saved.overview;
        overviewAt = Number(saved.overview.updatedAt) || 0;
      }
      for (const [interval, value] of Object.entries(saved.series || {})) {
        if (FRAMES[interval] && Array.isArray(value?.candles)) series.set(interval, { value, at: Number(value.updatedAt) || 0 });
      }
    } catch { /* Start with empty public market data. */ }
  }

  function persist() {
    if (!cachePath || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const snapshot = JSON.stringify({ overview, series: Object.fromEntries([...series].filter(([, entry]) => entry.value).map(([key, entry]) => [key, entry.value])) });
      void writeFile(`${cachePath}.tmp`, snapshot, { mode: 0o600 })
        .then(() => rename(`${cachePath}.tmp`, cachePath)).catch(() => {});
    }, 2000);
  }

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

  async function gecko(path, ttl) {
    const cached = geckoCache.get(path);
    if (cached?.value && Date.now() - cached.at < ttl) return cached;
    if (cached?.pending) return cached.value ? cached : cached.pending;
    if (Date.now() < geckoCooldownUntil) {
      if (cached?.value) return cached;
      throw new Error('GeckoTerminal cooling down');
    }
    const pending = (async () => {
      const response = await fetcher(`${GECKO_BASE}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'PearlWallet/0.2' }, signal: AbortSignal.timeout(12_000) });
      if (response.status === 429) {
        const retry = Number(response.headers?.get?.('Retry-After'));
        geckoCooldownUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : 60_000);
      }
      if (!response.ok) throw new Error(`GeckoTerminal ${response.status}`);
      const value = await response.json();
      const entry = { value, at: Date.now() };
      geckoCache.set(path, entry);
      return entry;
    })().catch((error) => {
      if (cached?.value) geckoCache.set(path, { value: cached.value, at: cached.at });
      else geckoCache.delete(path);
      if (cached?.value) return cached;
      throw error;
    });
    geckoCache.set(path, { ...cached, pending });
    return cached?.value ? cached : pending;
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
    const pending = gecko(candlePath(interval), interval === '1m' ? 30_000 : interval === '1h' ? 300_000 : 120_000).then(({ value: payload, at }) => {
      const candles = normalizeWprlCandles(payload, interval);
      if (latestTrade && candles.length) {
        const time = Math.floor(latestTrade.time / (PERIODS[interval] * 60)) * PERIODS[interval] * 60;
        const last = candles.at(-1);
        if (time === last.time) candles[candles.length - 1] = { ...last, high: Math.max(last.high, latestTrade.price), low: Math.min(last.low, latestTrade.price), close: latestTrade.price, empty: false };
        else if (time > last.time) candles.push({ time, open: latestTrade.price, high: latestTrade.price, low: latestTrade.price, close: latestTrade.price, volume: latestTrade.turnover, empty: false });
      }
      const value = { interval, candles: candles.slice(-300), updatedAt: at };
      series.set(interval, { value, at });
      persist();
      return value;
    }).catch((error) => {
      const source = interval === '4h' || interval === '1d'
        ? series.get('1h')?.value || series.get('1m')?.value : series.get('1m')?.value;
      const fallback = source?.candles?.length ? { interval, candles: aggregateWprlCandles(source.candles, interval), updatedAt: source.updatedAt } : null;
      series.set(interval, { value: cached?.value || fallback, at: Date.now() - 15_000 });
      if (fallback) persist();
      if (cached?.value) return cached.value;
      if (fallback) return fallback;
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
        gecko('', 30_000), gecko('/trades?trade_volume_in_usd_greater_than=0', 300_000),
        gecko('/ohlcv/hour?aggregate=1&limit=300&currency=token&token=base', 300_000),
      ]);
      if (pool.status === 'rejected' && !overview) throw new Error('WPRL market unavailable');
      const attr = pool.status === 'fulfilled' ? pool.value.value?.data?.attributes : null;
      const recent = trades.status === 'fulfilled' ? trades.value.value?.data?.map(normalizeGeckoTrade).filter(Boolean) || overview?.trades || [] : overview?.trades || [];
      const candles24h = hourly.status === 'fulfilled' ? normalizeWprlCandles(hourly.value.value, '1h').slice(-24) : [];
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
          volume: price && turnover ? turnover / price : overview?.stats24h?.volume ?? null, turnover: turnover ?? overview?.stats24h?.turnover ?? null,
          changePercent: number(attr?.price_change_percentage?.h24) ?? overview?.stats24h?.changePercent ?? null,
        },
        depth: { asks: [], bids: [] }, trades: combined, liquidityUsd: number(attr?.reserve_in_usd) ?? overview?.liquidityUsd ?? null,
        marketError: pool.status === 'rejected' || trades.status === 'rejected' || hourly.status === 'rejected' ? '部分链上行情暂不可用' : null,
        updatedAt: rpcTrade ? rpcTrade.time * 1000 : pool.status === 'fulfilled' ? pool.value.at : overview?.updatedAt ?? Date.now(),
      };
      overviewAt = Date.now();
      persist();
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
      persist();
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
      persist();
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
    stop() { stopped = true; if (timer) clearInterval(timer); if (reconnect) clearTimeout(reconnect); if (persistTimer) clearTimeout(persistTimer); socket?.close(); },
    keyCount: keys.length,
  };
}
