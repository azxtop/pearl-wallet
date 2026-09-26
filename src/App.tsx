import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { prepareSend, type SendPreview } from "./lib/send";
import type { EncryptedWallet } from "./lib/keystore";
import { BIOMETRIC_ADDRESS_KEY, loadProfiles, profileName, saveProfiles, type ProfileStore, type WalletProfile } from "./lib/profiles";

type Tab = "wallet" | "safetrade" | "setting";
type WalletPage = "home" | "send" | "receive" | "history";
type ExchangeData = {
  price: number | null;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number; empty: boolean }[];
  balances: { PRL: { available: string; locked: string } | null; USDT: { available: string; locked: string } | null };
  lastTradeAt: number | null;
  accountUpdatedAt: number | null;
  marketError: string | null;
  accountError: string | null;
  stats24h: { high: number | null; low: number | null; volume: number; turnover: number; changePercent: number | null };
};

const UNLOCK_KEY = "pearl-wallet-require-unlock-v1";
const APP_VERSION = "0.2.10";
const API_URL = import.meta.env.VITE_SAFETRADE_API_URL || "https://pearlwallet.az1993.xyz/api/safetrade";
const READ_TOKEN = import.meta.env.VITE_SAFETRADE_READ_TOKEN || "";
type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
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

function CandleChart({ candles }: { candles: ExchangeData["candles"] }) {
  const data = candles.slice(-120);
  const real = data.filter((item) => Number.isFinite(item.high) && Number.isFinite(item.low));
  if (!real.length) return <div className="chart-empty">暂无成交数据</div>;
  const high = Math.max(...real.map((item) => item.high));
  const low = Math.min(...real.map((item) => item.low));
  const span = Math.max(high - low, high * 0.003);
  const y = (value: number) => 240 - ((value - low) / span) * 210;
  const maxVolume = Math.max(1, ...data.map((item) => item.volume));
  const width = 640 / data.length;
  function movingAverage(index: number, period: number) {
    if (index < period - 1) return null;
    const values = data.slice(index - period + 1, index + 1).map((item) => item.close);
    return values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / period : null;
  }
  const maPath = (period: number) => data.map((_, index) => {
    const value = movingAverage(index, period);
    return value === null ? "" : `${index === period - 1 ? "M" : "L"}${(index + .5) * width},${y(value)}`;
  }).join(" ");
  return <div className="chart-shell">
    <div className="ma-legend"><span>MA(7)</span><span>MA(25)</span><span>MA(99)</span></div>
    <svg viewBox="0 0 640 355" preserveAspectRatio="none" role="img" aria-label="PRL USDT K 线">
      {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="0" x2="640" y1={30 + line * 52} y2={30 + line * 52} className="chart-grid" />)}
      <line x1="0" x2="640" y1="270" y2="270" className="chart-grid" />
      {data.map((item, index) => {
        const x = index * width + width / 2;
        const up = item.close >= item.open;
        return <g key={item.time} className={item.empty ? "candle empty" : up ? "candle up" : "candle down"}>
          <line x1={x} x2={x} y1={y(item.high)} y2={y(item.low)} />
          <rect x={x - Math.max(2, width * 0.28)} y={Math.min(y(item.open), y(item.close))} width={Math.max(4, width * 0.56)} height={Math.max(2, Math.abs(y(item.open) - y(item.close)))} rx="0.5" />
          <rect className="volume-bar" x={x - width * .26} y={350 - item.volume / maxVolume * 72} width={width * .52} height={item.volume / maxVolume * 72} />
        </g>;
      })}
      <path d={maPath(7)} className="ma-line ma7" /><path d={maPath(25)} className="ma-line ma25" /><path d={maPath(99)} className="ma-line ma99" />
    </svg>
    <div className="chart-axis"><span>{new Date(data[0]!.time * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span>{new Date(data.at(-1)!.time * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
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
  const [exchange, setExchange] = useState<ExchangeData | null>(null);
  const [exchangeError, setExchangeError] = useState("");
  const [interval, setIntervalValue] = useState<Interval>("1m");
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
  const [sendAmount, setSendAmount] = useState("");
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewScanSequence, setPreviewScanSequence] = useState<number | null>(null);
  const [authPassword, setAuthPassword] = useState("");
  const [biometricStatus, setBiometricStatus] = useState({ available: false, enabled: false });
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
  const fingerprintEnabled = !!blob && biometricStatus.enabled && biometricAddress === blob.address;

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

  const refreshExchange = useCallback(async () => {
    try {
      const url = `${API_URL}?interval=${interval}`;
      let data: ExchangeData;
      if (Capacitor.isNativePlatform()) {
        const response = await CapacitorHttp.get({ url, headers: READ_TOKEN ? { Authorization: `Bearer ${READ_TOKEN}` } : {}, connectTimeout: 8000, readTimeout: 8000 });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        data = response.data as ExchangeData;
      } else {
        const response = await fetch(url, { cache: "no-store", headers: READ_TOKEN ? { Authorization: `Bearer ${READ_TOKEN}` } : {}, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json() as ExchangeData;
      }
      setExchange(data);
      setExchangeError("");
    } catch { setExchangeError("行情服务暂不可用"); }
  }, [interval]);

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

  useEffect(() => {
    if (tab !== "safetrade") return;
    refreshExchange();
    const timer = setInterval(refreshExchange, 10_000);
    return () => clearInterval(timer);
  }, [tab, refreshExchange]);

  useEffect(() => { biometric.status().then(setBiometricStatus).catch(() => {}); }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let removed = false;
    const listener = NativeApp.addListener("backButton", () => {
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
  }, [tab, walletPage, profileMenuOpen, addingProfile, preview]);

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
    biometric.authenticate().then(async ({ mnemonic }) => {
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
      const result = await biometric.authenticate();
      if (generation !== walletAccessGeneration.current) return;
      const unlocked = await wallet.unlockBiometric(blob, result.mnemonic);
      if (generation === walletAccessGeneration.current) setAddresses(unlocked.addresses);
    });
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice("地址已复制"); }
    catch { setError("无法复制，请长按地址手动复制"); }
  }

  function makePreview(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (!addresses || !snapshot) throw new Error("链上余额尚未同步");
      if (!snapshotFresh || snapshotError) throw new Error("请先重新同步链上余额");
      if (snapshot.partial) throw new Error("链上交易记录不完整，暂不能安全转账");
      if (!isValidPearlAddress(sendAddress.trim())) throw new Error("Pearl 收款地址无效");
      setPreview(prepareSend(projected?.availableUtxos ?? snapshot.utxos, sendAddress.trim(), parsePrl(sendAmount.trim()), addresses[0]!));
      setPreviewScanSequence(walletScanSequence.current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法创建交易预览"); }
  }

  async function confirmSend(useFinger: boolean) {
    if (!blob || !preview || !addresses) return;
    await run(async () => {
      if (!snapshotFresh || snapshotError || snapshot?.partial || previewScanSequence !== walletScanSequence.current) throw new Error("链上余额已变化，请重新预览转账");
      if (useFinger && !fingerprintEnabled) throw new Error("当前钱包尚未启用指纹");
      const auth = useFinger ? { biometricMnemonic: (await biometric.authenticate()).mnemonic } : { password: authPassword };
      const signed = await wallet.sign(blob, preview, auth);
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
    await run(async () => {
      if (fingerprintEnabled) {
        await biometric.disable();
        localStorage.removeItem(BIOMETRIC_ADDRESS_KEY); setBiometricAddress(null);
        setBiometricStatus({ ...biometricStatus, enabled: false });
        setNotice("已关闭指纹授权");
      } else {
        if (!fingerPassword) throw new Error("请输入钱包密码");
        const { mnemonic } = await wallet.export(blob, fingerPassword);
        await biometric.enable(mnemonic);
        localStorage.setItem(BIOMETRIC_ADDRESS_KEY, blob.address); setBiometricAddress(blob.address);
        setFingerPassword(""); setBiometricStatus({ ...biometricStatus, enabled: true });
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

  return <div className="app">
    <main className="content">
      {tab === "wallet" && (!activeProfile || addingProfile) && <section className="onboarding">
        {addingProfile && <button className="back" aria-label="取消添加钱包" onClick={() => { setAddingProfile(false); setWalletName(""); setPassword(""); setInputMnemonic(""); setAddresses(activeProfile?.kind === "watch" ? [activeProfile.address] : !requireUnlock && activeProfile?.kind === "wallet" && activeProfile.addresses.length ? activeProfile.addresses : null); setAutoFingerAttempted(false); }}><Icon name="back" /></button>}
        <img className="brand-logo" src="/pearl-logo.svg" alt="Pearl" /><h1>Pearl Wallet</h1>
        <div className="segmented"><button className={setupMode === "create" ? "active" : ""} onClick={() => setSetupMode("create")}>创建钱包</button><button className={setupMode === "restore" ? "active" : ""} onClick={() => setSetupMode("restore")}>导入钱包</button><button className={setupMode === "watch" ? "active" : ""} onClick={() => setSetupMode("watch")}>观察地址</button></div>
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
        {walletPage === "send" && !preview && <form className="form-card" onSubmit={makePreview}><p className="muted">可用余额：{snapshotFresh && projected ? formatPrl(projected.availableUtxos.reduce((sum, utxo) => sum + utxo.valueGrains, 0n)) : "—"} PRL</p><Field label="收款地址" value={sendAddress} onChange={setSendAddress} placeholder="prl1…" autoComplete="off" /><Field label="金额（PRL）" value={sendAmount} onChange={setSendAmount} placeholder="0.00000000" /><button className="primary" disabled={!snapshotFresh || !snapshot || !!snapshotError || busy}>预览转账</button></form>}
        {walletPage === "send" && preview && <div className="form-card"><p className="eyebrow">CONFIRM TRANSACTION</p><h2>请核对转账信息</h2><div className="preview-row"><span>收款地址</span><strong className="break">{preview.destination}</strong></div><div className="preview-row"><span>转账金额</span><strong>{formatPrl(BigInt(preview.amountGrains))} PRL</strong></div><div className="preview-row"><span>预计矿工费</span><strong>{formatPrl(BigInt(preview.feeGrains))} PRL</strong></div><div className="preview-row"><span>找零</span><strong>{formatPrl(BigInt(preview.changeGrains))} PRL</strong></div><Field label="钱包密码" value={authPassword} onChange={setAuthPassword} type="password" autoComplete="current-password" /><button className="primary" disabled={busy || !authPassword} onClick={() => confirmSend(false)}>{busy ? "正在发送…" : "确认并发送"}</button>{fingerprintEnabled && <button className="secondary wide" disabled={busy} onClick={() => confirmSend(true)}><Icon name="finger" size={18} /> 使用指纹确认</button>}<button className="text-button" onClick={() => { setPreview(null); setAuthPassword(""); }}>返回修改</button></div>}
        {walletPage === "history" && <div className="history-list">{!visibleActivities.length && <div className="empty-card">暂无链上交易</div>}{visibleActivities.map((item) => <div className="activity" key={item.txid}><span className="activity-icon"><Icon name={item.deltaGrains >= 0n ? "receive" : "send"} size={18} /></span><div><strong>{item.deltaGrains >= 0n ? "Received" : "Sent"}</strong><small>{projected?.staleTxids.has(item.txid.toLowerCase()) ? "待核对" : item.confirmations === 0 ? "待确认" : item.time ? new Date(item.time * 1000).toLocaleString("zh-CN") : "时间未知"}<br />{item.txid.slice(0, 16)}…</small></div><em className={item.deltaGrains >= 0n ? "positive" : "negative"}>{item.deltaGrains >= 0n ? "+" : ""}{formatPrl(item.deltaGrains)} PRL</em></div>)}</div>}
      </section>}

      {tab === "safetrade" && <section className="trade-page"><div className="pair-head"><h1>PRL/USDT</h1><span>SafeTrade</span></div>
        <div className="market-summary"><div className="market-last"><strong>{exchange?.price ? exchange.price.toFixed(6) : "—"}</strong><span>USDT <em className={(exchange?.stats24h?.changePercent ?? 0) >= 0 ? "positive" : "negative"}>{exchange?.stats24h?.changePercent == null ? "" : `${exchange.stats24h.changePercent >= 0 ? "+" : ""}${exchange.stats24h.changePercent.toFixed(2)}%`}</em></span></div><div className="market-stats"><div><span>24h 最高</span><strong>{exchange?.stats24h?.high?.toFixed(6) ?? "—"}</strong></div><div><span>24h 最低</span><strong>{exchange?.stats24h?.low?.toFixed(6) ?? "—"}</strong></div><div><span>24h 成交量</span><strong>{exchange?.stats24h?.volume?.toFixed(2) ?? "—"}</strong></div></div></div>
        <div className="intervals">{INTERVALS.map((option) => <button key={option.id} className={interval === option.id ? "active" : ""} onClick={() => setIntervalValue(option.id)}>{option.label}</button>)}</div>
        <div className="chart-card"><CandleChart candles={exchange?.candles ?? []} /></div>
        {exchangeError && <div className="inline-error">{exchangeError}<button onClick={refreshExchange}>重试</button></div>}
        {exchange?.marketError && <div className="inline-error">{exchange.marketError}</div>}
        <div className="section-heading"><h2>账户余额</h2><span className="muted">SafeTrade</span></div>
        <div className="exchange-balances">{(["PRL", "USDT"] as const).map((asset) => <div className="asset-card" key={asset}><span className="asset-symbol">{asset === "PRL" ? "◉" : "$"}</span><div><strong>{asset}</strong><small>可用 {exchange?.balances[asset]?.available ?? "—"}</small></div><em>冻结 {exchange?.balances[asset]?.locked ?? "—"}</em></div>)}</div>
        {exchange?.accountError && <div className="inline-error">{exchange.accountError}</div>}
      </section>}

      {tab === "setting" && <section className="settings-page"><div className="page-title"><h1>Setting</h1></div>
        {blob && <>
          <div className="settings-card"><div className="settings-title"><Icon name="lock" /><div><strong>进入钱包时解锁</strong></div></div><button className="secondary wide" onClick={toggleUnlock}>{requireUnlock ? "已开启 · 点击关闭" : "已关闭 · 点击开启"}</button></div>
          <div className="settings-card"><div className="settings-title"><Icon name="lock" /><div><strong>修改钱包密码</strong></div></div><form onSubmit={changePassword}><Field label="当前密码" value={oldPassword} onChange={setOldPassword} type="password" autoComplete="current-password" /><Field label="新密码" value={newPassword} onChange={setNewPassword} type="password" autoComplete="new-password" /><button className="secondary wide" disabled={busy || !oldPassword || !newPassword}>修改密码</button></form></div>
          <div className="settings-card"><div className="settings-title"><Icon name="finger" /><div><strong>指纹授权</strong></div></div>{!fingerprintEnabled && <Field label="钱包密码" value={fingerPassword} onChange={setFingerPassword} type="password" autoComplete="current-password" />}<button className="secondary wide" disabled={!biometricStatus.available || busy || (!fingerprintEnabled && !fingerPassword)} onClick={toggleBiometric}>{fingerprintEnabled ? "关闭指纹" : "启用指纹"}</button></div>
          <div className="settings-card"><div className="settings-title"><Icon name="shield" /><div><strong>助记词备份</strong></div></div><Field label="钱包密码" value={backupPassword} onChange={setBackupPassword} type="password" autoComplete="current-password" /><button className="secondary wide" disabled={busy || !backupPassword} onClick={exportMnemonic}>查看助记词</button>{showMnemonic && <div className="secret-phrase">{showMnemonic}</div>}</div>
          {addresses && !watchMode && <button className="lock-button" onClick={lockWallet}><Icon name="lock" size={19} /> 立即锁定钱包</button>}
        </>}
        <div className="settings-card"><div className="settings-title"><Icon name="refresh" /><div><strong>版本 {APP_VERSION}</strong></div></div><button className="secondary wide" onClick={checkUpdate}>检查更新</button>{updateStatus && <p className="update-status">{updateStatus}</p>}</div>
      </section>}
    </main>
    {(error || notice) && <div className={error ? "toast error" : "toast"} role="status">{error || notice}<button onClick={() => { setError(""); setNotice(""); }}>×</button></div>}
    <nav className="bottom-nav" aria-label="主导航"><button className={tab === "wallet" ? "selected" : ""} onClick={() => { setTab("wallet"); setError(""); }}><Icon name="wallet" size={22} /><span>Wallet</span></button><button className={tab === "safetrade" ? "selected" : ""} onClick={() => { setTab("safetrade"); setError(""); }}><Icon name="chart" size={22} /><span>SafeTrade</span></button><button className={tab === "setting" ? "selected" : ""} onClick={() => { setTab("setting"); setError(""); }}><Icon name="setting" size={22} /><span>Setting</span></button></nav>
  </div>;
}
