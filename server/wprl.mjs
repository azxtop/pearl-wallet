import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { normalizeCandle, PERIODS } from './safetrade-data.mjs';
import { createWprlStore } from './wprl-store.mjs';

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
  const amount = Number(amount0 < 0n ? -amount0 : amount0) / 1e8;
  const turnover = Number(amount1 < 0n ? -amount1 : amount1) / 1e6;
  const price = turnover > 0 && amount > 0 ? turnover / amount : (Number(sqrt) / 2 ** 96) ** 2 * 100;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) return null;
  return { id: `${log.transactionHash}:${log.logIndex}`, price, amount, turnover, time, side: amount0 < 0n ? 'buy' : 'sell', blockNumber: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)) };
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

export function combineWprlCandles(reference, recorded, startTime, interval) {
  const period = PERIODS[interval] * 60;
  if (!period) throw new Error('Unsupported interval');
  const boundary = Math.floor(startTime / period) * period;
  const prior = reference.filter((candle) => candle.time < boundary);
  return { candles: [...prior, ...recorded].slice(-300), source: prior.length ? 'mixed' : 'recorded' };
}

export function readInfuraKeys(path) {
  if (!path) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT api_key FROM infura_keys WHERE available = 1').all()
      .map((row) => String(row.api_key)).filter((key) => /^[a-f0-9]{32}$/i.test(key));
  } finally { db.close(); }
}

