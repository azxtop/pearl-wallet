import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { grains } from "./explorer";
import { isValidPearlAddress } from "./pearl";
import { scriptForAddress } from "./send";
import type { Activity, WalletSnapshot, WalletUtxo } from "./rpc";

const BASE = "https://blockbook.pearlresearch.ai/api/v2";

type BlockbookTx = {
  txid: string;
  blockTime?: number;
  confirmations?: number;
  vin: { addresses?: string[]; value?: string }[];
  vout: { addresses?: string[]; value: string }[];
};
type AddressPage = {
  address: string;
  balance: string;
  unconfirmedBalance: string;
  totalPages: number;
  transactions: BlockbookTx[];
};
type RawUtxo = { txid: string; vout: number; value: string; height?: number; confirmations?: number };
type BasicAddress = { address: string; balance: string; unconfirmedBalance?: string; txs: number; unconfirmedTxs: number };

async function request<T>(path: string): Promise<T> {
  const url = BASE + path;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, connectTimeout: 12_000, readTimeout: 12_000 });
    if (response.status !== 200) throw new Error(`PearlResearch HTTP ${response.status}`);
    return (typeof response.data === "string" ? JSON.parse(response.data) : response.data) as T;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`PearlResearch HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function probeWalletBlockbook(addresses: string[]): Promise<{ fingerprint: string }> {
  if (!addresses.length || addresses.length > 20 || addresses.some((address) => !isValidPearlAddress(address))) throw new Error("钱包地址池无效");
  const entries: BasicAddress[] = [];
  for (let start = 0; start < addresses.length; start += 4) {
    const batch = await Promise.all(addresses.slice(start, start + 4).map((address) =>
      request<BasicAddress>(`/address/${encodeURIComponent(address)}?details=basic`)));
    entries.push(...batch);
  }
  return { fingerprint: JSON.stringify(entries.map((entry, index) => {
    if (entry.address !== addresses[index] || !Number.isInteger(entry.txs) || !Number.isInteger(entry.unconfirmedTxs)) {
      throw new Error("PearlResearch 余额数据无效");
    }
    return [entry.address, grains(entry.balance).toString(), grains(entry.unconfirmedBalance ?? "0").toString(), entry.txs, entry.unconfirmedTxs];
  })) };
}

export async function scanWalletBlockbook(addresses: string[]): Promise<WalletSnapshot> {
  if (!addresses.length || addresses.length > 20 || addresses.some((address) => !isValidPearlAddress(address))) throw new Error("钱包地址池无效");
  const owned = new Set(addresses);
  const utxos: WalletUtxo[] = [];
  const txs = new Map<string, BlockbookTx>();
  let balanceGrains = 0n;
  let pendingGrains = 0n;
  let partial = false;

  for (let start = 0; start < addresses.length; start += 4) {
    await Promise.all(addresses.slice(start, start + 4).map(async (address, offset) => {
      const index = start + offset;
      const rawUtxos = await request<RawUtxo[]>(`/utxo/${encodeURIComponent(address)}`);
      if (!Array.isArray(rawUtxos)) throw new Error("PearlResearch UTXO 数据无效");
      let addressTotal = 0n;
      for (const raw of rawUtxos) {
        if (!/^[\da-f]{64}$/i.test(raw.txid) || !Number.isInteger(raw.vout) || raw.vout < 0) throw new Error("PearlResearch UTXO 数据无效");
        const valueGrains = grains(raw.value);
        if (valueGrains <= 0n) throw new Error("PearlResearch UTXO 金额无效");
        addressTotal += valueGrains;
        if (raw.height === 0 || raw.confirmations === 0) pendingGrains += valueGrains;
        else utxos.push({ txid: raw.txid, vout: raw.vout, valueGrains, scriptHex: scriptForAddress(address), poolIndex: index });
      }
      balanceGrains += addressTotal;
      for (let page = 1; page <= 20; page++) {
        const result = await request<AddressPage>(`/address/${encodeURIComponent(address)}?details=txs&page=${page}&pageSize=50`);
        if (result.address !== address || !Array.isArray(result.transactions) || !Number.isInteger(result.totalPages) || result.totalPages < 0) {
          throw new Error("PearlResearch 交易记录无效");
        }
        if (page === 1 && addressTotal !== grains(result.balance) + grains(result.unconfirmedBalance)) partial = true;
        for (const tx of result.transactions) {
          if (!/^[\da-f]{64}$/i.test(tx.txid) || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw new Error("PearlResearch 交易数据无效");
          txs.set(tx.txid, tx);
        }
        if (page >= result.totalPages) break;
        if (page === 20) partial = true;
      }
    }));
  }

  const activities: Activity[] = [];
  for (const tx of txs.values()) {
    const received = tx.vout.reduce((sum, output) => sum + (output.addresses?.some((address) => owned.has(address)) ? grains(output.value) : 0n), 0n);
    const sent = tx.vin.reduce((sum, input) => sum + (input.addresses?.some((address) => owned.has(address)) ? grains(input.value) : 0n), 0n);
    const deltaGrains = received - sent;
    if (deltaGrains !== 0n) activities.push({
      txid: tx.txid,
      deltaGrains,
      time: Number.isFinite(tx.blockTime) ? tx.blockTime! : 0,
      confirmations: Number.isInteger(tx.confirmations) ? tx.confirmations! : 0,
    });
  }
  activities.sort((a, b) => Number(b.confirmations === 0) - Number(a.confirmations === 0) || b.time - a.time);
  return { balanceGrains, pendingGrains, utxos, activities, partial, updatedAt: Date.now() };
}
