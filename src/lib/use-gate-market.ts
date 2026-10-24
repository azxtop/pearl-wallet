import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGateCandles, loadGateOverview, openGateStream, type MarketData, type MarketStreamFrame } from './safetrade';
import { loadGateMarketCache, MARKET_INTERVALS, saveGateMarketCache, type MarketInterval } from './market-cache';

export function useGateMarket(enabled: boolean, interval: MarketInterval) {
  const [cache, setCache] = useState(loadGateMarketCache);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const activeInterval = useRef(interval);
  activeInterval.current = interval;
  const socketRef = useRef<WebSocket | null>(null);
  const overviewRequest = useRef<Promise<void> | null>(null);
  const candleRequests = useRef(new Map<MarketInterval, Promise<void>>());
  const liveCandles = useRef(new Map<string, { candle: MarketData['candles'][number]; updatedAt: number }>());
  useEffect(() => { saveGateMarketCache(cache); }, [cache]);

  const refreshOverview = useCallback(() => {
    if (overviewRequest.current) return overviewRequest.current;
    const pending = loadGateOverview().then((overview) => {
      setCache((previous) => !previous.overview || overview.updatedAt >= previous.overview.updatedAt ? { ...previous, overview } : previous);
      setError('');
    }).catch(() => setError('Gate 行情暂不可用')).finally(() => { overviewRequest.current = null; });
    overviewRequest.current = pending;
    return pending;
  }, []);
  const refreshCandles = useCallback((target: MarketInterval, visible = true) => {
    const existing = candleRequests.current.get(target);
    if (existing) return existing;
    if (visible && target === activeInterval.current) setRefreshing(true);
    const pending = loadGateCandles(target).then((series) => {
      if (series.interval !== target) throw new Error('K 线周期不匹配');
      const rows = new Map(series.candles.map((candle) => [candle.time, candle]));
      let updatedAt = series.updatedAt;
      for (const [key, value] of liveCandles.current) {
        if (!key.startsWith(`${target}:`) || value.updatedAt < series.updatedAt) continue;
        rows.set(value.candle.time, value.candle); updatedAt = Math.max(updatedAt, value.updatedAt);
      }
      const candles = [...rows.values()].sort((a, b) => a.time - b.time).slice(-300);
      setCache((previous) => ({ ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt } } }));
      setError('');
    }).catch(() => setError('Gate K 线暂不可用')).finally(() => {
      candleRequests.current.delete(target);
      if (target === activeInterval.current) setRefreshing(false);
    });
    candleRequests.current.set(target, pending);
    return pending;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false, retry = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => { clearTimeout(retryTimer); const socket = socketRef.current; socketRef.current = null; socket?.close(); };
    const connect = () => {
      if (stopped || document.hidden || socketRef.current) return;
      const socket = openGateStream(); socketRef.current = socket;
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        retry = 1000;
        socket.send(JSON.stringify({ type: 'subscribe', interval: activeInterval.current }));
        void refreshOverview(); void refreshCandles(activeInterval.current, false);
      };
      socket.onmessage = ({ data }) => {
        if (socketRef.current !== socket) return;
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === 'overview' && Number.isFinite(frame.data?.updatedAt)) {
          setCache((previous) => !previous.overview || frame.data.updatedAt >= previous.overview.updatedAt ? { ...previous, overview: frame.data } : previous);
          setError('');
        } else if (frame.type === 'overview-patch' && Number.isFinite(frame.data?.updatedAt)) {
          setCache((previous) => previous.overview && frame.data.updatedAt >= previous.overview.updatedAt ? { ...previous, overview: { ...previous.overview, ...frame.data } } : previous);
        } else if (frame.type === 'trades' && Array.isArray(frame.trades)) {
          setCache((previous) => {
            if (!previous.overview || frame.updatedAt < previous.overview.updatedAt) return previous;
            const rows = new Map([...previous.overview.trades, ...frame.trades].map((row) => [row.id, row]));
            return { ...previous, overview: { ...previous.overview, trades: [...rows.values()].sort((a, b) => b.time - a.time).slice(0, 20), price: frame.price ?? previous.overview.price, updatedAt: frame.updatedAt } };
          });
        } else if (frame.type === 'candle' && MARKET_INTERVALS.includes(frame.interval as MarketInterval) && Number.isFinite(frame.candle?.time)) {
          const target = frame.interval as MarketInterval;
          liveCandles.current.set(`${target}:${frame.candle.time}`, { candle: frame.candle, updatedAt: frame.updatedAt });
          if (liveCandles.current.size > 300) liveCandles.current.delete(liveCandles.current.keys().next().value!);
          setCache((previous) => {
            const series = previous.series[target];
            if (!series || frame.updatedAt < series.updatedAt) return previous;
            const rows = new Map(series.candles.map((row) => [row.time, row])); rows.set(frame.candle.time, frame.candle);
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles: [...rows.values()].sort((a, b) => a.time - b.time).slice(-300), updatedAt: frame.updatedAt } } };
          });
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (!stopped && !document.hidden) { retryTimer = setTimeout(connect, retry); retry = Math.min(30_000, retry * 2); }
      };
    };
    const onVisibility = () => { if (document.hidden) close(); else { void refreshOverview(); void refreshCandles(activeInterval.current, false); connect(); } };
    void refreshOverview(); void refreshCandles(activeInterval.current); connect();
    // Warm the small set of chart periods so later switches can use local data.
    void (async () => { for (const target of MARKET_INTERVALS) { if (stopped) break; if (target !== activeInterval.current) await refreshCandles(target, false); } })();
    const overviewTimer = setInterval(() => { if (!document.hidden) void refreshOverview(); }, 30_000);
    const candleTimer = setInterval(() => { if (!document.hidden) void refreshCandles(activeInterval.current, false); }, 60_000);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stopped = true; close(); clearInterval(overviewTimer); clearInterval(candleTimer); document.removeEventListener('visibilitychange', onVisibility); };
  }, [enabled, refreshOverview, refreshCandles]);
  useEffect(() => {
    if (!enabled) return;
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: 'subscribe', interval }));
    void refreshCandles(interval);
  }, [enabled, interval, refreshCandles]);

  const series = cache.series[interval], overview = cache.overview;
  const exchange: MarketData | null = overview || series ? {
    pair: 'PEARL/USDT', price: overview?.price ?? series?.candles.at(-1)?.close ?? null, stats24h: overview?.stats24h ?? null,
    candles: series?.candles ?? [], depth: overview?.depth ?? { bids: [], asks: [] }, trades: overview?.trades ?? [],
    marketError: overview?.marketError ?? null, updatedAt: Math.max(overview?.updatedAt ?? 0, series?.updatedAt ?? 0),
  } : null;
  return { exchange, series, error, refreshing, refreshOverview, refreshCandles };
}
