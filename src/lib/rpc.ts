import { RPC_URL, GRAINS_PER_PRL, isValidPearlAddress } from "./pearl";
import { bech32m } from "@scure/base";
import { Capacitor, CapacitorHttp } from "@capacitor/core";

interface RawTx {
  txid: string;
  vin: { txid?: string; vout?: number }[];
  vout: { n: number; value: number; scriptPubKey: { hex?: string; address?: string; addresses?: string[] } }[];
  time?: number;
  confirmations?: number;
}

export interface WalletUtxo {
  txid: string;
  vout: number;
  valueGrains: bigint;
  scriptHex: string;
  poolIndex: number;
}

export interface Activity {
  txid: string;
  deltaGrains: bigint;
  time: number;
  confirmations: number;
}

export interface WalletSnapshot {
  balanceGrains: bigint;
  pendingGrains?: bigint;
  utxos: WalletUtxo[];
  activities: Activity[];
  partial: boolean;
  updatedAt: number;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const body = { jsonrpc: "2.0", method, params, id: 1 };
  if (Capacitor.isNativePlatform()) {
    let response;
    try {
      response = await CapacitorHttp.post({
        url: RPC_URL,
        headers: { "Content-Type": "application/json" },
        data: body,
        connectTimeout: 12_000,
        readTimeout: 12_000,
      });
    } catch (error) {
      throw new Error(`Pearl 节点连接失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Pearl 节点 HTTP ${response.status}`);
    const data = response.data as { result: T | null; error: { message: string } | null };
    if (data?.error) throw new Error(data.error.message);
    if (data?.result === null || data?.result === undefined) throw new Error("Pearl 节点返回空数据");
    return data.result;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Pearl 节点 HTTP ${response.status}`);
    const data = await response.json() as { result: T | null; error: { message: string } | null };
    if (data.error) throw new Error(data.error.message);
    if (data.result === null) throw new Error("Pearl 节点返回空数据");
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function expectedScript(address: string): string {
  if (!isValidPearlAddress(address)) throw new Error("Pearl 地址无效");
  const decoded = bech32m.decode(address as `${string}1${string}`, 90);
  const key = bech32m.fromWords(decoded.words.slice(1));
  return "5120" + Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toGrains(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("节点返回的金额无效");
  const grains = BigInt(Math.round(value * Number(GRAINS_PER_PRL)));
  if (grains < 0n || grains > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("节点返回的金额超出范围");
  return grains;
}

async function fetchAddressTransactions(address: string): Promise<{ transactions: RawTx[]; partial: boolean }> {
  const transactions: RawTx[] = [];
  const pageSize = 100;
  for (let page = 0; page < 20; page++) {
    let batch: RawTx[];
    try {
      batch = await rpc<RawTx[]>("searchrawtransactions", [address, 1, page * pageSize, pageSize]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("No information available about address")) {
        return { transactions, partial: false };
      }
      throw error;
    }
    if (!Array.isArray(batch) || batch.length > pageSize) throw new Error("Pearl 节点返回异常交易列表");
    transactions.push(...batch);
    if (batch.length < pageSize) return { transactions, partial: false };
  }
  return { transactions, partial: true };
}

export async function scanWallet(addresses: string[]): Promise<WalletSnapshot> {
  if (!addresses.length || addresses.length > 20 || addresses.some((address) => !isValidPearlAddress(address))) {
    throw new Error("钱包地址池无效");
  }
  const fetched: { transactions: RawTx[]; partial: boolean }[] = [];
  for (let start = 0; start < addresses.length; start += 4) {
    fetched.push(...await Promise.all(addresses.slice(start, start + 4).map(fetchAddressTransactions)));
  }
  const partial = fetched.some((result) => result.partial);
  const transactionMap = new Map<string, RawTx>();
  for (const result of fetched) for (const tx of result.transactions) transactionMap.set(tx.txid, tx);

  const scripts = new Map(addresses.map((address, index) => [expectedScript(address), index]));
  const ownedOutputs = new Map<string, WalletUtxo>();
  const spent = new Set<string>();
  const deltas = new Map<string, bigint>();
  for (const tx of transactionMap.values()) {
    if (!/^[0-9a-fA-F]{64}$/.test(tx.txid) || !Array.isArray(tx.vout) || !Array.isArray(tx.vin)) continue;
    for (const output of tx.vout) {
      const scriptHex = output.scriptPubKey?.hex?.toLowerCase() ?? "";
      const poolIndex = scripts.get(scriptHex);
      if (poolIndex === undefined || !Number.isInteger(output.n) || output.n < 0) continue;
      const valueGrains = toGrains(output.value);
      ownedOutputs.set(`${tx.txid}:${output.n}`, { txid: tx.txid, vout: output.n, valueGrains, scriptHex, poolIndex });
      deltas.set(tx.txid, (deltas.get(tx.txid) ?? 0n) + valueGrains);
    }
  }
  for (const tx of transactionMap.values()) {
    for (const input of tx.vin) {
      if (!input.txid || input.vout === undefined) continue;
      const key = `${input.txid}:${input.vout}`;
      spent.add(key);
      const owned = ownedOutputs.get(key);
      if (owned) deltas.set(tx.txid, (deltas.get(tx.txid) ?? 0n) - owned.valueGrains);
    }
  }
  const utxos = Array.from(ownedOutputs, ([key, value]) => ({ key, value }))
    .filter(({ key }) => !spent.has(key)).map(({ value }) => value);
  const balanceGrains = utxos.reduce((sum, utxo) => sum + utxo.valueGrains, 0n);
  const activities = Array.from(transactionMap.values())
    .map((tx): Activity => ({
      txid: tx.txid,
      deltaGrains: deltas.get(tx.txid) ?? 0n,
      time: tx.time ?? 0,
      confirmations: tx.confirmations ?? 0,
    }))
    .filter((activity) => activity.deltaGrains !== 0n)
    .sort((a, b) => b.time - a.time);
  return { balanceGrains, utxos, activities, partial, updatedAt: Date.now() };
}

export async function broadcastPearlTx(rawHex: string): Promise<string> {
  if (!/^[0-9a-f]+$/i.test(rawHex)) throw new Error("签名交易格式无效");
  return rpc<string>("sendrawtransaction", [rawHex]);
}
