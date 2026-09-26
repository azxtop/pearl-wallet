import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { isValidPearlAddress } from "./pearl";
import { scriptForAddress } from "./send";
import type { Activity, WalletSnapshot, WalletUtxo } from "./rpc";

const BASE = "https://pearlchain.live/api/explorer";

async function request<T>(path: string, body?: object): Promise<T> {
  const url = BASE + path;
  if (Capacitor.isNativePlatform()) {
    const response = body
      ? await CapacitorHttp.post({ url, data: body, headers: { "Content-Type": "application/json" }, connectTimeout: 12_000, readTimeout: 12_000 })
      : await CapacitorHttp.get({ url, connectTimeout: 12_000, readTimeout: 12_000 });
    if (response.status !== 200) throw new Error(`Pearlchain HTTP ${response.status}`);
    return (typeof response.data === "string" ? JSON.parse(response.data) : response.data) as T;
  }
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Pearlchain HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function grains(value: unknown): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error("浏览器返回的金额无效");
}

type ScanResult = {
  address: string;
  used: boolean;
  balance: string | number;
  utxos: { txid: string; vout: number; value: string | number; blockHeight?: number }[];
};
export type ExplorerProbe = { pool: string; fingerprint: string; results: ScanResult[] };

export async function probeWalletExplorer(addresses: string[]): Promise<ExplorerProbe> {
  if (!addresses.length || addresses.length > 20 || addresses.some((address) => !isValidPearlAddress(address))) throw new Error("钱包地址池无效");
  const scan = await request<{ results: ScanResult[] }>("/scan", { addresses });
  if (!Array.isArray(scan.results) || scan.results.length !== addresses.length) throw new Error("浏览器地址扫描不完整");
  const byAddress = new Map(scan.results.map((item) => [item.address, item]));
  const fingerprint = JSON.stringify(addresses.map((address) => {
    const entry = byAddress.get(address);
    if (!entry || !Array.isArray(entry.utxos)) throw new Error("浏览器地址扫描异常");
    return [address, grains(entry.balance).toString(), entry.used, entry.utxos.map((utxo) => {
      if (!/^[a-fA-F0-9]{64}$/.test(utxo.txid) || !Number.isInteger(utxo.vout) || utxo.vout < 0) throw new Error("浏览器 UTXO 无效");
      return [utxo.txid, utxo.vout, grains(utxo.value).toString(), utxo.blockHeight ?? null];
    }).sort((a, b) => String(a).localeCompare(String(b)))];
  }));
  return { pool: addresses.join("|"), fingerprint, results: scan.results };
}
type AddressHistory = {
  txTotal: number;
  transactions: { txid: string; net: string | number; time: number | null; confirmed: boolean }[];
};
type TransactionDetail = {
  txid: string;
  confirmations?: number | null;
  blockTime?: number | null;
  vin: { address?: string; value?: string | number }[];
  vout: { address?: string; value: string | number }[];
};

export async function scanWalletExplorer(addresses: string[], probe?: ExplorerProbe): Promise<WalletSnapshot> {
  const current = probe ?? await probeWalletExplorer(addresses);
  if (current.pool !== addresses.join("|")) throw new Error("浏览器地址池不匹配");
  const byAddress = new Map(current.results.map((item) => [item.address, item]));
  const utxos: WalletUtxo[] = [];
  const pendingTxids = new Set<string>();
  let balanceGrains = 0n;
  let pendingGrains = 0n;
  let partial = false;
  for (let index = 0; index < addresses.length; index++) {
    const address = addresses[index]!;
    const entry = byAddress.get(address);
    if (!entry || !Array.isArray(entry.utxos)) throw new Error("浏览器地址扫描异常");
    const scriptHex = scriptForAddress(address);
    let addressBalance = 0n;
    for (const raw of entry.utxos) {
      if (!/^[a-fA-F0-9]{64}$/.test(raw.txid) || !Number.isInteger(raw.vout) || raw.vout < 0) throw new Error("浏览器 UTXO 无效");
      const valueGrains = grains(raw.value);
      if (valueGrains <= 0n) throw new Error("浏览器 UTXO 金额无效");
      addressBalance += valueGrains;
      if (raw.blockHeight === 0) {
        pendingGrains += valueGrains;
        pendingTxids.add(raw.txid);
      } else {
        utxos.push({ txid: raw.txid, vout: raw.vout, valueGrains, scriptHex, poolIndex: index });
      }
    }
    balanceGrains += addressBalance;
    if (addressBalance !== grains(entry.balance)) partial = true;
  }
  const deltas = new Map<string, Activity>();
  // Some indexers report an address as unused while its UTXO view has already
  // caught up. Fetch its history too so a visible balance has matching activity.
  const used = current.results.filter((entry) => entry.used || entry.utxos.length > 0 || grains(entry.balance) !== 0n).map((entry) => entry.address);
  for (let start = 0; start < used.length; start += 4) {
    await Promise.all(used.slice(start, start + 4).map(async (address) => {
      for (let page = 0; page < 20; page++) {
        const history = await request<AddressHistory>(`/address/${encodeURIComponent(address)}?page=${page}`);
        if (!Array.isArray(history.transactions) || !Number.isSafeInteger(history.txTotal) || history.txTotal < 0) throw new Error("浏览器交易历史无效");
        for (const item of history.transactions) {
          if (!/^[a-fA-F0-9]{64}$/.test(item.txid)) throw new Error("浏览器交易 ID 无效");
          const previous = deltas.get(item.txid);
          const time = typeof item.time === "number" && Number.isFinite(item.time) ? item.time : 0;
          deltas.set(item.txid, {
            txid: item.txid,
            deltaGrains: (previous?.deltaGrains ?? 0n) + grains(item.net),
            time: Math.max(previous?.time ?? 0, time),
            confirmations: item.confirmed ? 1 : 0,
          });
        }
        if ((page + 1) * 50 >= history.txTotal || history.transactions.length === 0) break;
        if (page === 19) partial = true;
      }
    }));
  }
  const owned = new Set(addresses);
  for (const txid of pendingTxids) {
    if (deltas.has(txid)) continue;
    try {
      const tx = await request<TransactionDetail>(`/tx/${txid}`);
      if (tx.txid !== txid || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw new Error("待确认交易详情无效");
      const received = tx.vout.reduce((sum, output) => sum + (output.address && owned.has(output.address) ? grains(output.value) : 0n), 0n);
      const sent = tx.vin.reduce((sum, input) => sum + (input.address && owned.has(input.address) ? grains(input.value) : 0n), 0n);
      const net = received - sent;
      if (net !== 0n) deltas.set(txid, { txid, deltaGrains: net, time: tx.blockTime ?? 0, confirmations: tx.confirmations ?? 0 });
    } catch {
      partial = true;
    }
  }
  const activities = Array.from(deltas.values()).filter((item) => item.deltaGrains !== 0n)
    .sort((a, b) => Number(b.confirmations === 0) - Number(a.confirmations === 0) || b.time - a.time);
  return { balanceGrains, pendingGrains, utxos, activities, partial, updatedAt: Date.now() };
}

export async function broadcastViaExplorer(rawHex: string): Promise<string> {
  if (!/^[0-9a-f]+$/i.test(rawHex)) throw new Error("签名交易格式无效");
  const response = await request<{ txid?: string; error?: string }>("/broadcast", { hex: rawHex });
  if (response.error) throw new Error(response.error);
  if (!response.txid || !/^[0-9a-fA-F]{64}$/.test(response.txid)) throw new Error("广播结果无效");
  return response.txid;
}