export function createWprlFeed({ keyDbPath = '', cachePath = '', storePath = '', onFrame = () => {}, fetcher = fetch } = {}) {
  const keys = readInfuraKeys(keyDbPath);
  const store = storePath ? createWprlStore(storePath) : null;
  let nextKey = 0;
  const cooling = new Map();
  const series = new Map();
  const geckoCache = new Map();
  const blockTimes = new Map();
  let overview = null;
  let overviewAt = 0;
  let overviewPending = null;
  let latestTrade = store?.latest() || null;
  let socket = null;
  let timer = null;
  let reconnect = null;
  let stopped = false;
  let polling = false;
  let geckoCooldownUntil = 0;
  let persistTimer = null;
  let lastPrune = 0;

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

  function referenceCandles(interval) {
    const direct = series.get(interval)?.value;
    if (direct?.candles?.length) return direct.volumeUnit === 'WPRL'
      ? direct.candles : direct.candles.map((candle) => ({ ...candle, volume: candle.volume / candle.close }));
    const finer = Object.keys(FRAMES).filter((key) => PERIODS[key] < PERIODS[interval]
      && PERIODS[interval] % PERIODS[key] === 0 && series.get(key)?.value?.candles?.length)
      .sort((a, b) => PERIODS[b] - PERIODS[a])[0];
    if (!finer) return [];
    return aggregateWprlCandles(referenceCandles(finer), interval);
  }

  function providerResponse(value, recording) {
    return { ...value, candles: value.volumeUnit === 'WPRL' ? value.candles
      : value.candles.map((candle) => ({ ...candle, volume: candle.volume / candle.close })),
    source: 'provider', recordingSince: recording?.startTime * 1000 || null };
  }

  async function getCandles(interval) {
    if (!FRAMES[interval]) throw new Error('Unsupported interval');
    const recorded = store?.candles(interval);
    const recording = store?.state();
    if (recorded?.length) {
      const merged = combineWprlCandles(referenceCandles(interval), recorded, recording.startTime, interval);
      return {
        interval, ...merged, updatedAt: Math.max(recording.coveredTime, store.latest()?.time || 0) * 1000,
        recordingSince: recording.startTime * 1000, syncedThrough: recording.coveredTime * 1000,
      };
    }
    const cached = series.get(interval);
    if (cached?.value && Date.now() - cached.at < 30_000) return providerResponse(cached.value, recording);
    if (cached?.pending) return cached.value ? providerResponse(cached.value, recording) : cached.pending;
    const pending = gecko(candlePath(interval), interval === '1m' ? 30_000 : interval === '1h' ? 300_000 : 120_000).then(({ value: payload, at }) => {
      const candles = normalizeWprlCandles(payload, interval);
      const value = { interval, candles: candles.slice(-300), updatedAt: at };
      series.set(interval, { value, at });
      persist();
      return providerResponse(value, recording);
    }).catch((error) => {
      const source = interval === '4h' || interval === '1d'
        ? series.get('1h')?.value || series.get('1m')?.value : series.get('1m')?.value;
      const fallback = source?.candles?.length ? { interval, candles: aggregateWprlCandles(source.candles, interval), updatedAt: source.updatedAt } : null;
      series.set(interval, { value: cached?.value || fallback, at: Date.now() - 15_000 });
      if (fallback) persist();
      if (cached?.value) return providerResponse(cached.value, recording);
      if (fallback) return providerResponse(fallback, recording);
      throw error;
    });
    series.set(interval, { ...cached, pending });
    return cached?.value ? providerResponse(cached.value, recording) : pending;
  }

  async function getOverview() {
    if (overview && Date.now() - overviewAt < 15_000) return overview;
    if (overviewPending) return overview || overviewPending;
    overviewPending = (async () => {
      const [pool, hourly] = await Promise.allSettled([
        gecko('', 30_000),
        gecko('/ohlcv/hour?aggregate=1&limit=300&currency=token&token=base', 300_000),
      ]);
      if (pool.status === 'rejected' && !overview && !store?.latest()) throw new Error('WPRL market unavailable');
      const attr = pool.status === 'fulfilled' ? pool.value.value?.data?.attributes : null;
      const recent = store?.recent(20) || [];
      const candles24h = hourly.status === 'fulfilled' ? normalizeWprlCandles(hourly.value.value, '1h').slice(-24) : [];
      const price = number(attr?.base_token_price_quote_token) ?? latestTrade?.price ?? overview?.price ?? null;
      const turnover = number(attr?.volume_usd?.h24);
      const recorded24h = store?.state()?.coveredTime >= Date.now() / 1000 - 120 ? store.stats24h() : null;
      const rpcTrade = latestTrade && latestTrade.time > Date.now() / 1000 - 120 ? latestTrade : null;
      const combined = recent.slice(0, 20);
      overview = {
        pair: 'WPRL/USDT', price: rpcTrade?.price ?? price,
        stats24h: recorded24h || {
          high: candles24h.length ? Math.max(...candles24h.map((item) => item.high)) : overview?.stats24h?.high ?? null,
          low: candles24h.length ? Math.min(...candles24h.map((item) => item.low)) : overview?.stats24h?.low ?? null,
          volume: price && turnover ? turnover / price : overview?.stats24h?.volume ?? null, turnover: turnover ?? overview?.stats24h?.turnover ?? null,
          changePercent: number(attr?.price_change_percentage?.h24) ?? overview?.stats24h?.changePercent ?? null,
        },
        depth: { asks: [], bids: [] }, trades: combined, liquidityUsd: number(attr?.reserve_in_usd) ?? overview?.liquidityUsd ?? null,
        statsSource: recorded24h ? 'recorded' : 'provider',
        marketError: pool.status === 'rejected' || (!recorded24h && hourly.status === 'rejected') ? '部分链上行情暂不可用' : null,
        recordingSince: store?.state()?.startTime * 1000 || null,
        updatedAt: rpcTrade ? rpcTrade.time * 1000 : pool.status === 'fulfilled' ? pool.value.at : overview?.updatedAt ?? Date.now(),
      };
      overviewAt = Date.now();
      persist();
      onFrame({ type: 'overview', data: overview });
      return overview;
    })().finally(() => { overviewPending = null; });
    return overview || overviewPending;
  }

  async function blockTime(blockHex, blockHash = '') {
    const key = blockHash || blockHex;
    if (blockTimes.has(key)) return blockTimes.get(key);
    const block = blockHash
      ? await rpc('eth_getBlockByHash', [blockHash, false])
      : await rpc('eth_getBlockByNumber', [blockHex, false]);
    if (!block?.timestamp) throw new Error('Block timestamp unavailable');
    const time = Number(BigInt(block.timestamp));
    blockTimes.set(key, time);
    if (blockTimes.size > 250) blockTimes.delete(blockTimes.keys().next().value);
    return time;
  }

  function publishRecorded() {
    if (!store) return;
    latestTrade = store.latest();
    const updatedAt = Date.now();
    if (overview) {
      overview = { ...overview, price: latestTrade?.price ?? overview.price, trades: store.recent(20), updatedAt };
      overviewAt = updatedAt;
      onFrame({ type: 'overview-patch', data: { price: overview.price, trades: overview.trades, updatedAt } });
    }
    for (const interval of Object.keys(FRAMES)) {
      const candle = store.candles(interval, 1).at(-1);
      if (candle) onFrame({ type: 'candle', interval, candle, updatedAt });
    }
  }

  async function processLog(log) {
    if (!store || !log?.transactionHash || !log?.blockNumber) return;
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (log.removed) {
      if (store.remove(id, log.blockHash)) publishRecorded();
      return;
    }
    const trade = parseSwap(log, await blockTime(log.blockNumber, log.blockHash));
    if (!trade || !store.live(trade, log.blockHash)) return;
    publishRecorded();
  }

  async function poll() {
    if (polling || stopped || !keys.length || !store) return;
    polling = true;
    try {
      const head = Number(BigInt(await rpc('eth_blockNumber', [])));
      if (!store.state()) store.initialize(head, await blockTime(`0x${head.toString(16)}`));
      const current = store.state();
      let from = Math.max(current.startBlock, current.cursor - 19);
      while (from <= head) {
        const end = Math.min(head, from + 249);
        const logs = await rpc('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}`, address: WPRL_POOL, topics: [SWAP_TOPIC] }]);
        if (!Array.isArray(logs)) throw new Error('Invalid WPRL log response');
        const trades = [];
        for (const log of logs || []) {
          const trade = parseSwap(log, await blockTime(log.blockNumber, log.blockHash));
          if (trade) trades.push({ trade, blockHash: log.blockHash });
        }
        blockTimes.delete(`0x${end.toString(16)}`);
        const priorMinute = Math.floor(store.state().coveredTime / 60);
        const changed = store.reconcile(from, end, trades, await blockTime(`0x${end.toString(16)}`));
        if (changed.length || Math.floor(store.state().coveredTime / 60) > priorMinute) publishRecorded();
        from = end + 1;
      }
      if (Date.now() - lastPrune > 86_400_000) { store.prune(); lastPrune = Date.now(); }
    } catch (error) { console.warn(`WPRL scan deferred: ${error.message}`); }
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
