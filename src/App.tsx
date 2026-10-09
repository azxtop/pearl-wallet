import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import QRCode from "qrcode";
import { wallet } from "./crypto/client";
import { biometric } from "./lib/biometric";
import { installUpdate } from "./lib/update";
import { isNewerVersion, parseUpdateManifest, UPDATE_MANIFEST_URLS } from "./lib/update-manifest";
import { loadPendingOutgoing, pendingFromBroadcast, projectWalletSnapshot, reconcilePendingOutgoing, savePendingOutgoing } from "./lib/pending-outgoing";
import { broadcastViaExplorer } from "./lib/explorer";
import { WalletSynchronizer } from "./lib/wallet-sync";
import { loadSnapshotCache, saveSnapshotCache, type SnapshotCache } from "./lib/snapshot-cache";
import { formatPrl, isValidPearlAddress, parsePrl } from "./lib/pearl";
import { broadcastPearlTx } from "./lib/rpc";
import { maxSpendable, prepareSend, SEND_FEE_RATES, type SendFeeTier, type SendPreview } from "./lib/send";
import { estimatedSpotAssetsUSDT, totalAssetBalance } from "./lib/asset-balance";
import type { EncryptedWallet } from "./lib/keystore";
import { BIOMETRIC_ADDRESS_KEY, loadProfiles, profileName, saveProfiles, type ProfileStore, type WalletProfile } from "./lib/profiles";
import { profileAddressChoices, loadSavedAddresses, saveSavedAddresses, type SavedAddress } from "./lib/address-book";
import { accountStreamTicket, clearConnectionToken, connectAccount, disconnectAccount, loadAccount, loadMarketCandles, loadMarketOverview, loadFullDepth, loadTradeHistory, openFullDepthStream, loadWprlCandles, loadWprlOverview, loadHyperliquidCandles, loadHyperliquidOverview, loadLighterCandles, loadLighterOverview, loadAsterCandles, loadAsterOverview, openAccountStream, openMarketStream, openWprlStream, openHyperliquidStream, openLighterStream, openAsterStream, savedConnectionToken, saveConnectionToken, type AccountData, type MarketData, type MarketStreamFrame, type TradeSource, type TradeHistoryPage as TradeHistoryResult } from "./lib/safetrade";
import { aggregateDepth, applyDepthDelta, type DepthDelta, type DepthSnapshot } from "./lib/full-depth";
import { chartWindow } from "./lib/chart-window";
import { displayLighterCandles } from "./lib/chart-candles";
import { loadPublicMarketCache, loadWprlMarketCache, loadHyperliquidMarketCache, loadLighterMarketCache, loadAsterMarketCache, MARKET_INTERVALS, savePublicMarketCache, saveWprlMarketCache, saveHyperliquidMarketCache, saveLighterMarketCache, saveAsterMarketCache, type MarketInterval } from "./lib/market-cache";
import { screenPrivacy } from "./lib/screen-privacy";

type Tab = "wallet" | "market" | "setting";
type MarketSource = "safetrade" | "wprl" | "hyperliquid" | "lighter" | "aster";
type WalletPage = "home" | "send" | "receive" | "history";
const UNLOCK_KEY = "pearl-wallet-require-unlock-v1";
const APP_VERSION = "0.2.31";
const PROJECT_URL = "https://pearlwallet.az1993.xyz/";
const SOURCE_URL = "https://github.com/azxtop/pearl-wallet";
const CONTACT_EMAIL = "az1993515909@gmail.com";
const DONATION_ADDRESS = "prl1pm2u7jht5vqqw32k5e2m87dpwhavwwrjnd6d7tjtpsv3l8qzzgdds8d449j";
type Interval = MarketInterval;
const INTERVALS: { id: Interval; label: string }[] = [
  { id: "1m", label: "1分" }, { id: "5m", label: "5分" }, { id: "15m", label: "15分" },
  { id: "1h", label: "1小时" }, { id: "4h", label: "4小时" }, { id: "1d", label: "日线" },
];

function Icon({ name, size = 24 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<string, ReactNode> = {
    send: <><path d="M5 19 19 5M9 5h10v10" /></>,
    receive: <><path d="M19 5 5 19M15 19H5V9" /></>,
    wallet: <><rect x="3" y="6" width="18" height="15" rx="3" /><path d="M3 10h18M6 6V4a1 1 0 0 1 1-1h11" /><circle cx="17" cy="15" r="1" /></>,
    chart: <><path d="M3 19h18M4 15l5-5 4 3 7-8" /><path d="M16 5h4v4" /></>,
    setting: <><circle cx="12" cy="12" r="3" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
    back: <path d="m15 18-6-6 6-6" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 18 7l2 5M4 12l2 5a7 7 0 0 0 12.5-2" /></>,
    shield: <><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /></>,
    finger: <><path d="M8 13v-2a4 4 0 0 1 8 0v2M5 12v-1a7 7 0 0 1 14 0v1M8 16v1c0 2-1 3-2 4m6-10v6c0 2-1 4-2 5m6-6v1c0 2-.5 4-1.5 5m5-8v3" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
  };
  return <svg {...common} aria-hidden="true">{paths[name]}</svg>;
}

function ActionCard({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return <button className="action-card" onClick={onClick}><span className="action-icon"><Icon name={icon} size={22} /></span><span>{label}</span></button>;
}

function Field({ label, value, onChange, type = "text", placeholder, autoComplete }: {
  label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; autoComplete?: string;
}) {
  return <label className="field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} type={type} placeholder={placeholder} autoComplete={autoComplete} /></label>;
}

function CandleChart({ candles, currentPrice, loading = false, status = "", symbol = "PRL" }: { candles: MarketData["candles"]; currentPrice?: number | null; loading?: boolean; status?: string; symbol?: string }) {
  const [visibleCount, setVisibleCount] = useState(80);
  const [offset, setOffset] = useState(0);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [selectedY, setSelectedY] = useState<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; offset: number; count: number; distance: number; dismissOnTap: boolean; mode: "pending" | "pan" | "inspect" | "pinch"; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const viewport = chartWindow(candles.length, visibleCount, offset);
  const data = candles.slice(viewport.firstIndex, viewport.endIndex);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".chart-stage svg")) setSelectedTime(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); if (gesture.current?.timer) clearTimeout(gesture.current.timer); };
  }, []);
  const real = data.filter((item) => Number.isFinite(item.high) && Number.isFinite(item.low));
  if (!real.length) return <div className="chart-empty">{loading ? "正在加载 K 线…" : "暂无成交数据"}</div>;
  const selected = selectedTime === null ? null : data.find((item) => item.time === selectedTime);
  const latestPrice = viewport.endIndex === candles.length
    ? typeof currentPrice === "number" && Number.isFinite(currentPrice) ? currentPrice : candles.at(-1)?.close
    : undefined;
  const latestCandle = candles.at(-1);
  const latestUp = latestCandle ? (latestPrice ?? latestCandle.close) >= latestCandle.open : true;
  const high = Math.max(...real.map((item) => item.high), ...(latestPrice === undefined ? [] : [latestPrice]));
  const low = Math.min(...real.map((item) => item.low), ...(latestPrice === undefined ? [] : [latestPrice]));
  const span = Math.max(high - low, high * 0.003);
  const y = (value: number) => 240 - ((value - low) / span) * 210;
  const priceAtY = (position: number) => low + (240 - position) / 210 * span;
  const priceDigits = Math.max(2, Math.min(8, Math.ceil(-Math.log10(span / 210))));
  const latestY = latestPrice === undefined ? null : y(latestPrice);
  const maxVolume = Math.max(1, ...data.map((item) => item.volume));
  const chartWidth = 640;
  const width = chartWidth / visibleCount;
  const selectedIndex = selected ? data.findIndex((item) => item.time === selected.time) : -1;
  const selectedX = selectedIndex >= 0 ? (viewport.leftSlots + selectedIndex + .5) * width : 0;
  const gridTimes = [1, 2, 3].map((part) => ({ x: 160 * part, candle: data[Math.floor(visibleCount * part / 4) - viewport.leftSlots] }));
  const timeLabel = (time: number) => new Date(time * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  function movingAverage(index: number, period: number) {
    const globalIndex = viewport.firstIndex + index;
    if (globalIndex < period - 1) return null;
    const values = candles.slice(globalIndex - period + 1, globalIndex + 1).map((item) => item.close);
    return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / period : null;
  }
  const maPath = (period: number) => data.map((_, index) => {
    const value = movingAverage(index, period);
    return value === null ? "" : `${index === 0 || movingAverage(index - 1, period) === null ? "M" : "L"}${(viewport.leftSlots + index + .5) * width},${y(value)}`;
  }).join(" ");
  function pointerDistance() {
    const [first, second] = [...pointers.current.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  }
  function selectAt(clientX: number, clientY: number, svg: SVGSVGElement) {
    const rect = svg.getBoundingClientRect();
    const index = Math.floor((clientX - rect.left) / rect.width * visibleCount);
    const candle = data[index - viewport.leftSlots];
    if (!candle) { setSelectedTime(null); return; }
    setSelectedTime(candle.time);
    setSelectedY(Math.max(16, Math.min(260, (clientY - rect.top) / rect.height * 355)));
  }
  function beginPointer(event: React.PointerEvent<SVGSVGElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    if (pointers.current.size > 1) {
      gesture.current = { x: event.clientX, y: event.clientY, offset, count: visibleCount, distance: pointerDistance(), dismissOnTap: false, mode: "pinch", timer: null };
      setSelectedTime(null);
      return;
    }
    const svg = event.currentTarget;
    const current = { x: event.clientX, y: event.clientY, offset, count: visibleCount, distance: 0, dismissOnTap: selectedTime !== null, mode: "pending" as const, timer: null as ReturnType<typeof setTimeout> | null };
    gesture.current = current;
    current.timer = setTimeout(() => {
      if (gesture.current !== current || !pointers.current.has(event.pointerId)) return;
      gesture.current.mode = "inspect";
      const point = pointers.current.get(event.pointerId)!;
      selectAt(point.x, point.y, svg);
    }, 350);
  }
  function movePointer(event: React.PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture.current;
    if (pointers.current.size > 1 && current.mode === "pinch") {
      const distance = pointerDistance();
      if (current.distance > 0 && distance > 0) {
        const count = Math.max(20, Math.min(200, Math.round(current.count * current.distance / distance)));
        setVisibleCount(count);
        setOffset(chartWindow(candles.length, count, current.offset + Math.round((current.count - count) / 2)).offset);
      }
      return;
    }
    if (current.mode === "inspect") { selectAt(event.clientX, event.clientY, event.currentTarget); return; }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.mode === "pending" && Math.hypot(dx, dy) < 8) return;
    if (current.mode === "pending") {
      if (current.timer) clearTimeout(current.timer);
      current.timer = null;
      current.mode = "pan";
      setSelectedTime(null);
    }
    const candlePixels = event.currentTarget.getBoundingClientRect().width / current.count;
    setOffset(chartWindow(candles.length, current.count, current.offset + Math.round(dx / candlePixels)).offset);
  }
  function endPointer(event: React.PointerEvent<SVGSVGElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    if (pointers.current.size === 1 && gesture.current?.mode === "pending") {
      if (gesture.current.dismissOnTap) setSelectedTime(null);
      else selectAt(event.clientX, event.clientY, event.currentTarget);
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.values()][0];
    gesture.current = remaining ? { x: remaining.x, y: remaining.y, offset, count: visibleCount, distance: 0, dismissOnTap: false, mode: "pan", timer: null } : null;
  }
  function cancelPointer(event: React.PointerEvent<SVGSVGElement>) {
    if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    pointers.current.delete(event.pointerId);
    gesture.current = null;
  }
  return <div className="chart-shell">
    <div className="chart-toolbar"><div className="ma-legend"><span>MA(7)</span><span>MA(25)</span><span>MA(99)</span></div><div className="chart-toolbar-actions">{status && <small>{status}</small>}{offset !== 0 && <button className="chart-latest" onClick={() => setOffset(0)}>最新</button>}</div></div>
    <div className="chart-stage"><svg viewBox="0 0 640 355" preserveAspectRatio="none" role="img" aria-label={`${symbol} K 线`} onPointerDown={beginPointer} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={cancelPointer} onWheel={(event) => { if (event.ctrlKey) { setVisibleCount((count) => Math.max(20, Math.min(200, count + (event.deltaY > 0 ? 10 : -10)))); } }}>
      {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="0" x2="640" y1={30 + line * 52} y2={30 + line * 52} className="chart-grid" />)}
      {gridTimes.map(({ x }) => <line key={x} x1={x} x2={x} y1="0" y2="355" className="chart-grid" />)}
      <line x1="0" x2="640" y1="270" y2="270" className="chart-grid" />
      {data.map((item, index) => {
        const x = (viewport.leftSlots + index + .5) * width;
        const up = item.close >= item.open;
        return <g key={item.time} className={item.empty ? "candle empty" : up ? "candle up" : "candle down"}>
          <line x1={x} x2={x} y1={y(item.high)} y2={y(item.low)} />
          <rect x={x - Math.max(1, width * 0.28)} y={Math.min(y(item.open), y(item.close))} width={Math.max(1, Math.min(width - .4, width * .56))} height={Math.max(1, Math.abs(y(item.open) - y(item.close)))} rx="0.5" />
          <rect className="volume-bar" x={x - width * .26} y={350 - item.volume / maxVolume * 72} width={Math.max(1, width * .52)} height={item.volume / maxVolume * 72} />
        </g>;
      })}
      <path d={maPath(7)} className="ma-line ma7" /><path d={maPath(25)} className="ma-line ma25" /><path d={maPath(99)} className="ma-line ma99" />
      {latestY !== null && <line x1="0" x2="640" y1={latestY} y2={latestY} className={`chart-current-line ${latestUp ? "up" : "down"}`} />}
      {selected && <g className="chart-crosshair"><line x1={selectedX} x2={selectedX} y1="0" y2="355" /><line x1="0" x2="640" y1={selectedY ?? y(selected.close)} y2={selectedY ?? y(selected.close)} /><circle cx={selectedX} cy={selectedY ?? y(selected.close)} r="3" /></g>}
      <rect x="0" y="0" width="640" height="355" fill="transparent" pointerEvents="all" />
    </svg>
    {[0, 1, 2, 3, 4].filter((line) => (latestY === null || Math.abs(latestY - (30 + line * 52)) > 13) && (!selected || Math.abs((selectedY ?? y(selected.close)) - (30 + line * 52)) > 13)).map((line) => <span key={line} className="chart-price-label" style={{ top: `${(26 + line * 52) / 355 * 100}%` }}>{marketNumber(low + span * (240 - (30 + line * 52)) / 210, priceDigits)}</span>)}
    {latestY !== null && (!selected || Math.abs((selectedY ?? y(selected.close)) - latestY) > 17) && <span className={`chart-current-price ${latestUp ? "up" : "down"}`} style={{ top: `${latestY / 355 * 100}%` }} aria-label={`当前价格 ${marketNumber(latestPrice, 8)} USDT`}>{marketNumber(latestPrice, 8)}</span>}
    {selected && <span className="chart-inspect-price" style={{ top: `${(selectedY ?? y(selected.close)) / 355 * 100}%` }} aria-label={`指针价格 ${priceAtY(selectedY ?? y(selected.close)).toFixed(priceDigits)} USDT`}>{priceAtY(selectedY ?? y(selected.close)).toFixed(priceDigits)}</span>}
    {gridTimes.filter(({ candle }) => candle).map(({ x, candle }) => <span key={x} className="chart-time-label" style={{ left: `${x / 640 * 100}%` }}>{timeLabel(candle!.time)}</span>)}
    {selected && <div className={`chart-detail-popup ${selectedX > 320 ? "on-left" : "on-right"}`}><div>时间 <strong>{timeLabel(selected.time)}</strong></div><div>开 <strong>{marketNumber(selected.open, 8)}</strong></div><div>高 <strong>{marketNumber(selected.high, 8)}</strong></div><div>低 <strong>{marketNumber(selected.low, 8)}</strong></div><div>收 <strong>{marketNumber(selected.close, 8)}</strong></div><div>涨跌 <strong className={selected.close >= selected.open ? "positive" : "negative"}>{marketNumber(selected.close - selected.open, 8)}</strong></div><div>量 <strong>{compactMarketNumber(selected.volume)} {symbol}</strong></div></div>}
    </div>
  </div>;
}

function marketNumber(value: number | null | undefined, digits = 4) {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function alignedTradeAmount(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function compactMarketNumber(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function OrderBook({ depth, symbol = "PRL", quote = "USDT", priceDecimals }: { depth: MarketData["depth"] | undefined; symbol?: string; quote?: string; priceDecimals?: number }) {
  const asks = depth?.asks ?? [];
  const bids = depth?.bids ?? [];
  const max = Math.max(1, ...asks.map((level) => level.amount), ...bids.map((level) => level.amount));
  const formatPrice = (price: number) => priceDecimals === undefined ? marketNumber(price, 8) : price.toFixed(priceDecimals);
  const formatAmount = (amount: number) => amount < 0.01 ? marketNumber(amount, 8) : amount < 1 ? marketNumber(amount, 4) : compactMarketNumber(amount);
  const row = (level: { price: number; amount: number }, side: "ask" | "bid") => <div className={`book-row ${side}`} key={`${side}-${level.price}`} style={{ "--book-fill": `${Math.min(100, level.amount / max * 100)}%` } as CSSProperties}>{side === "bid" ? <><span className="book-amount">{formatAmount(level.amount)}</span><span className="book-price">{formatPrice(level.price)}</span></> : <><span className="book-price">{formatPrice(level.price)}</span><span className="book-amount">{formatAmount(level.amount)}</span></>}</div>;
  return <div className="book">{asks.length || bids.length ? <><div className="book-ratio"><span>买盘</span><div className="book-ratio-track"><i style={{ width: `${100 * bids.reduce((sum, level) => sum + level.amount, 0) / Math.max(1, [...bids, ...asks].reduce((sum, level) => sum + level.amount, 0))}%` }} /></div><span>卖盘</span></div><div className="book-columns"><div className="book-side"><div className="book-side-head"><span>数量 {symbol}</span><span>买价 {quote}</span></div>{bids.map((level) => row(level, "bid"))}</div><div className="book-side"><div className="book-side-head"><span>卖价 {quote}</span><span>数量 {symbol}</span></div>{asks.map((level) => row(level, "ask"))}</div></div><div className="book-spread">价差 {asks.length && bids.length ? marketNumber(asks[0]!.price - bids[0]!.price, 8) : "—"} {quote}</div></> : <div className="market-empty">暂无盘口数据</div>}</div>;
}

function FullOrderBook({ source, symbol, quote, onBack }: { source: TradeSource; symbol: string; quote: string; onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<DepthSnapshot | null>(null);
  const [step, setStep] = useState(source === 'hyperliquid' ? 0 : 0.01);
  const [status, setStatus] = useState("正在同步订单簿…");
  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1000;
    let fetching = false;
    let latest: DepthSnapshot | null = null;
    let flush: ReturnType<typeof setTimeout> | null = null;
    const publish = (next: DepthSnapshot) => {
      if (!Number.isSafeInteger(next.sequence) || !Array.isArray(next.depth?.asks) || !Array.isArray(next.depth?.bids)) return;
      if (latest && next.sequence < latest.sequence) return;
      latest = next;
      setStatus("");
      if (!flush) flush = setTimeout(() => { flush = null; if (!stopped) setSnapshot(latest); }, 150);
    };
    const refresh = async () => {
      if (stopped || document.hidden || fetching) return;
      fetching = true;
      try { publish(await loadFullDepth(source)); }
      catch { if (!latest) setStatus("订单簿正在同步，请稍后重试"); }
      finally { fetching = false; }
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openFullDepthStream(source);
      socket = current;
      current.onopen = () => { retryMs = 1000; };
      current.onmessage = ({ data }) => {
        let frame: (DepthSnapshot & { type: string }) | (DepthDelta & { type: string });
        try { frame = JSON.parse(String(data)); } catch { return; }
        if (frame.type === "depth-snapshot" && "depth" in frame) publish(frame);
        else if (frame.type === "depth-delta" && "asks" in frame && latest) {
          const next = applyDepthDelta(latest, frame);
          if (next) publish(next);
          else if (frame.sequence > latest.sequence) void refresh();
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        if (!stopped && !document.hidden) {
          reconnect = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      };
    };
    const onVisibility = () => {
      if (document.hidden) { socket?.close(); socket = null; if (reconnect) clearTimeout(reconnect); reconnect = null; }
      else { connect(); void refresh(); }
    };
    connect();
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (reconnect) clearTimeout(reconnect);
      if (flush) clearTimeout(flush);
      socket?.close();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [source]);
  const depth = snapshot ? aggregateDepth(snapshot.depth, step) : undefined;
  const steps = source === 'hyperliquid' ? [{ value: 0, label: '原始' }, { value: 1, label: '1' }, { value: 10, label: '10' }, { value: 100, label: '100' }] : [{ value: 0, label: '原始' }, { value: 0.001, label: '0.001' }, { value: 0.01, label: '0.01' }, { value: 0.1, label: '0.1' }];
  const venue = source === 'hyperliquid' ? 'Hyperliquid' : source === 'lighter' ? 'Lighter' : 'SafeTrade';
  return <section className="trade-page full-book-page">
    <div className="full-book-header"><button type="button" aria-label="返回 Market" onClick={onBack}><Icon name="back" size={22} /></button><div><h1>完整盘口</h1><small>{venue} · {symbol}/{quote}</small></div></div>
    <div className="full-book-steps" aria-label="价格合并档位"><span>价格档位</span>{steps.map((option) => <button type="button" key={option.label} className={step === option.value ? "active" : ""} onClick={() => setStep(option.value)}>{option.label}</button>)}</div>
    {source === 'hyperliquid' && <p className="full-book-status">上游最多提供每侧 20 档</p>}
    {status && <p className="full-book-status" role="status">{status}</p>}
    <OrderBook depth={depth} symbol={symbol} quote={quote} priceDecimals={step === 0 ? undefined : step === 0.001 ? 3 : step === 0.01 ? 2 : step === 0.1 ? 1 : 0} />
  </section>;
}

function TradeHistoryPage({ source, symbol, quote, onBack }: { source: TradeSource; symbol: string; quote: string; onBack: () => void }) {
  const [sort, setSort] = useState<"time" | "amount_desc" | "amount_asc">("time");
  const [period, setPeriod] = useState('24h');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [side, setSide] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(() => ({ from: String(Math.floor(Date.now() / 1000) - 86400) }));
  const [refreshKey, setRefreshKey] = useState(0);
  const [rows, setRows] = useState<MarketData['trades']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [recordingSince, setRecordingSince] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const queryGeneration = useRef(0);
  useEffect(() => {
    const generation = ++queryGeneration.current;
    let cancelled = false;
    setLoading(true); setMoreLoading(false); setError(''); setRows([]); setNextCursor(null);
    loadTradeHistory(source, { ...filters, sort }).then((page) => {
      if (cancelled || generation !== queryGeneration.current) return;
      setRows(page.trades); setNextCursor(page.nextCursor); setRecordingSince(page.recordingSince);
    }).catch((failure) => { if (!cancelled && generation === queryGeneration.current) setError(failure instanceof Error ? failure.message : '成交记录暂不可用'); })
      .finally(() => { if (!cancelled && generation === queryGeneration.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [source, filters, sort, refreshKey]);
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    const now = Math.floor(Date.now() / 1000);
    const next: Record<string, string> = {};
    if (period === 'custom') {
      if (fromInput) next.from = String(Math.floor(new Date(fromInput).getTime() / 1000));
      if (toInput) next.to = String(Math.floor(new Date(toInput).getTime() / 1000));
    } else next.from = String(now - (period === '1h' ? 3600 : period === '7d' ? 604800 : 86400));
    if (side) next.side = side;
    if (minPrice) next.minPrice = minPrice;
    if (maxPrice) next.maxPrice = maxPrice;
    if (minAmount) next.minAmount = minAmount;
    if ((next.from && !Number.isFinite(Number(next.from))) || (next.to && !Number.isFinite(Number(next.to))) || (next.from && next.to && Number(next.from) > Number(next.to)) || (minPrice && maxPrice && Number(minPrice) > Number(maxPrice))) {
      setError('请检查时间或价格范围'); return;
    }
    setFilters(next);
  };
  const reset = () => {
    setPeriod('24h'); setFromInput(''); setToInput(''); setSide(''); setMinPrice(''); setMaxPrice(''); setMinAmount('');
    setSort('time');
    setFilters({ from: String(Math.floor(Date.now() / 1000) - 86400) });
  };
  const loadMore = async () => {
    if (!nextCursor || loading || moreLoading) return;
    const generation = queryGeneration.current;
    setMoreLoading(true); setError('');
    try {
      const page: TradeHistoryResult = await loadTradeHistory(source, { ...filters, sort, cursor: nextCursor });
      if (generation !== queryGeneration.current) return;
      setRows((previous) => { const ids = new Set(previous.map((row) => row.id)); return [...previous, ...page.trades.filter((row) => !ids.has(row.id))]; });
      setNextCursor(page.nextCursor);
    } catch (failure) { if (generation === queryGeneration.current) setError(failure instanceof Error ? failure.message : '加载失败'); }
    finally { if (generation === queryGeneration.current) setMoreLoading(false); }
  };
  const venue = source === 'hyperliquid' ? 'Hyperliquid' : source === 'lighter' ? 'Lighter' : source === 'aster' ? 'Aster' : 'SafeTrade';
  return <section className="trade-page full-book-page trade-history-page">
    <div className="full-book-header"><button type="button" aria-label="返回 Market" onClick={onBack}><Icon name="back" size={22} /></button><div><h1>成交记录</h1><small>{venue} · {symbol}/{quote}</small></div></div>
    <form className="trade-history-filters" onSubmit={applyFilters}>
      <div className="trade-filter-row"><label>时间<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="1h">近 1 小时</option><option value="24h">近 24 小时</option><option value="7d">近 7 天</option><option value="custom">自定义</option></select></label><label>方向<select value={side} onChange={(event) => setSide(event.target.value)}><option value="">全部</option><option value="buy">买入</option><option value="sell">卖出</option></select></label></div>
      {period === 'custom' && <div className="trade-filter-row"><label>开始<input type="datetime-local" value={fromInput} onChange={(event) => setFromInput(event.target.value)} /></label><label>结束<input type="datetime-local" value={toInput} onChange={(event) => setToInput(event.target.value)} /></label></div>}
      <div className="trade-filter-row trade-filter-prices"><label>最低价<input type="number" min="0" step="any" inputMode="decimal" placeholder={quote} value={minPrice} onChange={(event) => setMinPrice(event.target.value)} /></label><label>最高价<input type="number" min="0" step="any" inputMode="decimal" placeholder={quote} value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} /></label><label>最小数量<input type="number" min="0" step="any" inputMode="decimal" placeholder={symbol} value={minAmount} onChange={(event) => setMinAmount(event.target.value)} /></label></div>
      <div className="trade-filter-actions"><button type="button" className="trade-sort-button" onClick={() => setSort((current) => current === 'time' ? 'amount_desc' : current === 'amount_desc' ? 'amount_asc' : 'time')} aria-label={sort === 'time' ? '按数量从大到小排序' : sort === 'amount_desc' ? '按数量从小到大排序' : '恢复按时间排序'}>{sort === 'time' ? '数量排序' : sort === 'amount_desc' ? '数量 ↓' : '数量 ↑'}</button><button type="button" onClick={reset}>重置</button><button type="submit">筛选</button><button type="button" onClick={() => setRefreshKey((key) => key + 1)}>刷新</button></div>
    </form>
    <div className="trade-history-meta">{recordingSince ? `服务器记录始于 ${new Date(recordingSince * 1000).toLocaleString('zh-CN')}` : '服务器正在积累逐笔成交记录'} · 色条长度按成交量平方根缩放{source === 'hyperliquid' && symbol === 'BTC' ? ' · BTC 示例仅保留最近 24 小时、最多 10 万笔' : ''}</div>
    {error && <p className="full-book-status" role="alert">{error}</p>}
    {loading ? <p className="full-book-status">正在查询成交记录…</p> : <><RecentTrades trades={rows} symbol={symbol} quote={quote} showDate />{nextCursor && <button type="button" className="trade-more-button" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? '加载中…' : '加载更多'}</button>}</>}
  </section>;
}

function RecentTrades({ trades, symbol = "PRL", quote = "USDT", showDate = false }: { trades: MarketData["trades"] | undefined; symbol?: string; quote?: string; showDate?: boolean }) {
  const maxAmount = (trades ?? []).reduce((max, trade) => Math.max(max, trade.amount), 0);
  return <div className="recent-trades">
    <div className="book-labels"><span>时间{showDate ? ' / 方向' : ''}</span><span>价格 ({quote})</span><span>数量 ({symbol})</span></div>
    {trades?.length ? trades.map((trade) => <div className="trade-row" key={trade.id}>
      <span>{showDate ? new Date(trade.time * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : new Date(trade.time * 1000).toLocaleTimeString("zh-CN", { hour12: false })}{showDate ? ` ${trade.side === 'buy' ? '买' : '卖'}` : ''}</span>
      <span className={trade.side === 'buy' ? 'positive' : 'negative'}>{marketNumber(trade.price, 8)}</span>
      <span className="trade-amount">{alignedTradeAmount(trade.amount)}</span>
      <i className={`trade-volume-bar ${trade.side === 'buy' ? 'buy' : 'sell'}`} style={{ width: `${maxAmount ? Math.max(2, 100 * Math.sqrt(trade.amount / maxAmount)) : 0}%` }} aria-hidden="true" />
    </div>) : <div className="market-empty">暂无成交记录</div>}
  </div>;
}

export default function App() {
  const [profileStore, setProfileStore] = useState<ProfileStore>(loadProfiles);
  const activeProfile = profileStore.profiles.find((profile) => profile.id === profileStore.activeId) ?? null;
  const blob: EncryptedWallet | null = activeProfile?.kind === "wallet" ? activeProfile.blob : null;
  const watchMode = activeProfile?.kind === "watch";
  const [requireUnlock, setRequireUnlock] = useState(() => localStorage.getItem(UNLOCK_KEY) !== "false");
  const [addresses, setAddresses] = useState<string[] | null>(() => {
    const store = loadProfiles();
    const active = store.profiles.find((profile) => profile.id === store.activeId);
    if (active?.kind === "watch") return [active.address];
    return localStorage.getItem(UNLOCK_KEY) === "false" && active?.kind === "wallet" && active.addresses.length ? active.addresses : null;
  });
  const [tab, setTab] = useState<Tab>("wallet");
  const [marketSource, setMarketSource] = useState<MarketSource>(() => { const source = localStorage.getItem("pearl-market-source-v1"); return source === "wprl" || source === "hyperliquid" || source === "lighter" || source === "aster" ? source : "safetrade"; });
  const [walletPage, setWalletPage] = useState<WalletPage>("home");
  const [snapshotCache, setSnapshotCache] = useState<SnapshotCache>(loadSnapshotCache);
  const [pendingOutgoing, setPendingOutgoing] = useState(loadPendingOutgoing);
  const [freshSnapshotKey, setFreshSnapshotKey] = useState<string | null>(null);
  const snapshotKey = activeProfile && addresses ? `${activeProfile.id}:${addresses.join("|")}` : null;
  const cached = activeProfile && addresses ? snapshotCache[activeProfile.id] : null;
  const snapshot = cached && cached.pool === addresses?.join("|") ? cached.data : null;
  const localPending = activeProfile && addresses ? pendingOutgoing.filter((item) => item.profileId === activeProfile.id && item.pool === addresses.join("|")) : [];
  const projected = snapshot ? projectWalletSnapshot(snapshot, localPending) : null;
  const snapshotFresh = !!snapshotKey && freshSnapshotKey === snapshotKey;
  const [snapshotError, setSnapshotError] = useState("");
  const [walletRefreshing, setWalletRefreshing] = useState(false);
  const [publicMarket, setPublicMarket] = useState(loadPublicMarketCache);
  const publicMarketRef = useRef(publicMarket);
  publicMarketRef.current = publicMarket;
  const [wprlMarket, setWprlMarket] = useState(loadWprlMarketCache);
  const [wprlError, setWprlError] = useState("");
  const [wprlRefreshing, setWprlRefreshing] = useState(false);
  const wprlOverviewRequest = useRef<Promise<void> | null>(null);
  const wprlCandleRequests = useRef(new Map<Interval, Promise<void>>());
  const wprlSocket = useRef<WebSocket | null>(null);
  const [hyperliquidMarket, setHyperliquidMarket] = useState(loadHyperliquidMarketCache);
  const [hyperliquidError, setHyperliquidError] = useState("");
  const [hyperliquidRefreshing, setHyperliquidRefreshing] = useState(false);
  const [hyperliquidTradeSample, setHyperliquidTradeSample] = useState(0);
  const hyperliquidOverviewRequest = useRef<Promise<void> | null>(null);
  const hyperliquidCandleRequests = useRef(new Map<Interval, Promise<void>>());
  const hyperliquidSocket = useRef<WebSocket | null>(null);
  const [lighterMarket, setLighterMarket] = useState(loadLighterMarketCache);
  const [lighterError, setLighterError] = useState("");
  const [lighterRefreshing, setLighterRefreshing] = useState(false);
  const [lighterTradeSample, setLighterTradeSample] = useState(0);
  const lighterOverviewRequest = useRef<Promise<void> | null>(null);
  const lighterCandleRequests = useRef(new Map<Interval, Promise<void>>());
  const lighterSocket = useRef<WebSocket | null>(null);
  const [asterMarket, setAsterMarket] = useState(loadAsterMarketCache);
  const [asterError, setAsterError] = useState("");
  const [asterRefreshing, setAsterRefreshing] = useState(false);
  const asterOverviewRequest = useRef<Promise<void> | null>(null);
  const asterCandleRequests = useRef(new Map<Interval, Promise<void>>());
  const asterSocket = useRef<WebSocket | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [candleError, setCandleError] = useState("");
  const [marketRefreshing, setMarketRefreshing] = useState(false);
  const [account, setAccount] = useState<AccountData | null>(null);
  const [accountError, setAccountError] = useState("");
  const [connectionToken, setConnectionToken] = useState(savedConnectionToken);
  const [safeKey, setSafeKey] = useState("");
  const [safeSecret, setSafeSecret] = useState("");
  const [connectingSafeTrade, setConnectingSafeTrade] = useState(false);
  const [interval, setIntervalValue] = useState<Interval>("1m");
  const [lighterChartClock, setLighterChartClock] = useState(() => Date.now());
  const activeInterval = useRef(interval);
  activeInterval.current = interval;
  const overviewRequest = useRef<Promise<void> | null>(null);
  const candleRequests = useRef(new Map<Interval, Promise<void>>());
  const marketStreamActive = useRef(false);
  const marketSocket = useRef<WebSocket | null>(null);
  const accountStreamActive = useRef(false);
  const lastOverviewReconcile = useRef(0);
  const lastCandleReconcile = useRef(0);
  const currentSeries = publicMarket.series[interval];
  const overview = publicMarket.overview;
  const exchangeError = candleError || overviewError;
  const exchange: MarketData | null = overview || currentSeries ? {
    pair: "PRL/USDT", price: overview?.price ?? currentSeries?.candles.at(-1)?.close ?? null,
    stats24h: overview?.stats24h ?? null, candles: currentSeries?.candles ?? [],
    depth: overview?.depth ?? { asks: [], bids: [] }, trades: overview?.trades ?? [],
    marketError: overview?.marketError ?? null, updatedAt: Math.max(overview?.updatedAt ?? 0, currentSeries?.updatedAt ?? 0),
  } : null;
  const wprlSeries = wprlMarket.series[interval];
  const wprlOverview = wprlMarket.overview;
  const wprlExchange: MarketData | null = wprlOverview || wprlSeries ? {
    pair: "WPRL/USDT", price: wprlOverview?.price ?? wprlSeries?.candles.at(-1)?.close ?? null,
    stats24h: wprlOverview?.stats24h ?? null, candles: wprlSeries?.candles ?? [],
    depth: { asks: [], bids: [] }, trades: wprlOverview?.trades ?? [],
    marketError: wprlOverview?.marketError ?? null, updatedAt: Math.max(wprlOverview?.updatedAt ?? 0, wprlSeries?.updatedAt ?? 0),
  } : null;
  const hyperliquidSeries = hyperliquidMarket.series[interval];
  const hyperliquidOverview = hyperliquidMarket.overview;
  const hyperliquidExchange: MarketData | null = hyperliquidOverview || hyperliquidSeries ? {
    pair: hyperliquidOverview?.pair ?? "BTC/USDC", price: hyperliquidOverview?.price ?? hyperliquidSeries?.candles.at(-1)?.close ?? null,
    stats24h: hyperliquidOverview?.stats24h ?? null, candles: hyperliquidSeries?.candles ?? [],
    depth: hyperliquidOverview?.depth ?? { asks: [], bids: [] }, trades: hyperliquidOverview?.trades ?? [],
    marketError: hyperliquidOverview?.marketError ?? null, updatedAt: Math.max(hyperliquidOverview?.updatedAt ?? 0, hyperliquidSeries?.updatedAt ?? 0),
  } : null;
  const lighterSeries = lighterMarket.series[interval];
  const lighterOverview = lighterMarket.overview;
  const lighterExchange: MarketData | null = lighterOverview || lighterSeries ? {
    pair: lighterOverview?.pair ?? "PRL/USDC", price: lighterOverview?.price ?? lighterSeries?.candles.at(-1)?.close ?? null,
    stats24h: lighterOverview?.stats24h ?? null, candles: lighterSeries?.candles ?? [],
    depth: lighterOverview?.depth ?? { asks: [], bids: [] }, trades: lighterOverview?.trades ?? [],
    marketError: lighterOverview?.marketError ?? null, updatedAt: Math.max(lighterOverview?.updatedAt ?? 0, lighterSeries?.updatedAt ?? 0),
  } : null;
  const asterSeries = asterMarket.series[interval];
  const asterOverview = asterMarket.overview;
  const asterExchange: MarketData | null = asterOverview || asterSeries ? {
    pair: "PEARL/USDT", price: asterOverview?.price ?? asterSeries?.candles.at(-1)?.close ?? null,
    stats24h: asterOverview?.stats24h ?? null, candles: asterSeries?.candles ?? [],
    depth: asterOverview?.depth ?? { asks: [], bids: [] }, trades: asterOverview?.trades ?? [],
    marketError: asterOverview?.marketError ?? null, updatedAt: Math.max(asterOverview?.updatedAt ?? 0, asterSeries?.updatedAt ?? 0),
  } : null;
  const isWprl = marketSource === "wprl";
  const isHyperliquid = marketSource === "hyperliquid";
  const isLighter = marketSource === "lighter";
  const isAster = marketSource === "aster";
  const activeSeries = isAster ? asterSeries : isLighter ? lighterSeries : isHyperliquid ? hyperliquidSeries : isWprl ? wprlSeries : currentSeries;
  const activeExchange = isAster ? asterExchange : isLighter ? lighterExchange : isHyperliquid ? hyperliquidExchange : isWprl ? wprlExchange : exchange;
  const activeCandles = isLighter && lighterOverview && Date.now() - lighterOverview.updatedAt < 90_000
    ? displayLighterCandles(activeSeries?.candles ?? [], interval, lighterChartClock)
    : activeSeries?.candles ?? [];
  const activeMarketError = isAster ? asterError : isLighter ? lighterError : isHyperliquid ? hyperliquidError : isWprl ? wprlError : exchangeError;
  const hyperliquidCoin = hyperliquidOverview?.contract?.coin ?? "BTC";
  const activeSymbol = isAster ? "PEARL" : isLighter ? "PRL" : isHyperliquid ? hyperliquidCoin : isWprl ? "WPRL" : "PRL";
  const activeQuote = isLighter ? "USDC" : isHyperliquid ? hyperliquidOverview?.contract?.quote ?? "USDC" : "USDT";
  const isPerp = isHyperliquid || isLighter || isAster;
  const perpOverview = isAster ? asterOverview : isLighter ? lighterOverview : hyperliquidOverview;
  const perpTradeSample = isAster ? 0 : isLighter ? lighterTradeSample : hyperliquidTradeSample;
  const perpRecordingSince = isAster ? asterSeries?.recordingSince : isLighter ? lighterSeries?.recordingSince : hyperliquidSeries?.recordingSince;
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceCategory, setSourceCategory] = useState<"all" | "spot" | "perp" | "chain">("all");
  const [marketDetails, setMarketDetails] = useState<"depth" | "trades">("depth");
  const [fullBookOpen, setFullBookOpen] = useState(false);
  const [tradeHistoryOpen, setTradeHistoryOpen] = useState(false);
  const fullBookScroll = useRef<number | null>(null);
  const openFullBook = () => { fullBookScroll.current = window.scrollY; setFullBookOpen(true); };
  const openTradeHistory = () => { fullBookScroll.current = window.scrollY; setTradeHistoryOpen(true); };
  const closeMarketDetail = () => { setFullBookOpen(false); setTradeHistoryOpen(false); };
  useLayoutEffect(() => {
    if (tab === "market" && (fullBookOpen || tradeHistoryOpen)) window.scrollTo(0, 0);
    else if (tab === "market" && fullBookScroll.current !== null) {
      const previous = fullBookScroll.current;
      fullBookScroll.current = null;
      requestAnimationFrame(() => window.scrollTo(0, previous));
    }
  }, [tab, fullBookOpen, tradeHistoryOpen]);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [setupMode, setSetupMode] = useState<"create" | "restore" | "watch">("create");
  const [addingProfile, setAddingProfile] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [renamingProfile, setRenamingProfile] = useState(false);
  const [confirmRemoveWatch, setConfirmRemoveWatch] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [walletName, setWalletName] = useState("");
  const [watchInput, setWatchInput] = useState("");
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [inputMnemonic, setInputMnemonic] = useState("");
  const [backupMnemonic, setBackupMnemonic] = useState("");
  const [backupCheck, setBackupCheck] = useState("");
  const [receiveQr, setReceiveQr] = useState("");
  const [sendAddress, setSendAddress] = useState("");
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  const [addressBookPurpose, setAddressBookPurpose] = useState<"send" | "manage">("send");
  const [expandedAddressWallets, setExpandedAddressWallets] = useState<Set<string>>(() => new Set());
  const [savedAddresses, setSavedAddresses] = useState(loadSavedAddresses);
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const [entryAddress, setEntryAddress] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [addressBookError, setAddressBookError] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendFeeTier, setSendFeeTier] = useState<SendFeeTier>("standard");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewScanSequence, setPreviewScanSequence] = useState<number | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [biometricStatus, setBiometricStatus] = useState<{ address: string | null; available: boolean; enabled: boolean }>({ address: null, available: false, enabled: false });
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [fingerPassword, setFingerPassword] = useState("");
  const [backupPassword, setBackupPassword] = useState("");
  const [showMnemonic, setShowMnemonic] = useState("");
  const [autoFingerAttempted, setAutoFingerAttempted] = useState(false);
  const [biometricAddress, setBiometricAddress] = useState(() => localStorage.getItem(BIOMETRIC_ADDRESS_KEY));
  const [updateStatus, setUpdateStatus] = useState("");
  const walletScanSequence = useRef(0);
  const walletCheckSequence = useRef(0);
  const walletCheckBusy = useRef(new Set<string>());
  const walletSynchronizer = useRef(new WalletSynchronizer());
  const snapshotCacheRef = useRef(snapshotCache);
  snapshotCacheRef.current = snapshotCache;
  const pendingOutgoingRef = useRef(pendingOutgoing);
  pendingOutgoingRef.current = pendingOutgoing;
  const backupRevealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secretRevealSequence = useRef(0);
  const walletAccessGeneration = useRef(0);
  const activeTab = useRef(tab);
  const [pullDistance, setPullDistance] = useState(0);
  const pullStart = useRef<number | null>(null);
  const pullDistanceRef = useRef(0);
  activeTab.current = tab;
  const fingerprintEnabled = !!blob && biometricStatus.address === blob.address && biometricStatus.enabled;

  function persistProfiles(next: ProfileStore) {
    saveProfiles(next);
    setProfileStore(next);
  }

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败"); }
    finally { setBusy(false); }
  }, []);

  const refreshWallet = useCallback(async (profileId: string, pool: string[], forceFull = true, urgent = false) => {
    const poolKey = pool.join("|");
    const key = `${profileId}:${poolKey}`;
    if (walletCheckBusy.current.has(key)) return;
    walletCheckBusy.current.add(key);
    const sequence = ++walletCheckSequence.current;
    if (forceFull) { setSnapshotError(""); setWalletRefreshing(true); }
    try {
      const current = snapshotCacheRef.current[profileId];
      const result = await walletSynchronizer.current.check(pool, current?.pool === poolKey ? current.data : null, forceFull, () => {
        if (sequence !== walletCheckSequence.current) return;
        walletScanSequence.current++;
        setFreshSnapshotKey(null);
        setWalletRefreshing(true);
      }, urgent);
      if (sequence === walletCheckSequence.current && result.kind === "updated" && result.snapshot) {
        const data = result.snapshot;
        const remaining = reconcilePendingOutgoing(pendingOutgoingRef.current, profileId, poolKey, data);
        if (remaining.length !== pendingOutgoingRef.current.length) {
          pendingOutgoingRef.current = remaining;
          setPendingOutgoing(remaining);
          try { savePendingOutgoing(remaining); } catch (failure) { console.warn("Pending transaction save failed", failure); }
        }
        setSnapshotCache((previous) => {
          const next = { ...previous, [profileId]: { pool: poolKey, data } };
          snapshotCacheRef.current = next;
          try { saveSnapshotCache(next); } catch (failure) { console.warn("Wallet cache save failed", failure); }
          return next;
        });
        setFreshSnapshotKey(key);
        setSnapshotError("");
      }
      if (sequence === walletCheckSequence.current && result.kind === "unchanged") {
        setFreshSnapshotKey(key);
        setSnapshotError("");
      }
    }
    catch (failure) {
      if (sequence !== walletCheckSequence.current) return;
      console.error("Pearl explorer scan failed", failure instanceof Error ? failure.message : String(failure));
      setFreshSnapshotKey(null);
      setSnapshotError("链上数据暂不可用");
    }
    finally {
      walletCheckBusy.current.delete(key);
      if (sequence === walletCheckSequence.current) setWalletRefreshing(false);
    }
  }, []);

  useEffect(() => { savePublicMarketCache(publicMarket); }, [publicMarket]);
  useEffect(() => { saveWprlMarketCache(wprlMarket); }, [wprlMarket]);
  useEffect(() => { saveHyperliquidMarketCache(hyperliquidMarket); }, [hyperliquidMarket]);
  useEffect(() => { saveLighterMarketCache(lighterMarket); }, [lighterMarket]);
  useEffect(() => { saveAsterMarketCache(asterMarket); }, [asterMarket]);
  useEffect(() => {
    if (tab !== "market" || marketSource !== "lighter") return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setLighterChartClock(Date.now());
      timer = setTimeout(tick, 60_000 - Date.now() % 60_000 + 100);
    };
    tick();
    return () => clearTimeout(timer);
  }, [tab, marketSource]);
  useEffect(() => { localStorage.setItem("pearl-market-source-v1", marketSource); }, [marketSource]);

  const refreshWprlOverview = useCallback(() => {
    if (wprlOverviewRequest.current) return wprlOverviewRequest.current;
    const pending = loadWprlOverview().then((data) => {
      setWprlMarket((previous) => !previous.overview || data.updatedAt > previous.overview.updatedAt
        ? { ...previous, overview: data } : previous);
      setWprlError("");
    }).catch(() => setWprlError("WPRL 行情暂不可用"))
      .finally(() => { wprlOverviewRequest.current = null; });
    wprlOverviewRequest.current = pending;
    return pending;
  }, []);

  const refreshWprlCandles = useCallback((target: Interval, visible = true) => {
    const existing = wprlCandleRequests.current.get(target);
    if (existing) return existing;
    if (visible && target === activeInterval.current) setWprlRefreshing(true);
    const pending = loadWprlCandles(target).then((series) => {
      if (series.interval !== target) throw new Error("K 线周期不匹配");
      setWprlMarket((previous) => {
        const current = previous.series[target];
        return !current || series.source !== current.source || series.updatedAt > current.updatedAt || (series.candles.at(-1)?.time ?? 0) > (current.candles.at(-1)?.time ?? 0)
          ? { ...previous, series: { ...previous.series, [target]: series } } : previous;
      });
      setWprlError("");
    }).catch(() => setWprlError("WPRL K 线暂不可用"))
      .finally(() => {
        wprlCandleRequests.current.delete(target);
        if (target === activeInterval.current) setWprlRefreshing(false);
      });
    wprlCandleRequests.current.set(target, pending);
    return pending;
  }, []);

  const refreshHyperliquidOverview = useCallback(() => {
    if (hyperliquidOverviewRequest.current) return hyperliquidOverviewRequest.current;
    const pending = loadHyperliquidOverview().then((data) => {
      setHyperliquidMarket((previous) => !previous.overview || data.updatedAt > previous.overview.updatedAt
        ? { ...previous, overview: data, series: previous.overview?.pair && previous.overview.pair !== data.pair ? {} : previous.series } : previous);
      setHyperliquidError("");
    }).catch(() => setHyperliquidError("Hyperliquid 行情暂不可用"))
      .finally(() => { hyperliquidOverviewRequest.current = null; });
    hyperliquidOverviewRequest.current = pending;
    return pending;
  }, []);

  const refreshHyperliquidCandles = useCallback((target: Interval, visible = true) => {
    const existing = hyperliquidCandleRequests.current.get(target);
    if (existing) return existing;
    if (visible && target === activeInterval.current) setHyperliquidRefreshing(true);
    const pending = loadHyperliquidCandles(target).then((series) => {
      if (series.interval !== target) throw new Error("K 线周期不匹配");
      setHyperliquidMarket((previous) => {
        if (series.pair && previous.overview && series.pair !== previous.overview.pair) return previous;
        const current = previous.series[target];
        return !current || series.updatedAt > current.updatedAt || (series.candles.at(-1)?.time ?? 0) > (current.candles.at(-1)?.time ?? 0)
          ? { ...previous, series: { ...previous.series, [target]: series } } : previous;
      });
      setHyperliquidError("");
    }).catch(() => setHyperliquidError("Hyperliquid K 线暂不可用"))
      .finally(() => {
        hyperliquidCandleRequests.current.delete(target);
        if (target === activeInterval.current) setHyperliquidRefreshing(false);
      });
    hyperliquidCandleRequests.current.set(target, pending);
    return pending;
  }, []);

  const refreshLighterOverview = useCallback(() => {
    if (lighterOverviewRequest.current) return lighterOverviewRequest.current;
    const pending = loadLighterOverview().then((data) => {
      setLighterMarket((previous) => !previous.overview || data.updatedAt > previous.overview.updatedAt
        ? { ...previous, overview: data, series: previous.overview?.pair && previous.overview.pair !== data.pair ? {} : previous.series } : previous);
      setLighterError("");
    }).catch(() => setLighterError("Lighter 行情暂不可用"))
      .finally(() => { lighterOverviewRequest.current = null; });
    lighterOverviewRequest.current = pending;
    return pending;
  }, []);

  const refreshLighterCandles = useCallback((target: Interval, visible = true) => {
    const existing = lighterCandleRequests.current.get(target);
    if (existing) return existing;
    if (visible && target === activeInterval.current) setLighterRefreshing(true);
    const pending = loadLighterCandles(target).then((series) => {
      if (series.interval !== target) throw new Error("K 线周期不匹配");
      setLighterMarket((previous) => {
        if (series.pair && previous.overview && series.pair !== previous.overview.pair) return previous;
        const current = previous.series[target];
        return !current || series.updatedAt > current.updatedAt || (series.candles.at(-1)?.time ?? 0) > (current.candles.at(-1)?.time ?? 0)
          ? { ...previous, series: { ...previous.series, [target]: series } } : previous;
      });
      setLighterError("");
    }).catch(() => setLighterError("Lighter K 线暂不可用"))
      .finally(() => {
        lighterCandleRequests.current.delete(target);
        if (target === activeInterval.current) setLighterRefreshing(false);
      });
    lighterCandleRequests.current.set(target, pending);
    return pending;
  }, []);

  const refreshAsterOverview = useCallback(() => {
    if (asterOverviewRequest.current) return asterOverviewRequest.current;
    const pending = loadAsterOverview().then((data) => {
      setAsterMarket((previous) => !previous.overview || data.updatedAt > previous.overview.updatedAt
        ? { ...previous, overview: data, series: previous.overview?.pair && previous.overview.pair !== data.pair ? {} : previous.series } : previous);
      setAsterError("");
    }).catch(() => setAsterError("Aster 行情暂不可用"))
      .finally(() => { asterOverviewRequest.current = null; });
    asterOverviewRequest.current = pending;
    return pending;
  }, []);

  const refreshAsterCandles = useCallback((target: Interval, visible = true) => {
    const existing = asterCandleRequests.current.get(target);
    if (existing) return existing;
    if (visible && target === activeInterval.current) setAsterRefreshing(true);
    const pending = loadAsterCandles(target).then((series) => {
      if (series.interval !== target) throw new Error("K 线周期不匹配");
      setAsterMarket((previous) => {
        const current = previous.series[target];
        return !current || series.updatedAt > current.updatedAt || (series.candles.at(-1)?.time ?? 0) > (current.candles.at(-1)?.time ?? 0)
          ? { ...previous, series: { ...previous.series, [target]: series } } : previous;
      });
      setAsterError("");
    }).catch(() => setAsterError("Aster K 线暂不可用"))
      .finally(() => {
        asterCandleRequests.current.delete(target);
        if (target === activeInterval.current) setAsterRefreshing(false);
      });
    asterCandleRequests.current.set(target, pending);
    return pending;
  }, []);

  const refreshOverview = useCallback(() => {
    if (overviewRequest.current) return overviewRequest.current;
    const started = performance.now();
    const pending = loadMarketOverview().then((data) => {
      setPublicMarket((previous) => !previous.overview || data.updatedAt > previous.overview.updatedAt
        ? { ...previous, overview: data } : previous);
      setOverviewError("");
      console.debug(`SafeTrade overview ${Math.round(performance.now() - started)}ms`);
    }).catch(() => setOverviewError("行情服务暂不可用")).finally(() => { overviewRequest.current = null; });
    overviewRequest.current = pending;
    return pending;
  }, []);

  const refreshCandles = useCallback((target: Interval, visible = true) => {
    const existing = candleRequests.current.get(target);
    if (existing) {
      if (visible && target === activeInterval.current) setMarketRefreshing(true);
      return existing;
    }
    if (visible && target === activeInterval.current) setMarketRefreshing(true);
    const started = performance.now();
    const pending = loadMarketCandles(target).then((series) => {
      if (series.interval !== target) throw new Error("K 线周期不匹配");
      setPublicMarket((previous) => {
        const current = previous.series[target];
        if (!current || series.updatedAt > current.updatedAt || (series.candles.at(-1)?.time ?? 0) > (current.candles.at(-1)?.time ?? 0)) {
          return { ...previous, series: { ...previous.series, [target]: series } };
        }
        const fetched = series.candles.at(-1);
        const latest = current.candles.at(-1);
        if (!fetched || !latest || fetched.time !== latest.time || fetched.volume <= latest.volume) return previous;
        const candles = current.candles.slice();
        candles[candles.length - 1] = { ...latest, volume: fetched.volume };
        return { ...previous, series: { ...previous.series, [target]: { ...current, candles } } };
      });
      if (target === activeInterval.current) setCandleError("");
      console.debug(`SafeTrade ${target} candles ${Math.round(performance.now() - started)}ms`);
    }).catch(() => { if (target === activeInterval.current) setCandleError("K 线暂不可用"); })
      .finally(() => {
        candleRequests.current.delete(target);
        if (target === activeInterval.current) setMarketRefreshing(false);
      });
    candleRequests.current.set(target, pending);
    return pending;
  }, []);

  const refreshExchange = useCallback(() => {
    void refreshOverview();
    void refreshCandles(activeInterval.current);
  }, [refreshOverview, refreshCandles]);

  const refreshSafeTradeAccount = useCallback(async () => {
    if (!connectionToken) return;
    try {
      const latest = await loadAccount(connectionToken);
      setAccount((previous) => !previous || latest.updatedAt >= previous.updatedAt ? latest : previous);
      setAccountError("");
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "账户余额暂不可用");
    }
  }, [connectionToken]);

  async function connectSafeTrade() {
    if (!safeKey.trim() || !safeSecret.trim() || connectingSafeTrade) return;
    setConnectingSafeTrade(true);
    setAccountError("");
    try {
      const result = await connectAccount(safeKey.trim(), safeSecret.trim());
      saveConnectionToken(result.token);
      setConnectionToken(result.token);
      setSafeKey("");
      setSafeSecret("");
      setAccount(await loadAccount(result.token));
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "连接失败");
    } finally { setConnectingSafeTrade(false); }
  }

  async function removeSafeTradeConnection() {
    if (!connectionToken) return;
    try {
      await disconnectAccount(connectionToken);
      clearConnectionToken();
      setConnectionToken("");
      setAccount(null);
      setAccountError("");
    } catch { setAccountError("断开连接失败，请重试"); }
  }

  useEffect(() => {
    if (!addresses) return;
    setSnapshotError("");
    if (!activeProfile) return;
    const profileId = activeProfile.id;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 30_000;
    let stopped = false;
    const closeStream = () => {
      source?.close(); source = null;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
    };
    const connectStream = () => {
      if (stopped || document.hidden || source) return;
      source = new EventSource("https://pearlchain.live/api/explorer/stream");
      source.onopen = () => { retryDelay = 30_000; };
      source.onmessage = () => { if (!document.hidden) refreshWallet(profileId, addresses, false, true); };
      source.onerror = () => {
        source?.close(); source = null;
        if (stopped || document.hidden) return;
        reconnect = setTimeout(connectStream, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 300_000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) closeStream();
      else { refreshWallet(profileId, addresses); connectStream(); }
    };
    if (!document.hidden) { refreshWallet(profileId, addresses); connectStream(); }
    const timer = setInterval(() => { if (!document.hidden) refreshWallet(profileId, addresses, false); }, 5_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer); closeStream(); document.removeEventListener("visibilitychange", onVisibility);
      walletCheckSequence.current++; walletScanSequence.current++;
    };
  }, [addresses, activeProfile?.id, refreshWallet]);

  useEffect(() => {
    if (activeProfile?.kind !== "wallet" || !addresses?.length || activeProfile.addresses.join("|") === addresses.join("|")) return;
    const next: ProfileStore = {
      ...profileStore,
      profiles: profileStore.profiles.map((profile) => profile.id === activeProfile.id && profile.kind === "wallet" ? { ...profile, addresses } : profile),
    };
    saveProfiles(next);
    setProfileStore(next);
  }, [activeProfile, addresses, profileStore]);

  useEffect(() => {
    if (tab === "setting") return;
    secretRevealSequence.current++;
    setShowMnemonic("");
    setBackupPassword("");
    if (backupRevealTimer.current) clearTimeout(backupRevealTimer.current);
  }, [tab]);

  useLayoutEffect(() => {
    const revealingPhrase = tab === "wallet" && !!addresses && !!backupMnemonic && !addingProfile;
    const importingPhrase = tab === "wallet" && (!activeProfile || addingProfile) && setupMode === "restore";
    void screenPrivacy.setSecure(revealingPhrase || importingPhrase || (tab === "setting" && !!showMnemonic)).catch(() => {});
  }, [tab, addresses, backupMnemonic, addingProfile, activeProfile, setupMode, showMnemonic]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "safetrade") return;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retryMs = 1000;
    const close = () => {
      marketStreamActive.current = false;
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      socket?.close();
      socket = null;
      marketSocket.current = null;
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openMarketStream();
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        marketStreamActive.current = true;
        marketSocket.current = current;
        current.send(JSON.stringify({ type: "subscribe", interval: activeInterval.current }));
        retryMs = 1000;
        void refreshOverview();
        void refreshCandles(activeInterval.current, false);
      };
      current.onmessage = ({ data }) => {
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === "overview" && frame.data?.pair === "PRL/USDT" && Number.isFinite(frame.data.updatedAt)) {
          setPublicMarket((previous) => !previous.overview || frame.data.updatedAt > previous.overview.updatedAt
            ? { ...previous, overview: frame.data } : previous);
          setOverviewError("");
        }
        if (frame.type === "overview-patch" && Number.isFinite(frame.data?.updatedAt)) {
          setPublicMarket((previous) => {
            const overview = previous.overview;
            if (!overview || frame.data.updatedAt <= overview.updatedAt) return previous;
            return { ...previous, overview: { ...overview, ...frame.data } };
          });
          setOverviewError("");
        }
        if (frame.type === "candle" && MARKET_INTERVALS.includes(frame.interval as Interval)
          && Number.isFinite(frame.candle?.time) && Number.isFinite(frame.candle?.close)) {
          const target = frame.interval as Interval;
          setPublicMarket((previous) => {
            const series = previous.series[target];
            if (!series?.candles.length || frame.updatedAt <= series.updatedAt) return previous;
            const candles = series.candles.slice();
            const last = candles.at(-1)!;
            if (frame.candle.time < last.time) return previous;
            const candle = frame.candle.time === last.time
              ? { ...frame.candle, volume: Math.max(last.volume, frame.candle.volume) } : frame.candle;
            if (frame.candle.time === last.time) candles[candles.length - 1] = candle;
            else { candles.push(candle); if (candles.length > 300) candles.shift(); }
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt: frame.updatedAt } } };
          });
          if (target === activeInterval.current) setCandleError("");
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        marketSocket.current = null;
        marketStreamActive.current = false;
        if (stopped || document.hidden) return;
        void refreshOverview();
        void refreshCandles(activeInterval.current, false);
        reconnect = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) close();
      else { void refreshOverview(); void refreshCandles(activeInterval.current, false); connect(); }
    };
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; close(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, marketSource, refreshOverview, refreshCandles]);

  useEffect(() => {
    const socket = marketSocket.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", interval }));
  }, [interval]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "safetrade") return;
    void refreshOverview();
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!marketStreamActive.current || Date.now() - lastOverviewReconcile.current > 60_000) {
        lastOverviewReconcile.current = Date.now();
        void refreshOverview();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [tab, marketSource, refreshOverview]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "safetrade") return;
    setCandleError("");
    void refreshCandles(interval);
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (!marketStreamActive.current || Date.now() - lastCandleReconcile.current > 15_000) {
        lastCandleReconcile.current = Date.now();
        void refreshCandles(interval, false);
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [tab, marketSource, interval, refreshCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "safetrade" || !currentSeries) return;
    let canceled = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const other of MARKET_INTERVALS) {
          if (canceled || document.hidden || other === interval || publicMarketRef.current.series[other]) continue;
          await refreshCandles(other, false);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      })();
    }, 800);
    return () => { canceled = true; clearTimeout(timer); };
  }, [tab, marketSource, interval, !!currentSeries, refreshCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "wprl") return;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retryMs = 1000;
    const close = () => {
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      socket?.close();
      socket = null;
      wprlSocket.current = null;
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openWprlStream();
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        wprlSocket.current = current;
        current.send(JSON.stringify({ type: "subscribe", interval: activeInterval.current }));
        retryMs = 1000;
        void refreshWprlOverview();
        void refreshWprlCandles(activeInterval.current, false);
      };
      current.onmessage = ({ data }) => {
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === "overview" && frame.data?.pair === "WPRL/USDT" && Number.isFinite(frame.data.updatedAt)) {
          setWprlMarket((previous) => !previous.overview || frame.data.updatedAt > previous.overview.updatedAt
            ? { ...previous, overview: frame.data } : previous);
          setWprlError("");
        }
        if (frame.type === "overview-patch" && Number.isFinite(frame.data?.updatedAt)) {
          setWprlMarket((previous) => previous.overview && frame.data.updatedAt > previous.overview.updatedAt
            ? { ...previous, overview: { ...previous.overview, ...frame.data } } : previous);
        }
        if (frame.type === "candle" && MARKET_INTERVALS.includes(frame.interval as Interval)
          && Number.isFinite(frame.candle?.time) && Number.isFinite(frame.candle?.close)) {
          const target = frame.interval as Interval;
          setWprlMarket((previous) => {
            const series = previous.series[target];
            if (!series?.candles.length || frame.updatedAt <= series.updatedAt) return previous;
            const candles = series.candles.slice();
            const last = candles.at(-1)!;
            if (frame.candle.time < last.time) return previous;
            if (frame.candle.time === last.time) candles[candles.length - 1] = frame.candle;
            else { candles.push(frame.candle); if (candles.length > 300) candles.shift(); }
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt: frame.updatedAt } } };
          });
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        wprlSocket.current = null;
        if (stopped || document.hidden) return;
        reconnect = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) close();
      else { void refreshWprlOverview(); void refreshWprlCandles(activeInterval.current, false); connect(); }
    };
    void refreshWprlOverview();
    void refreshWprlCandles(activeInterval.current);
    connect();
    const overviewTimer = setInterval(() => { if (!document.hidden) void refreshWprlOverview(); }, 15_000);
    const candleTimer = setInterval(() => { if (!document.hidden) void refreshWprlCandles(activeInterval.current, false); }, 30_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      close();
      clearInterval(overviewTimer);
      clearInterval(candleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tab, marketSource, refreshWprlOverview, refreshWprlCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "wprl") return;
    const socket = wprlSocket.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", interval }));
    void refreshWprlCandles(interval);
  }, [tab, marketSource, interval, refreshWprlCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "hyperliquid") return;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retryMs = 1000;
    const close = () => {
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      socket?.close(); socket = null; hyperliquidSocket.current = null;
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openHyperliquidStream();
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        hyperliquidSocket.current = current;
        current.send(JSON.stringify({ type: "subscribe", interval: activeInterval.current }));
        retryMs = 1000;
        void refreshHyperliquidOverview();
        void refreshHyperliquidCandles(activeInterval.current, false);
      };
      current.onmessage = ({ data }) => {
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === "overview" && Number.isFinite(frame.data?.updatedAt)) {
          setHyperliquidMarket((previous) => !previous.overview || frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: frame.data, series: previous.overview?.pair && previous.overview.pair !== frame.data.pair ? {} : previous.series } : previous);
          setHyperliquidError("");
        } else if (frame.type === "overview-patch" && Number.isFinite(frame.data?.updatedAt)) {
          setHyperliquidMarket((previous) => previous.overview && frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: { ...previous.overview, ...frame.data } } : previous);
        } else if (frame.type === "trades" && Array.isArray(frame.trades)) {
          setHyperliquidTradeSample(frame.sampled ? frame.skipped ?? 0 : 0);
          setHyperliquidMarket((previous) => {
            if (!previous.overview) return previous;
            const incoming = new Set(frame.trades.map((trade) => trade.id));
            const trades = [...frame.trades, ...previous.overview.trades.filter((trade) => !incoming.has(trade.id))]
              .sort((a, b) => b.time - a.time).slice(0, 20);
            return { ...previous, overview: { ...previous.overview, trades, price: frame.price ?? previous.overview.price, updatedAt: frame.updatedAt } };
          });
        } else if (frame.type === "candle" && MARKET_INTERVALS.includes(frame.interval as Interval)
          && Number.isFinite(frame.candle?.time) && Number.isFinite(frame.candle?.close)) {
          const target = frame.interval as Interval;
          setHyperliquidMarket((previous) => {
            const series = previous.series[target];
            if (!series?.candles.length) return previous;
            const candles = series.candles.slice();
            const last = candles.at(-1)!;
            if (frame.candle.time < last.time) return previous;
            if (frame.candle.time === last.time) candles[candles.length - 1] = frame.candle;
            else { candles.push(frame.candle); if (candles.length > 300) candles.shift(); }
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt: frame.updatedAt } } };
          });
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null; hyperliquidSocket.current = null;
        if (stopped || document.hidden) return;
        reconnect = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) close();
      else { void refreshHyperliquidOverview(); void refreshHyperliquidCandles(activeInterval.current, false); connect(); }
    };
    void refreshHyperliquidOverview();
    void refreshHyperliquidCandles(activeInterval.current);
    connect();
    const overviewTimer = setInterval(() => { if (!document.hidden) void refreshHyperliquidOverview(); }, 30_000);
    const candleTimer = setInterval(() => { if (!document.hidden) void refreshHyperliquidCandles(activeInterval.current, false); }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; close(); clearInterval(overviewTimer); clearInterval(candleTimer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, marketSource, refreshHyperliquidOverview, refreshHyperliquidCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "hyperliquid") return;
    const socket = hyperliquidSocket.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", interval }));
    void refreshHyperliquidCandles(interval);
  }, [tab, marketSource, interval, refreshHyperliquidCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "lighter") return;
    let socket: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retryMs = 1000;
    const close = () => {
      if (reconnect) clearTimeout(reconnect);
      reconnect = null;
      socket?.close(); socket = null; lighterSocket.current = null;
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openLighterStream();
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        lighterSocket.current = current;
        current.send(JSON.stringify({ type: "subscribe", interval: activeInterval.current }));
        retryMs = 1000;
        void refreshLighterOverview();
        void refreshLighterCandles(activeInterval.current, false);
      };
      current.onmessage = ({ data }) => {
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === "overview" && Number.isFinite(frame.data?.updatedAt)) {
          setLighterMarket((previous) => !previous.overview || frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: frame.data, series: previous.overview?.pair && previous.overview.pair !== frame.data.pair ? {} : previous.series } : previous);
          setLighterError("");
        } else if (frame.type === "overview-patch" && Number.isFinite(frame.data?.updatedAt)) {
          setLighterMarket((previous) => previous.overview && frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: { ...previous.overview, ...frame.data } } : previous);
        } else if (frame.type === "trades" && Array.isArray(frame.trades)) {
          setLighterTradeSample(frame.sampled ? frame.skipped ?? 0 : 0);
          setLighterMarket((previous) => {
            if (!previous.overview) return previous;
            const incoming = new Set(frame.trades.map((trade) => trade.id));
            const trades = [...frame.trades, ...previous.overview.trades.filter((trade) => !incoming.has(trade.id))]
              .sort((a, b) => b.time - a.time).slice(0, 20);
            return { ...previous, overview: { ...previous.overview, trades, price: frame.price ?? previous.overview.price, updatedAt: frame.updatedAt } };
          });
        } else if (frame.type === "candle" && MARKET_INTERVALS.includes(frame.interval as Interval)
          && Number.isFinite(frame.candle?.time) && Number.isFinite(frame.candle?.close)) {
          const target = frame.interval as Interval;
          setLighterMarket((previous) => {
            const series = previous.series[target];
            if (!series?.candles.length) return previous;
            const candles = series.candles.slice();
            const last = candles.at(-1)!;
            if (frame.candle.time < last.time) return previous;
            if (frame.candle.time === last.time) candles[candles.length - 1] = frame.candle;
            else { candles.push(frame.candle); if (candles.length > 300) candles.shift(); }
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt: frame.updatedAt } } };
          });
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null; lighterSocket.current = null;
        if (stopped || document.hidden) return;
        reconnect = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      };
    };
    const onVisibility = () => {
      if (document.hidden) close();
      else { void refreshLighterOverview(); void refreshLighterCandles(activeInterval.current, false); connect(); }
    };
    void refreshLighterOverview();
    void refreshLighterCandles(activeInterval.current);
    connect();
    const overviewTimer = setInterval(() => { if (!document.hidden) void refreshLighterOverview(); }, 30_000);
    const candleTimer = setInterval(() => { if (!document.hidden) void refreshLighterCandles(activeInterval.current, false); }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; close(); clearInterval(overviewTimer); clearInterval(candleTimer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, marketSource, refreshLighterOverview, refreshLighterCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "lighter") return;
    const socket = lighterSocket.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", interval }));
    void refreshLighterCandles(interval);
  }, [tab, marketSource, interval, refreshLighterCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "aster") return;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retry = 1000;
    const close = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      socket?.close(); socket = null; asterSocket.current = null;
    };
    const connect = () => {
      if (stopped || document.hidden || socket) return;
      const current = openAsterStream();
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        asterSocket.current = current;
        current.send(JSON.stringify({ type: "subscribe", interval: activeInterval.current }));
        retry = 1000;
        void refreshAsterOverview();
        void refreshAsterCandles(activeInterval.current, false);
      };
      current.onmessage = ({ data }) => {
        let frame: MarketStreamFrame;
        try { frame = JSON.parse(String(data)) as MarketStreamFrame; } catch { return; }
        if (frame.type === "overview" && Number.isFinite(frame.data?.updatedAt)) {
          setAsterMarket((previous) => !previous.overview || frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: frame.data, series: previous.overview?.pair && previous.overview.pair !== frame.data.pair ? {} : previous.series } : previous);
          setAsterError("");
        } else if (frame.type === "overview-patch" && Number.isFinite(frame.data?.updatedAt)) {
          setAsterMarket((previous) => previous.overview && frame.data.updatedAt >= previous.overview.updatedAt
            ? { ...previous, overview: { ...previous.overview, ...frame.data } } : previous);
        } else if (frame.type === "trades" && Array.isArray(frame.trades)) {
          setAsterMarket((previous) => {
            if (!previous.overview) return previous;
            const ids = new Set(frame.trades.map((trade) => trade.id));
            const trades = [...frame.trades, ...previous.overview.trades.filter((trade) => !ids.has(trade.id))].sort((a, b) => b.time - a.time).slice(0, 20);
            return { ...previous, overview: { ...previous.overview, trades, price: frame.price ?? previous.overview.price, updatedAt: frame.updatedAt } };
          });
        } else if (frame.type === "candle" && MARKET_INTERVALS.includes(frame.interval as Interval) && Number.isFinite(frame.candle?.time)) {
          const target = frame.interval as Interval;
          setAsterMarket((previous) => {
            const series = previous.series[target];
            if (!series?.candles.length) return previous;
            const candles = series.candles.slice();
            const last = candles.at(-1)!;
            if (frame.candle.time < last.time) return previous;
            if (frame.candle.time === last.time) candles[candles.length - 1] = frame.candle;
            else { candles.push(frame.candle); if (candles.length > 300) candles.shift(); }
            return { ...previous, series: { ...previous.series, [target]: { ...series, candles, updatedAt: frame.updatedAt } } };
          });
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null; asterSocket.current = null;
        if (stopped || document.hidden) return;
        retryTimer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    const onVisibility = () => { if (document.hidden) close(); else { void refreshAsterOverview(); void refreshAsterCandles(activeInterval.current, false); connect(); } };
    void refreshAsterOverview(); void refreshAsterCandles(activeInterval.current); connect();
    const overviewTimer = setInterval(() => { if (!document.hidden) void refreshAsterOverview(); }, 30_000);
    const candleTimer = setInterval(() => { if (!document.hidden) void refreshAsterCandles(activeInterval.current, false); }, 60_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; close(); clearInterval(overviewTimer); clearInterval(candleTimer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, marketSource, refreshAsterOverview, refreshAsterCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "aster") return;
    const socket = asterSocket.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", interval }));
    void refreshAsterCandles(interval);
  }, [tab, marketSource, interval, refreshAsterCandles]);

  useEffect(() => {
    if (tab !== "market" || marketSource !== "safetrade" || !connectionToken) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let generation = 0;
    let retryMs = 1000;
    let lastRestCheck = 0;
    const close = () => {
      generation++;
      accountStreamActive.current = false;
      if (retry) clearTimeout(retry);
      retry = null;
      socket?.close();
      socket = null;
    };
    const scheduleRetry = () => {
      if (stopped || document.hidden) return;
      retry = setTimeout(() => void connect(), retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    const connect = async () => {
      if (stopped || document.hidden || socket) return;
      const attempt = ++generation;
      let ticket: string;
      try { ({ ticket } = await accountStreamTicket(connectionToken)); }
      catch { scheduleRetry(); return; }
      if (stopped || document.hidden || attempt !== generation) return;
      const current = openAccountStream(ticket);
      socket = current;
      current.onopen = () => {
        if (socket !== current) return;
        accountStreamActive.current = true;
        retryMs = 1000;
      };
      current.onmessage = ({ data }) => {
        let frame: { type: string; data?: AccountData };
        try { frame = JSON.parse(String(data)) as typeof frame; } catch { return; }
        if (frame.type !== "account" || !frame.data?.balances?.PRL || !frame.data.balances.USDT) return;
        setAccount((previous) => !previous || frame.data!.updatedAt >= previous.updatedAt ? frame.data! : previous);
        setAccountError("");
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        if (socket !== current) return;
        socket = null;
        accountStreamActive.current = false;
        void refreshSafeTradeAccount();
        scheduleRetry();
      };
    };
    const onVisibility = () => {
      if (document.hidden) close();
      else { void refreshSafeTradeAccount(); void connect(); }
    };
    void refreshSafeTradeAccount();
    lastRestCheck = Date.now();
    void connect();
    const timer = setInterval(() => {
      if (document.hidden) return;
      const period = accountStreamActive.current ? 60_000 : 30_000;
      if (Date.now() - lastRestCheck >= period) {
        lastRestCheck = Date.now();
        void refreshSafeTradeAccount();
      }
    }, 10_000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; close(); clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [tab, marketSource, connectionToken, refreshSafeTradeAccount]);

  useEffect(() => {
    const address = blob?.address;
    let cancelled = false;
    setBiometricStatus({ address: null, available: false, enabled: false });
    if (address) biometric.status(address, biometricAddress)
      .then((status) => { if (!cancelled) setBiometricStatus({ address, ...status }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [blob?.address, biometricAddress]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removed = false;
    const listener = NativeApp.addListener("backButton", () => {
      if (addressBookOpen) { setAddressBookOpen(false); return; }
      if (sourcePickerOpen) { setSourcePickerOpen(false); return; }
      if (tab === "market" && (fullBookOpen || tradeHistoryOpen)) { closeMarketDetail(); return; }
      if (profileMenuOpen) { setProfileMenuOpen(false); setRenamingProfile(false); setConfirmRemoveWatch(false); return; }
      if (addingProfile) { setAddingProfile(false); setPassword(""); setInputMnemonic(""); return; }
      if (tab === "wallet" && walletPage !== "home") {
        if (preview) { setPreview(null); setAuthPassword(""); }
        else setWalletPage("home");
        return;
      }
      if (tab !== "wallet") { setTab("wallet"); return; }
      NativeApp.minimizeApp();
    });
    if (removed) listener.then((handle) => handle.remove());
    return () => { removed = true; listener.then((handle) => handle.remove()); };
  }, [tab, walletPage, profileMenuOpen, addingProfile, preview, fullBookOpen, tradeHistoryOpen, addressBookOpen, sourcePickerOpen]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!blob || addresses || !fingerprintEnabled || autoFingerAttempted || tab !== "wallet" || addingProfile) return;
    const generation = walletAccessGeneration.current;
    setAutoFingerAttempted(true);
    biometric.authenticate(blob.address, biometricAddress).then(async ({ mnemonic }) => {
      if (generation !== walletAccessGeneration.current) return;
      const { addresses: unlocked } = await wallet.unlockBiometric(blob, mnemonic);
      if (generation === walletAccessGeneration.current) setAddresses(unlocked);
    })
      .catch(() => {});
  }, [blob, addresses, fingerprintEnabled, autoFingerAttempted, tab, addingProfile]);

  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        secretRevealSequence.current++;
        setShowMnemonic(""); setBackupPassword(""); setFingerPassword("");
        setOldPassword(""); setNewPassword(""); setAuthPassword("");
        setPassword(""); setInputMnemonic("");
        if (backupRevealTimer.current) clearTimeout(backupRevealTimer.current);
      }
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) {
        walletAccessGeneration.current++;
        wallet.lock();
        if (localStorage.getItem(UNLOCK_KEY) !== "false" && !watchMode) {
          setAddresses(null); setFreshSnapshotKey(null); setAutoFingerAttempted(false);
        }
        setWalletPage("home"); setPreview(null); setShowMnemonic("");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [watchMode]);

  useEffect(() => {
    if (walletPage !== "receive" || !addresses?.[0]) return;
    QRCode.toDataURL(addresses[0], { width: 280, margin: 1 }).then(setReceiveQr).catch(() => setReceiveQr(""));
  }, [walletPage, addresses]);

  async function createOrRestore(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const name = profileName(walletName, profileStore.profiles);
      let nextProfile: WalletProfile;
      if (setupMode === "watch") {
        const address = watchInput.trim();
        if (!isValidPearlAddress(address)) throw new Error("Pearl 地址无效");
        nextProfile = { id: crypto.randomUUID(), name, kind: "watch", address };
      } else {
        if (password.length < 12) throw new Error("钱包密码至少需要 12 个字符");
        if (password !== passwordAgain) throw new Error("两次输入的密码不一致");
        if (setupMode === "create") {
          const result = await wallet.create(password);
          nextProfile = { id: crypto.randomUUID(), name, kind: "wallet", blob: result.blob, addresses: result.addresses };
          await screenPrivacy.setSecure(true);
          setBackupMnemonic(result.mnemonic);
        } else {
          const result = await wallet.restore(inputMnemonic, password);
          nextProfile = { id: crypto.randomUUID(), name, kind: "wallet", blob: result.blob, addresses: result.addresses };
          setInputMnemonic("");
          setNotice("钱包已导入，正在同步链上余额");
        }
      }
      walletAccessGeneration.current++;
      const next = { ...profileStore, activeId: nextProfile.id, profiles: [...profileStore.profiles, nextProfile] };
      persistProfiles(next);
      setAddresses(nextProfile.kind === "watch" ? [nextProfile.address] : nextProfile.addresses);
      setFreshSnapshotKey(null); setWalletPage("home"); setAddingProfile(false); setProfileMenuOpen(false);
      setWatchInput(""); setWalletName(""); setPassword(""); setPasswordAgain("");
      setAutoFingerAttempted(true);
    });
  }

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!blob) return;
    const generation = walletAccessGeneration.current;
    await run(async () => {
      const result = await wallet.unlock(blob, password);
      if (generation === walletAccessGeneration.current) setAddresses(result.addresses);
      setPassword("");
    });
  }

  async function unlockWithFinger() {
    if (!blob || !fingerprintEnabled) return;
    const generation = walletAccessGeneration.current;
    await run(async () => {
      const result = await biometric.authenticate(blob.address, biometricAddress);
      if (generation !== walletAccessGeneration.current) return;
      const unlocked = await wallet.unlockBiometric(blob, result.mnemonic);
      if (generation === walletAccessGeneration.current) setAddresses(unlocked.addresses);
    });
  }

  async function copy(text: string, message = "地址已复制") {
    try { await navigator.clipboard.writeText(text); setNotice(message); }
    catch { setError("无法复制，请长按地址手动复制"); }
  }

  function makePreview(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (!addresses || !snapshot) throw new Error("链上余额尚未同步");
      if (!snapshotFresh || snapshotError) throw new Error("请先重新同步链上余额");
      if (snapshot.partial) throw new Error("链上交易记录不完整，暂不能安全转账");
      if (!isValidPearlAddress(sendAddress.trim())) throw new Error("Pearl 收款地址无效");
      setPreview(prepareSend(projected?.availableUtxos ?? snapshot.utxos, sendAddress.trim(), parsePrl(sendAmount.trim()), addresses[0]!, SEND_FEE_RATES[sendFeeTier]));
      setPreviewScanSequence(walletScanSequence.current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法创建交易预览"); }
  }

  async function confirmSend(useFinger: boolean) {
    if (!blob || !preview || !addresses) return;
    const generation = walletAccessGeneration.current;
    await run(async () => {
      if (!snapshotFresh || snapshotError || snapshot?.partial || previewScanSequence !== walletScanSequence.current) throw new Error("链上余额已变化，请重新预览转账");
      if (useFinger && !fingerprintEnabled) throw new Error("当前钱包尚未启用指纹");
      const auth = useFinger ? { biometricMnemonic: (await biometric.authenticate(blob.address, biometricAddress)).mnemonic } : { password: authPassword };
      if (generation !== walletAccessGeneration.current) return;
      const signed = await wallet.sign(blob, preview, auth);
      if (generation !== walletAccessGeneration.current) return;
      if (previewScanSequence !== walletScanSequence.current) throw new Error("链上余额已变化，请重新预览转账");
      let txid: string;
      try { txid = await broadcastPearlTx(signed.rawHex); }
      catch (failure) {
        if (!(failure instanceof Error) || !/Pearl 节点 (?:连接失败|HTTP (?:429|5\d\d))/.test(failure.message)) throw failure;
        txid = await broadcastViaExplorer(signed.rawHex);
      }
      if (activeProfile) {
        try {
          const record = pendingFromBroadcast(activeProfile.id, addresses, txid, preview);
          const next = [...pendingOutgoingRef.current.filter((item) => item.txid.toLowerCase() !== txid.toLowerCase()), record];
          pendingOutgoingRef.current = next;
          setPendingOutgoing(next);
          savePendingOutgoing(next);
        } catch (failure) { console.warn("Pending transaction record failed", failure); }
      }
      setPreview(null); setAuthPassword(""); setSendAddress(""); setSendAmount(""); setWalletPage("home");
      setNotice(`转账已广播：${txid.slice(0, 14)}…`);
      if (activeProfile) await refreshWallet(activeProfile.id, addresses);
    });
  }

  function lockWallet() {
    walletAccessGeneration.current++;
    wallet.lock(); setAddresses(null); setFreshSnapshotKey(null); setWalletPage("home"); setPreview(null); setShowMnemonic(""); setAutoFingerAttempted(true);
    setTab("wallet"); setNotice("钱包已锁定");
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (!blob) return;
    await run(async () => {
      const result = await wallet.changePassword(blob, oldPassword, newPassword);
      persistProfiles({ ...profileStore, profiles: profileStore.profiles.map((profile) => profile.id === activeProfile?.id && profile.kind === "wallet" ? { ...profile, blob: result.blob } : profile) });
      setOldPassword(""); setNewPassword(""); setNotice("密码已修改");
    });
  }

  async function toggleBiometric() {
    if (!blob) return;
    const generation = walletAccessGeneration.current;
    const address = blob.address;
    await run(async () => {
      if (fingerprintEnabled) {
        await biometric.disable(address, biometricAddress);
        if (biometricAddress === address) {
          localStorage.removeItem(BIOMETRIC_ADDRESS_KEY); setBiometricAddress(null);
        }
        if (generation !== walletAccessGeneration.current) return;
        setBiometricStatus({ address, available: biometricStatus.available, enabled: false });
        setNotice("已关闭指纹授权");
      } else {
        if (!fingerPassword) throw new Error("请输入钱包密码");
        const { mnemonic } = await wallet.export(blob, fingerPassword);
        if (generation !== walletAccessGeneration.current) return;
        await biometric.enable(address, mnemonic);
        if (generation !== walletAccessGeneration.current) return;
        setFingerPassword(""); setBiometricStatus({ address, available: biometricStatus.available, enabled: true });
        setNotice("已启用指纹授权");
      }
    });
  }

  async function exportMnemonic() {
    if (!blob) return;
    const revealSequence = ++secretRevealSequence.current;
    await run(async () => {
      if (!backupPassword) throw new Error("请输入钱包密码");
      const result = await wallet.export(blob, backupPassword);
      if (document.hidden || activeTab.current !== "setting" || revealSequence !== secretRevealSequence.current) return;
      await screenPrivacy.setSecure(true);
      setShowMnemonic(result.mnemonic);
      setBackupPassword("");
      if (backupRevealTimer.current) clearTimeout(backupRevealTimer.current);
      backupRevealTimer.current = setTimeout(() => setShowMnemonic(""), 60_000);
    });
  }

  function switchProfile(profile: WalletProfile) {
    if (profile.id === profileStore.activeId) { setProfileMenuOpen(false); setRenamingProfile(false); setConfirmRemoveWatch(false); return; }
    walletAccessGeneration.current++;
    wallet.lock();
    persistProfiles({ ...profileStore, activeId: profile.id });
    setAddresses(profile.kind === "watch" ? [profile.address] : !requireUnlock && profile.addresses.length ? profile.addresses : null);
    setFreshSnapshotKey(null); setSnapshotError(""); setWalletPage("home"); setTab("wallet");
    setProfileMenuOpen(false); setRenamingProfile(false); setConfirmRemoveWatch(false); setAddingProfile(false); setPreview(null); setAuthPassword("");
    setShowMnemonic(""); setBackupMnemonic(""); setPassword(""); setOldPassword(""); setFingerPassword(""); setBackupPassword("");
    setAutoFingerAttempted(false);
  }

  function startAddingProfile(mode: "create" | "restore" | "watch") {
    walletAccessGeneration.current++;
    wallet.lock();
    setAddresses(activeProfile?.kind === "watch" ? [activeProfile.address] : null);
    setSetupMode(mode); setAddingProfile(true); setProfileMenuOpen(false); setRenamingProfile(false); setConfirmRemoveWatch(false); setTab("wallet");
    setWalletPage("home"); setPreview(null); setPassword(""); setInputMnemonic(""); setBackupMnemonic("");
    setWalletName(""); setAutoFingerAttempted(true);
  }

  function renameActiveProfile(event: FormEvent) {
    event.preventDefault();
    if (!activeProfile) return;
    try {
      const name = profileName(renameInput, profileStore.profiles.filter((profile) => profile.id !== activeProfile.id));
      persistProfiles({ ...profileStore, profiles: profileStore.profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, name } : profile) });
      setRenamingProfile(false); setProfileMenuOpen(false); setRenameInput(""); setNotice("名称已修改");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "名称无效"); }
  }

  function removeActiveWatch() {
    if (activeProfile?.kind !== "watch") return;
    const removedId = activeProfile.id;
    setSnapshotCache((previous) => {
      const next = { ...previous };
      delete next[removedId];
      try { saveSnapshotCache(next); } catch { /* Keep removal in memory. */ }
      return next;
    });
    walletAccessGeneration.current++;
    wallet.lock();
    const remaining = profileStore.profiles.filter((profile) => profile.id !== activeProfile.id);
    const next = remaining[0] ?? null;
    persistProfiles({ ...profileStore, profiles: remaining, activeId: next?.id ?? null });
    setAddresses(next?.kind === "watch" ? [next.address] : next?.kind === "wallet" && !requireUnlock && next.addresses.length ? next.addresses : null);
    setFreshSnapshotKey(null); setSnapshotError(""); setWalletPage("home"); setPreview(null); setBackupMnemonic("");
    setProfileMenuOpen(false); setConfirmRemoveWatch(false); setRenamingProfile(false); setAutoFingerAttempted(false);
    setNotice("观察地址已移除");
  }

  function toggleUnlock() {
    const next = !requireUnlock;
    localStorage.setItem(UNLOCK_KEY, String(next));
    setRequireUnlock(next);
    if (!next && blob && addresses && activeProfile?.kind === "wallet") {
      persistProfiles({ ...profileStore, profiles: profileStore.profiles.map((profile) => profile.id === activeProfile.id && profile.kind === "wallet" ? { ...profile, addresses } : profile) });
    }
  }

  async function checkUpdate() {
    setUpdateStatus("正在检查…");
    try {
      let manifest: ReturnType<typeof parseUpdateManifest> | null = null;
      for (const url of UPDATE_MANIFEST_URLS) {
        try {
          const response = Capacitor.isNativePlatform()
            ? await CapacitorHttp.get({ url, connectTimeout: 8000, readTimeout: 8000 })
            : { status: 200, data: await (await fetch(url, { signal: AbortSignal.timeout(8000) })).text() };
          if (response.status !== 200) throw new Error("更新服务不可用");
          manifest = parseUpdateManifest(response.data);
          break;
        } catch { /* Try the backup manifest. */ }
      }
      if (!manifest) throw new Error("更新服务不可用");
      if (!isNewerVersion(manifest.version, APP_VERSION)) {
        setUpdateStatus("已是最新版本"); return;
      }
      setUpdateStatus(`正在下载 ${manifest.version}…`);
      await installUpdate(manifest.apkUrl, manifest.backupApkUrl, manifest.sha256);
      setUpdateStatus("请按系统提示安装更新");
    } catch (failure) { setUpdateStatus(failure instanceof Error ? failure.message : "检查更新失败"); }
  }

  const balanceLabel = projected ? formatPrl(projected.balanceGrains) : "—";
  const visibleActivities = projected?.activities ?? snapshot?.activities ?? [];
  const sendMax = snapshotFresh && projected && !snapshot?.partial && !snapshotError
    ? maxSpendable(projected.availableUtxos, SEND_FEE_RATES[sendFeeTier]) : 0n;
  const spotEstimatedUSDT = estimatedSpotAssetsUSDT(account?.balances, exchange?.price);

  function chooseSendPercent(percent: number) {
    if (sendMax <= 0n) return;
    setSendAmount(formatPrl(sendMax * BigInt(percent) / 100n));
  }

  function openAddressBook(purpose: "send" | "manage") {
    setAddressBookPurpose(purpose);
    setExpandedAddressWallets(new Set());
    setAddingAddress(false);
    setEditingAddress(null);
    setAddressBookError("");
    setAddressBookOpen(true);
  }

  function saveAddressEntry(event: FormEvent) {
    event.preventDefault();
    const address = entryAddress.trim();
    const note = entryNote.trim();
    if (!isValidPearlAddress(address)) { setAddressBookError("请输入有效的 Pearl 主网地址"); return; }
    if (!note || note.length > 50) { setAddressBookError("备注需为 1–50 个字符"); return; }
    const ownAddress = profileAddressChoices(profileStore.profiles).some((entry) => entry.address === address);
    if (ownAddress) { setAddressBookError("此地址已在本机钱包或观察地址中"); return; }
    if (savedAddresses.some((entry) => entry.address === address && entry.address !== editingAddress)) { setAddressBookError("此地址已在地址簿中"); return; }
    if (!editingAddress && savedAddresses.length >= 100) { setAddressBookError("地址簿最多保存 100 个地址"); return; }
    const next = [...savedAddresses.filter((entry) => entry.address !== editingAddress), { address, note }];
    try { saveSavedAddresses(next); }
    catch { setAddressBookError("本机储存失败，地址未保存"); return; }
    setSavedAddresses(next);
    setEditingAddress(null); setAddingAddress(false); setEntryAddress(""); setEntryNote(""); setAddressBookError("");
    setNotice("地址已保存到本机");
  }

  function chooseBookAddress(address: string) {
    if (addressBookPurpose === "manage") { void copy(address); return; }
    setSendAddress(address);
    setAddressBookOpen(false);
  }

  function deleteSavedAddress(address: string) {
    const next = savedAddresses.filter((entry) => entry.address !== address);
    try { saveSavedAddresses(next); }
    catch { setAddressBookError("本机储存失败，地址未删除"); return; }
    setSavedAddresses(next);
    setAddressBookError("");
  }

  function addressBookRow(entry: SavedAddress & { kind?: "wallet" | "watch" | "saved" }) {
    return <div className="address-row" key={`${entry.kind}:${entry.address}`}><button type="button" className="address-choice" onClick={() => chooseBookAddress(entry.address)}><strong>{entry.note || "未命名地址"}</strong><small>{entry.address}</small></button>{entry.kind === "saved" && <div className="address-actions"><button type="button" onClick={() => { setEditingAddress(entry.address); setAddingAddress(true); setEntryAddress(entry.address); setEntryNote(entry.note); setAddressBookError(""); }}>编辑</button><button type="button" onClick={() => deleteSavedAddress(entry.address)}>删除</button></div>}</div>;
  }

  const sourceOptions: { id: MarketSource; pair: string; venue: string; category: "spot" | "perp" | "chain"; market: MarketData | null }[] = [
    { id: "safetrade", pair: "PRL/USDT", venue: "SafeTrade · 现货", category: "spot", market: exchange },
    { id: "wprl", pair: "WPRL/USDT", venue: "Uniswap · 链上", category: "chain", market: wprlExchange },
    { id: "hyperliquid", pair: `${hyperliquidCoin}/${hyperliquidOverview?.contract?.quote ?? "USDC"}`, venue: `Hyperliquid · ${hyperliquidOverview?.contract?.example === false ? "永续" : "BTC 示例"}`, category: "perp", market: hyperliquidExchange },
    { id: "lighter", pair: "PRL/USDC", venue: "Lighter · 永续", category: "perp", market: lighterExchange },
    { id: "aster", pair: "PEARL/USDT", venue: "Aster · Pearl 永续", category: "perp", market: asterExchange },
  ];
  const visibleSources = sourceOptions.filter((option) => sourceCategory === "all" || option.category === sourceCategory);
  const localAddressChoices = profileAddressChoices(profileStore.profiles);

  function profilePicker() {
    return <div className="profile-picker">
      <button className="profile-trigger" onClick={() => { setProfileMenuOpen(!profileMenuOpen); setRenamingProfile(false); setConfirmRemoveWatch(false); }} aria-expanded={profileMenuOpen} aria-label="切换钱包">
        <span>{activeProfile?.name ?? "选择钱包"}</span><Icon name="chevron" size={18} />
      </button>
      {profileMenuOpen && <div className="profile-menu">
        {profileStore.profiles.map((profile) => <button className={profile.id === profileStore.activeId ? "chosen" : ""} key={profile.id} onClick={() => switchProfile(profile)}><span>{profile.name}<small>{profile.kind === "watch" ? "观察" : "钱包"}</small></span>{profile.id === profileStore.activeId && <span aria-hidden="true">✓</span>}</button>)}
        <div className="profile-menu-divider" />
        <button onClick={() => startAddingProfile("create")}>＋ 创建钱包</button>
        <button onClick={() => startAddingProfile("restore")}>＋ 导入钱包</button>
        <button onClick={() => startAddingProfile("watch")}>＋ 添加观察地址</button>
        <div className="profile-menu-divider" />
        {renamingProfile ? <form className="profile-rename" onSubmit={renameActiveProfile}><input aria-label="新的钱包名称" value={renameInput} maxLength={24} onChange={(event) => setRenameInput(event.target.value)} autoFocus /><button type="submit">保存名称</button><button type="button" onClick={() => setRenamingProfile(false)}>取消</button></form> : <button onClick={() => { setRenameInput(activeProfile?.name ?? ""); setRenamingProfile(true); setConfirmRemoveWatch(false); }}>重命名</button>}
        {activeProfile?.kind === "watch" && (confirmRemoveWatch ? <><button className="danger" onClick={removeActiveWatch}>确认移除观察地址</button><button onClick={() => setConfirmRemoveWatch(false)}>取消</button></> : <button className="danger" onClick={() => { setConfirmRemoveWatch(true); setRenamingProfile(false); }}>移除观察地址</button>)}
      </div>}
    </div>;
  }

  function startPull(event: React.TouchEvent) {
    if (window.scrollY > 2 || event.touches.length !== 1) { pullStart.current = null; return; }
    const x = event.touches[0]!.clientX;
    if (x < 28 || x > window.innerWidth - 28) { pullStart.current = null; return; }
    pullStart.current = event.touches[0]!.clientY;
  }

  function movePull(event: React.TouchEvent) {
    if (pullStart.current === null) return;
    const delta = event.touches[0]!.clientY - pullStart.current;
    pullDistanceRef.current = Math.min(84, Math.max(0, delta / 2));
    setPullDistance(pullDistanceRef.current);
  }

  function endPull() {
    if (pullDistanceRef.current >= 48 && addresses && activeProfile) refreshWallet(activeProfile.id, addresses);
    pullStart.current = null;
    pullDistanceRef.current = 0;
    setPullDistance(0);
  }

  return <div className={`app ${tab === "market" ? "trade-active" : ""} ${fullBookOpen || tradeHistoryOpen ? "full-book-active" : ""}`} onContextMenu={(event) => { if (!(event.target instanceof HTMLElement) || !event.target.closest("input, textarea, .secret-phrase")) event.preventDefault(); }}>
    <main className="content">
      {tab === "wallet" && (!activeProfile || addingProfile) && <section className="onboarding">
        {addingProfile && <button className="back" aria-label="取消添加钱包" onClick={() => { setAddingProfile(false); setWalletName(""); setPassword(""); setInputMnemonic(""); setAddresses(activeProfile?.kind === "watch" ? [activeProfile.address] : !requireUnlock && activeProfile?.kind === "wallet" && activeProfile.addresses.length ? activeProfile.addresses : null); setAutoFingerAttempted(false); }}><Icon name="back" /></button>}
        <img className="brand-logo" src="/pearl-logo.svg" alt="Pearl" /><h1>Pearl Wallet</h1>
        <div className="segmented"><button className={setupMode === "create" ? "active" : ""} onClick={() => { setSetupMode("create"); setInputMnemonic(""); }}>创建钱包</button><button className={setupMode === "restore" ? "active" : ""} onClick={() => setSetupMode("restore")}>导入钱包</button><button className={setupMode === "watch" ? "active" : ""} onClick={() => { setSetupMode("watch"); setInputMnemonic(""); }}>观察地址</button></div>
        {setupMode !== "watch" && <div className="onboarding-warning" role="alert"><Icon name="shield" size={20} /><div><strong>密钥安全提示</strong><p>此应用尚未经过独立安全审计，助记词和私钥的安全性无法保证。只需查看余额与交易时，建议使用观察地址，无需提供密钥。</p><button type="button" onClick={() => { setSetupMode("watch"); setInputMnemonic(""); }}>使用观察地址 →</button></div></div>}
        <form onSubmit={createOrRestore} className="form-card">
          <Field label="钱包名称" value={walletName} onChange={setWalletName} placeholder={setupMode === "watch" ? "例如：观察地址" : "例如：主钱包"} autoComplete="off" />
          {setupMode === "restore" && <label className="field"><span>助记词</span><textarea value={inputMnemonic} onChange={(event) => setInputMnemonic(event.target.value)} rows={4} placeholder="输入 12 或 24 个英文单词" spellCheck={false} autoComplete="off" /></label>}
          {setupMode === "watch" ? <Field label="Pearl 地址" value={watchInput} onChange={setWatchInput} placeholder="prl1…" autoComplete="off" /> : <><Field label="钱包密码" value={password} onChange={setPassword} type="password" placeholder="至少 12 个字符" autoComplete="new-password" /><Field label="确认密码" value={passwordAgain} onChange={setPasswordAgain} type="password" autoComplete="new-password" /></>}
          <button className="primary" disabled={busy}>{busy ? "正在处理…" : setupMode === "create" ? "创建钱包" : setupMode === "restore" ? "导入钱包" : "开始观察"}</button>
        </form>{setupMode !== "watch" && <p className="safety-note"><Icon name="shield" size={18} /> 助记词请离线保存。</p>}
      </section>}

      {tab === "wallet" && blob && !addresses && !addingProfile && <section className="onboarding unlock-page">
        {profilePicker()}
        <img className="brand-logo" src="/pearl-logo.svg" alt="Pearl" /><h1>解锁钱包</h1>
        <form onSubmit={unlock} className="form-card"><Field label="钱包密码" value={password} onChange={setPassword} type="password" autoComplete="current-password" /><button className="primary" disabled={busy}>{busy ? "正在解锁…" : "解锁钱包"}</button></form>
        {fingerprintEnabled && <button className="secondary wide" onClick={unlockWithFinger} disabled={busy}><Icon name="finger" size={20} /> 使用指纹</button>}
      </section>}

      {tab === "wallet" && addresses && backupMnemonic && !addingProfile && <section className="onboarding backup-page">
        <p className="eyebrow">RECOVERY PHRASE</p><h1>备份你的助记词</h1><p className="muted">按顺序抄写并离线保存。丢失手机后，只有助记词能恢复钱包。</p>
        <div className="word-grid">{backupMnemonic.split(" ").map((word, index) => <div key={index}><small>{index + 1}</small>{word}</div>)}</div>
        <Field label="确认第 3 个单词" value={backupCheck} onChange={setBackupCheck} autoComplete="off" />
        <button className="primary" disabled={backupCheck.trim().toLowerCase() !== backupMnemonic.split(" ")[2]} onClick={() => { setBackupMnemonic(""); setBackupCheck(""); setNotice("备份确认完成"); }}>我已安全备份</button>
      </section>}

      {tab === "wallet" && addresses && !backupMnemonic && !addingProfile && walletPage === "home" && <section className="wallet-home" onTouchStart={startPull} onTouchMove={movePull} onTouchEnd={endPull} onTouchCancel={endPull}>
        <div className="home-top">{profilePicker()}{watchMode && <span className="watch-badge">观察模式</span>}</div>
        {pullDistance > 0 && <div className="pull-indicator" style={{ height: pullDistance }}>{pullDistance >= 48 ? "松开刷新" : "下拉刷新"}</div>}
        {walletRefreshing && <div className="pull-status">正在同步链上数据…{snapshot && !snapshotFresh ? " 当前显示上次记录" : ""}</div>}
        <div className="balance-block"><p>{projected?.estimated ? "预计总余额" : "Total Balance"}</p><h1>{balanceLabel} <span>PRL</span></h1>{!!projected?.pendingGrains && <small>待确认 {formatPrl(projected.pendingGrains)} PRL · 暂不可转</small>}{projected?.estimated && <small>含本机待确认转账估算，以链上确认为准</small>}{snapshot?.partial && <small>链上记录未完全同步</small>}</div>
        <div className="actions">{!watchMode && <ActionCard icon="send" label="Send" onClick={() => setWalletPage("send")} />}<ActionCard icon="receive" label="Receive" onClick={() => setWalletPage("receive")} /></div>
        <div className="section-heading"><h2>Activity</h2><div className="section-actions"><button aria-label="刷新链上数据" onClick={() => activeProfile && refreshWallet(activeProfile.id, addresses)}><Icon name="refresh" size={19} /></button><button onClick={() => setWalletPage("history")}>View All</button></div></div>
        {snapshotError && <div className="inline-error">{snapshotError}{snapshot && <span> · 显示上次同步结果，转账前请重试</span>}<button onClick={() => activeProfile && refreshWallet(activeProfile.id, addresses)}>重试</button></div>}
        {!snapshot && !snapshotError && <p className="muted">正在同步链上记录…</p>}
        {snapshot && visibleActivities.length === 0 && <div className="empty-card">暂无链上交易</div>}
        {visibleActivities.slice(0, 4).map((item) => <div className="activity" key={item.txid}><span className="activity-icon"><Icon name={item.deltaGrains >= 0n ? "receive" : "send"} size={18} /></span><div><strong>{item.deltaGrains >= 0n ? "Received" : "Sent"}</strong><small>{projected?.staleTxids.has(item.txid.toLowerCase()) ? "待核对" : item.confirmations === 0 ? "待确认" : item.time ? new Date(item.time * 1000).toLocaleString("zh-CN") : "时间未知"}</small></div><em className={item.deltaGrains >= 0n ? "positive" : "negative"}>{item.deltaGrains >= 0n ? "+" : ""}{formatPrl(item.deltaGrains)} PRL</em></div>)}
      </section>}

      {tab === "wallet" && addresses && !backupMnemonic && !addingProfile && walletPage !== "home" && <section className="subpage">
        <div className="subpage-head"><button className="back" onClick={() => { setWalletPage("home"); setPreview(null); setAuthPassword(""); }}><Icon name="back" /></button><h1>{walletPage === "send" ? "发送 PRL" : walletPage === "receive" ? "接收 PRL" : "全部记录"}</h1></div>
        {walletPage === "receive" && <div className="receive-card"><p className="muted">Pearl 主网地址</p>{receiveQr && <img src={receiveQr} alt="收款地址二维码" className="qr" />}<p className="address-text">{addresses[0]}</p><button className="secondary" onClick={() => copy(addresses[0]!)}><Icon name="copy" size={18} /> 复制地址</button></div>}
        {walletPage === "send" && !preview && <form className="send-form" onSubmit={makePreview}>
          <div className="send-wallet-card"><div><span>付款钱包</span><strong>{activeProfile?.name ?? "—"}</strong></div><div><span>钱包余额</span><strong>{projected ? `${formatPrl(projected.balanceGrains)} PRL` : "—"}</strong></div></div>
          <label className="send-field"><span>转账金额</span><div className="send-amount-input"><input value={sendAmount} onChange={(event) => setSendAmount(event.target.value)} inputMode="decimal" placeholder="0.00" autoComplete="off" aria-label="转账金额" /><strong>PRL</strong></div></label>
          <p className="send-spendable">最多可发送 {snapshotFresh && !snapshot?.partial ? formatPrl(sendMax) : "—"} PRL</p>
          <div className="send-percent-buttons">{[25, 50, 75, 100].map((percent) => <button key={percent} type="button" disabled={sendMax <= 0n} onClick={() => chooseSendPercent(percent)}>{percent === 100 ? "MAX" : `${percent}%`}</button>)}</div>
          <div className="send-field"><div className="send-address-heading"><span>收款地址</span><button type="button" onClick={() => openAddressBook("send")}>地址簿 ›</button></div><input value={sendAddress} onChange={(event) => setSendAddress(event.target.value)} placeholder="输入 prl1… 收款地址" autoComplete="off" spellCheck={false} aria-label="收款地址" /></div>
          <div className="send-fee-section"><span className="send-fee-title">交易手续费</span><div className="send-fee-card"><div className="send-fee-options">{(["priority", "standard", "economy"] as const).map((tier) => <button key={tier} type="button" className={sendFeeTier === tier ? "selected" : ""} aria-pressed={sendFeeTier === tier} onClick={() => setSendFeeTier(tier)}><span>{tier === "priority" ? "⚡" : tier === "standard" ? "◷" : "○"}</span><strong>{tier === "priority" ? "优先" : tier === "standard" ? "标准" : "经济"}</strong><small>{SEND_FEE_RATES[tier].toString()} grains/vB</small></button>)}</div><div className="send-fee-rate"><span>当前费率</span><strong>{formatPrl(SEND_FEE_RATES[sendFeeTier] * 1000n)} PRL/kB</strong></div></div></div>
          <button className="primary send-preview-button" disabled={!snapshotFresh || !snapshot || !!snapshotError || !!snapshot.partial || busy || !sendAmount.trim() || !sendAddress.trim()}>预览转账</button>
        </form>}
        {walletPage === "send" && preview && <div className="form-card"><p className="eyebrow">CONFIRM TRANSACTION</p><h2>请核对转账信息</h2><div className="preview-row"><span>收款地址</span><strong className="break">{preview.destination}</strong></div><div className="preview-row"><span>转账金额</span><strong>{formatPrl(BigInt(preview.amountGrains))} PRL</strong></div><div className="preview-row"><span>预计矿工费</span><strong>{formatPrl(BigInt(preview.feeGrains))} PRL</strong></div><div className="preview-row"><span>找零</span><strong>{formatPrl(BigInt(preview.changeGrains))} PRL</strong></div><Field label="钱包密码" value={authPassword} onChange={setAuthPassword} type="password" autoComplete="current-password" /><button className="primary" disabled={busy || !authPassword} onClick={() => confirmSend(false)}>{busy ? "正在发送…" : "确认并发送"}</button>{fingerprintEnabled && <button className="secondary wide" disabled={busy} onClick={() => confirmSend(true)}><Icon name="finger" size={18} /> 使用指纹确认</button>}<button className="text-button" onClick={() => { setPreview(null); setAuthPassword(""); }}>返回修改</button></div>}
        {walletPage === "history" && <div className="history-list">{!visibleActivities.length && <div className="empty-card">暂无链上交易</div>}{visibleActivities.map((item) => <div className="activity" key={item.txid}><span className="activity-icon"><Icon name={item.deltaGrains >= 0n ? "receive" : "send"} size={18} /></span><div><strong>{item.deltaGrains >= 0n ? "Received" : "Sent"}</strong><small>{projected?.staleTxids.has(item.txid.toLowerCase()) ? "待核对" : item.confirmations === 0 ? "待确认" : item.time ? new Date(item.time * 1000).toLocaleString("zh-CN") : "时间未知"}<br />{item.txid.slice(0, 16)}…</small></div><em className={item.deltaGrains >= 0n ? "positive" : "negative"}>{item.deltaGrains >= 0n ? "+" : ""}{formatPrl(item.deltaGrains)} PRL</em></div>)}</div>}
      </section>}

      {tab === "market" && fullBookOpen && <FullOrderBook source={marketSource as TradeSource} symbol={activeSymbol} quote={activeQuote} onBack={closeMarketDetail} />}
      {tab === "market" && tradeHistoryOpen && <TradeHistoryPage source={marketSource as TradeSource} symbol={activeSymbol} quote={activeQuote} onBack={closeMarketDetail} />}
      {tab === "market" && !fullBookOpen && !tradeHistoryOpen && <section className="trade-page">
        <div className="pair-head"><button type="button" className="market-pair-picker" onClick={() => { setSourcePickerOpen(true); void refreshOverview(); void refreshWprlOverview(); void refreshHyperliquidOverview(); void refreshLighterOverview(); void refreshAsterOverview(); }} aria-label="选择行情来源"><h1>{activeExchange?.pair ?? `${activeSymbol}/${activeQuote}`} <Icon name="chevron" size={18} /></h1><small>{isAster ? "Aster 永续 · 只读行情" : isLighter ? "Lighter 永续 · 只读行情" : isHyperliquid ? `Hyperliquid 永续 · ${hyperliquidOverview?.contract?.example === false ? "只读行情" : "BTC 示例，非 PRL"}` : isWprl ? "以太坊 · Uniswap V3" : "SafeTrade 现货"}</small></button><button className="market-refresh" aria-label="刷新行情" onClick={() => { if (isAster) { void refreshAsterOverview(); void refreshAsterCandles(interval); } else if (isLighter) { void refreshLighterOverview(); void refreshLighterCandles(interval); } else if (isHyperliquid) { void refreshHyperliquidOverview(); void refreshHyperliquidCandles(interval); } else if (isWprl) { void refreshWprlOverview(); void refreshWprlCandles(interval); } else refreshExchange(); }}><Icon name="refresh" size={19} /></button></div>
        <div className="market-summary"><div className="market-last"><strong className={(activeExchange?.stats24h?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{marketNumber(activeExchange?.price, isHyperliquid ? 2 : isLighter ? 4 : 8)}</strong><span>{activeQuote} <em className={(activeExchange?.stats24h?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{activeExchange?.stats24h?.changePercent == null ? "" : `${activeExchange.stats24h.changePercent >= 0 ? "+" : ""}${activeExchange.stats24h.changePercent.toFixed(2)}%`}</em></span></div><div className="market-stats"><div><span>{isPerp ? "标记价格" : "24h 最高"}</span><strong>{marketNumber(isPerp ? perpOverview?.markPrice : activeExchange?.stats24h?.high, isHyperliquid ? 2 : isLighter ? 4 : 8)}</strong></div><div><span>{isPerp ? "预言机价格" : "24h 最低"}</span><strong>{marketNumber(isPerp ? perpOverview?.oraclePrice : activeExchange?.stats24h?.low, isHyperliquid ? 2 : isLighter ? 4 : 8)}</strong></div><div><span>{isPerp ? "持仓量" : isWprl ? "池流动性" : "24h 成交量"}</span><strong>{isPerp ? `${compactMarketNumber(perpOverview?.openInterest)} ${activeSymbol}` : isWprl ? `${compactMarketNumber(wprlOverview?.liquidityUsd)} USD` : `${compactMarketNumber(exchange?.stats24h?.volume)} PRL`}</strong></div><div><span>{isPerp ? "资金费率" : "24h 成交额"}</span><strong>{isPerp ? perpOverview?.funding == null ? "—" : `${(perpOverview.funding * 100).toFixed(4)}%` : `${compactMarketNumber(activeExchange?.stats24h?.turnover)} ${isWprl && wprlOverview?.statsSource !== "recorded" ? "USD" : "USDT"}`}</strong></div></div></div>
        <div className="intervals">{INTERVALS.map((option) => <button key={option.id} className={interval === option.id ? "active" : ""} onClick={() => setIntervalValue(option.id)}>{option.label}</button>)}</div>
        <div className="chart-card"><CandleChart key={`${marketSource}:${interval}`} candles={activeCandles} currentPrice={activeExchange?.price} loading={isAster ? asterRefreshing : isLighter ? lighterRefreshing : isHyperliquid ? hyperliquidRefreshing : isWprl ? wprlRefreshing : marketRefreshing} status={activeSeries && Date.now() - activeSeries.updatedAt > (isPerp ? 90_000 : isWprl ? 45_000 : 15_000) ? `更新于 ${new Date(activeSeries.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""} symbol={activeSymbol} /></div>
        {activeMarketError && <div className="inline-error">{activeMarketError}<button onClick={() => { if (isAster) { void refreshAsterOverview(); void refreshAsterCandles(interval); } else if (isLighter) { void refreshLighterOverview(); void refreshLighterCandles(interval); } else if (isHyperliquid) { void refreshHyperliquidOverview(); void refreshHyperliquidCandles(interval); } else if (isWprl) { void refreshWprlOverview(); void refreshWprlCandles(interval); } else refreshExchange(); }}>重试</button></div>}
        {activeExchange?.marketError && <div className="inline-error">{activeExchange.marketError}</div>}
{isWprl ? <><div className="market-tabs market-tabs-static"><strong>链上成交</strong><a href="https://www.geckoterminal.com/eth/pools/0x89a67c6dee35db9815da2fb9191f0998a8b37c39" target="_blank" rel="noreferrer">查看交易池 ↗</a></div><RecentTrades trades={wprlExchange?.trades} symbol="WPRL" /><div className="wprl-source-note">{wprlSeries?.source === "provider" ? "历史 K 线来自 GeckoTerminal" : wprlSeries?.source === "mixed" ? "起点前 K 线为外部参考，此后持续记录" : "K 线由服务器持续记录"}{(wprlSeries?.recordingSince || wprlOverview?.recordingSince) ? ` · ${new Date((wprlSeries?.recordingSince || wprlOverview?.recordingSince)!).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 起` : ""}</div></> : <><div className="market-tabs"><button className={marketDetails === "depth" ? "active" : ""} onClick={() => setMarketDetails("depth")}>订单簿</button><button className={marketDetails === "trades" ? "active" : ""} onClick={() => setMarketDetails("trades")}>最新成交</button><button type="button" className="full-book-entry" onClick={marketDetails === "depth" ? openFullBook : openTradeHistory}>{marketDetails === "depth" ? "查看完整盘口 ›" : "查看更多成交 ›"}</button></div>{marketDetails === "depth" ? <OrderBook depth={activeExchange?.depth} symbol={activeSymbol} quote={activeQuote} /> : <RecentTrades trades={activeExchange?.trades} symbol={activeSymbol} quote={activeQuote} />}{isPerp && <div className="wprl-source-note">{perpTradeSample > 0 ? `高负载模式：最近成交抽样展示，跳过 ${perpTradeSample} 笔 · ` : ""}K 线由服务器持续记录{perpRecordingSince ? ` · ${new Date(perpRecordingSince! * 1000).toLocaleDateString("zh-CN")} 起` : ""}</div>}</>}
        {!isWprl && !isPerp && <>
        <div className="exchange-assets-head"><h2>现货资产</h2>{connectionToken && <div className="exchange-assets-actions"><button aria-label="刷新现货资产" title="刷新现货资产" onClick={refreshSafeTradeAccount}><Icon name="refresh" size={18} /></button><button aria-label="管理 SafeTrade 连接" title="管理连接" onClick={() => setAccountMenuOpen((open) => !open)}>•••</button>{accountMenuOpen && <div className="account-menu"><button onClick={() => { setAccountMenuOpen(false); void removeSafeTradeConnection(); }}>断开连接</button></div>}</div>}</div>
        {connectionToken ? <div className="exchange-balances"><div className="exchange-total"><span>预估总资产</span><strong>{spotEstimatedUSDT === null ? "—" : `≈ ${marketNumber(spotEstimatedUSDT, 2)}`} <small>USDT</small></strong></div>{(["PRL", "USDT"] as const).map((asset) => { const balance = account?.balances[asset]; const total = balance ? totalAssetBalance(balance) : null; const approximate = total === null || (asset === "PRL" && exchange?.price == null) ? NaN : asset === "USDT" ? Number(total) : Number(total) * exchange!.price!; return <div className="asset-card" key={asset}><img className="asset-logo" src={asset === "PRL" ? "/pearl-logo.svg" : "/usdt.svg"} alt="" /><div className="asset-info"><strong>{asset}</strong>{balance && Number(balance.locked) > 0 && <small>挂单占用 {balance.locked}</small>}</div><div className="asset-values"><strong>{total ?? "—"}</strong><small>{Number.isFinite(approximate) ? `≈ ${marketNumber(approximate, 2)} USDT` : "余额待更新"}</small></div></div>; })}</div> : <form className="safetrade-connect" onSubmit={(event) => { event.preventDefault(); void connectSafeTrade(); }}><Field label="只读 API Key" value={safeKey} onChange={setSafeKey} autoComplete="off" /><Field label="API Secret" value={safeSecret} onChange={setSafeSecret} type="password" autoComplete="off" /><button className="primary" disabled={connectingSafeTrade || !safeKey.trim() || !safeSecret.trim()}>{connectingSafeTrade ? "连接中…" : "连接 SafeTrade"}</button><p>密钥仅发送到 Pearl Wallet 服务器，用于读取 PRL 和 USDT 余额。</p></form>}
        {accountError && <div className="inline-error">{accountError}</div>}
        </>}
      </section>}

      {tab === "setting" && <section className="settings-page"><div className="page-title"><h1>Setting</h1></div>
        <div className="settings-card"><div className="settings-title"><Icon name="wallet" /><div><strong>地址簿</strong></div></div><button type="button" className="secondary wide" onClick={() => openAddressBook("manage")}>查看和管理地址</button></div>
        {blob && <>
          <div className="settings-card"><div className="settings-title"><Icon name="lock" /><div><strong>进入钱包时解锁</strong></div></div><button className="secondary wide" onClick={toggleUnlock}>{requireUnlock ? "已开启 · 点击关闭" : "已关闭 · 点击开启"}</button></div>
          <div className="settings-card"><div className="settings-title"><Icon name="lock" /><div><strong>修改钱包密码</strong></div></div><form onSubmit={changePassword}><Field label="当前密码" value={oldPassword} onChange={setOldPassword} type="password" autoComplete="current-password" /><Field label="新密码" value={newPassword} onChange={setNewPassword} type="password" autoComplete="new-password" /><button className="secondary wide" disabled={busy || !oldPassword || !newPassword}>修改密码</button></form></div>
          <div className="settings-card"><div className="settings-title"><Icon name="finger" /><div><strong>指纹授权</strong></div></div>{!fingerprintEnabled && <Field label="钱包密码" value={fingerPassword} onChange={setFingerPassword} type="password" autoComplete="current-password" />}<button className="secondary wide" disabled={!biometricStatus.available || busy || (!fingerprintEnabled && !fingerPassword)} onClick={toggleBiometric}>{fingerprintEnabled ? "关闭指纹" : "启用指纹"}</button></div>
          <div className="settings-card"><div className="settings-title"><Icon name="shield" /><div><strong>助记词备份</strong></div></div><Field label="钱包密码" value={backupPassword} onChange={setBackupPassword} type="password" autoComplete="current-password" /><button className="secondary wide" disabled={busy || !backupPassword} onClick={exportMnemonic}>查看助记词</button>{showMnemonic && <div className="secret-phrase">{showMnemonic}</div>}</div>
          {addresses && !watchMode && <button className="lock-button" onClick={lockWallet}><Icon name="lock" size={19} /> 立即锁定钱包</button>}
        </>}
        <div className="settings-card"><div className="settings-title"><Icon name="refresh" /><div><strong>版本 {APP_VERSION}</strong></div></div><button className="secondary wide" onClick={checkUpdate}>检查更新</button>{updateStatus && <p className="update-status">{updateStatus}</p>}</div>
        <div className="settings-card"><div className="settings-title"><Icon name="wallet" /><div><strong>项目与支持</strong></div></div><div className="settings-links"><a href={PROJECT_URL} target="_blank" rel="noopener noreferrer">官方网站 <span aria-hidden="true">↗</span></a><a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">GitHub 源码 <span aria-hidden="true">↗</span></a><a href={`mailto:${CONTACT_EMAIL}`}>联系邮箱 <span>{CONTACT_EMAIL}</span></a></div><div className="donation-block"><span>PRL 捐赠地址</span><button type="button" className="donation-copy" onClick={() => copy(DONATION_ADDRESS, "捐赠地址已复制")} aria-label="复制 PRL 捐赠地址"><span>{DONATION_ADDRESS}</span><Icon name="copy" size={18} /></button></div></div>
      </section>}
    </main>
    {addressBookOpen && <div className="sheet-backdrop" onClick={() => setAddressBookOpen(false)}>
      <section className="picker-sheet address-sheet" role="dialog" aria-modal="true" aria-label="地址簿" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-heading"><h2>{addressBookPurpose === "send" ? "选择收款地址" : "地址簿"}</h2><button type="button" onClick={() => setAddressBookOpen(false)}>关闭</button></div>
        <div className="address-sheet-list">
          <div className="address-group"><h3>本机钱包</h3>
            {profileStore.profiles.filter((profile) => profile.kind === "wallet").map((profile) => {
              const rows = localAddressChoices.filter((entry) => entry.profileId === profile.id);
              const expanded = expandedAddressWallets.has(profile.id);
              return <div className="address-wallet-group" key={profile.id}>
                <button type="button" className="address-wallet-toggle" aria-expanded={expanded} onClick={() => setExpandedAddressWallets((previous) => { const next = new Set(previous); if (next.has(profile.id)) next.delete(profile.id); else next.add(profile.id); return next; })}>
                  <strong>{profile.name}</strong><span>{rows.length} 个地址 <Icon name="chevron" size={16} /></span>
                </button>
                {(expanded ? rows : rows.slice(0, 1)).map(addressBookRow)}
              </div>;
            })}
            {!profileStore.profiles.some((profile) => profile.kind === "wallet") && <p className="address-empty">暂无本机钱包</p>}
          </div>
          <div className="address-group"><h3>观察地址</h3>{localAddressChoices.filter((entry) => entry.kind === "watch").map(addressBookRow)}
            {!profileStore.profiles.some((profile) => profile.kind === "watch") && <p className="address-empty">暂无观察地址</p>}
          </div>
          <div className="address-group"><h3>已保存地址</h3>{savedAddresses.map((entry) => addressBookRow({ ...entry, kind: "saved" }))}
            {!savedAddresses.length && <p className="address-empty">还没有手动保存的地址</p>}
          </div>
        </div>
        {!addingAddress && addressBookError && <p className="address-book-error" role="alert">{addressBookError}</p>}
        {addingAddress ? <form className="address-entry-form" onSubmit={saveAddressEntry}><h3>{editingAddress ? "编辑地址" : "添加地址"}</h3><input value={entryAddress} onChange={(event) => setEntryAddress(event.target.value)} placeholder="Pearl 主网地址" autoComplete="off" spellCheck={false} aria-label="新地址" /><input value={entryNote} onChange={(event) => setEntryNote(event.target.value)} placeholder="备注，例如交易所或朋友" maxLength={50} aria-label="地址备注" />{addressBookError && <p role="alert">{addressBookError}</p>}<div><button type="button" onClick={() => { setAddingAddress(false); setEditingAddress(null); setAddressBookError(""); }}>取消</button><button type="submit">保存</button></div></form> : <button type="button" className="add-address-button" onClick={() => { setAddingAddress(true); setEditingAddress(null); setEntryAddress(""); setEntryNote(""); setAddressBookError(""); }}>＋ 添加地址</button>}
      </section>
    </div>}
    {sourcePickerOpen && <div className="sheet-backdrop" onClick={() => setSourcePickerOpen(false)}>
      <section className="picker-sheet source-sheet" role="dialog" aria-modal="true" aria-label="选择行情来源" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-heading"><h2>选择行情</h2><button type="button" onClick={() => setSourcePickerOpen(false)}>关闭</button></div>
        <div className="source-categories">{([{ id: "all", label: "全部" }, { id: "spot", label: "现货" }, { id: "perp", label: "合约" }, { id: "chain", label: "链上" }] as const).map((option) => <button type="button" key={option.id} className={sourceCategory === option.id ? "active" : ""} onClick={() => setSourceCategory(option.id)}>{option.label}</button>)}</div>
        <div className="source-list"><div className="source-list-head"><span>交易对 / 来源</span><span>最新价格 / 24h 涨跌</span></div>{visibleSources.map((option) => <button type="button" className={"source-row " + (marketSource === option.id ? "selected" : "")} key={option.id} onClick={() => { setMarketSource(option.id); setSourcePickerOpen(false); }}><span><strong>{option.pair}</strong><small>{option.venue}</small></span><span><strong>{marketNumber(option.market?.price, option.id === "hyperliquid" ? 2 : 6)}</strong><small className={(option.market?.stats24h?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{option.market?.stats24h?.changePercent == null ? "—" : (option.market.stats24h.changePercent >= 0 ? "+" : "") + option.market.stats24h.changePercent.toFixed(2) + "%"}</small></span></button>)}{!visibleSources.length && <p className="source-empty">此分类暂无行情</p>}</div>
      </section>
    </div>}
    {(error || notice) && <div className={error ? "toast error" : "toast"} role="status">{error || notice}<button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}
    <nav className="bottom-nav" aria-label="主导航"><button className={tab === "wallet" ? "selected" : ""} onClick={() => { setTab("wallet"); setError(""); }}><Icon name="wallet" size={22} /><span>Wallet</span></button><button className={tab === "market" ? "selected" : ""} onClick={() => { setTab("market"); setError(""); }}><Icon name="chart" size={22} /><span>Market</span></button><button className={tab === "setting" ? "selected" : ""} onClick={() => { setTab("setting"); setError(""); }}><Icon name="setting" size={22} /><span>Setting</span></button></nav>
  </div>;
}
