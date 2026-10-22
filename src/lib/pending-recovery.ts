import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { grains, probeWalletExplorer } from "./explorer";
import type { PendingOutgoing } from "./pending-outgoing";
import type { WalletSnapshot, WalletUtxo } from "./rpc";

const BLOCKBOOK = "https://blockbook.pearlresearch.ai/api/v2";
const PEARLCHAIN = "https://pearlchain.live/api/explorer";

type HttpResult = { status: number; data: unknown };
type TxState = "confirmed" | "pending" | "absent";
export type PendingAudit = { state: "confirmed" | "pending" | "recoverable" | "unavailable"; coins?: WalletUtxo[] };

async function get(url: string): Promise<HttpResult> {
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, connectTimeout: 12_000, readTimeout: 12_000 });
    return { status: response.status, data: typeof response.data === "string" ? JSON.parse(response.data) : response.data };
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  return { status: response.status, data: await response.json() };
}

export function parsePendingTxState(source: "pearlchain" | "pearlresearch", txid: string, result: HttpResult): TxState {
  const body = result.data as Record<string, unknown> | null;
  if (result.status === 200 && typeof body?.txid === "string" && body.txid.toLowerCase() === txid.toLowerCase() && typeof body.confirmations === "number"
    && Number.isInteger(body.confirmations) && body.confirmations >= 0) {
    return body.confirmations > 0 ? "confirmed" : "pending";
  }
  const error = typeof body?.error === "string" ? body.error : "";
  if (source === "pearlchain" && result.status === 500 && error.toLowerCase() === `RPC error -5: No information available about transaction ${txid}`.toLowerCase()) return "absent";
  if (source === "pearlresearch" && result.status === 400 && error.toLowerCase() === `Transaction '${txid}' not found`.toLowerCase()) return "absent";
  throw new Error(`${source === "pearlchain" ? "Pearlchain" : "PearlResearch"} 交易查询失败 (HTTP ${result.status})`);
}

function coinKey(txid: string, vout: number): string { return `${txid.toLowerCase()}:${vout}`; }

export async function auditPendingOutgoing(record: PendingOutgoing, addresses: string[], snapshot: WalletSnapshot): Promise<PendingAudit> {
  if (record.pool !== addresses.join("|") || snapshot.partial || !record.inputs.length) throw new Error("请先同步完整的钱包数据");
  const txid = record.txid.toLowerCase();
  const [pearlchain, pearlresearch] = await Promise.all([
    get(`${PEARLCHAIN}/tx/${txid}`), get(`${BLOCKBOOK}/tx/${txid}`),
  ]);
  const states = [parsePendingTxState("pearlchain", txid, pearlchain), parsePendingTxState("pearlresearch", txid, pearlresearch)];
  if (states.includes("confirmed")) return { state: "confirmed" };
  if (states.includes("pending")) return { state: "pending" };

  // A missing tx is not proof that it cannot later confirm. Recovery only
  // spends one or more of its original inputs, so the two transactions conflict.
  const liveCoins = new Map(snapshot.utxos.map((coin) => [coinKey(coin.txid, coin.vout), coin]));
  const originalCoins = record.inputs.map((input) => liveCoins.get(coinKey(input.txid, input.vout)));
  if (originalCoins.some((coin, index) => !coin || coin.valueGrains !== record.inputs[index]!.valueGrains)) return { state: "unavailable" };
  const inputAddresses = [...new Set(originalCoins.map((coin) => addresses[coin!.poolIndex]))];
  if (inputAddresses.some((address) => !address)) return { state: "unavailable" };
  const primary = await probeWalletExplorer(inputAddresses as string[]);
  const backup: HttpResult[] = [];
  for (let start = 0; start < inputAddresses.length; start += 4) {
    backup.push(...await Promise.all(inputAddresses.slice(start, start + 4).map((address) => get(`${BLOCKBOOK}/utxo/${encodeURIComponent(address!)}`))));
  }
  const primaryCoins = new Map(primary.results.flatMap((entry) => entry.utxos.map((coin) =>
    [coinKey(coin.txid, coin.vout), grains(coin.value)] as const)));
  const backupCoins = new Map<string, bigint>();
  for (const response of backup) {
    if (response.status !== 200 || !Array.isArray(response.data)) throw new Error("PearlResearch UTXO 查询失败");
    for (const raw of response.data) {
      const coin = raw as { txid?: unknown; vout?: unknown; value?: unknown; height?: unknown; confirmations?: unknown };
      if (typeof coin.txid !== "string" || !/^[a-f0-9]{64}$/i.test(coin.txid) || !Number.isInteger(coin.vout) || (coin.vout as number) < 0) throw new Error("PearlResearch UTXO 数据无效");
      backupCoins.set(coinKey(coin.txid, coin.vout as number), grains(coin.value));
    }
  }
  const recoverable = record.inputs.map((input) => {
    const key = coinKey(input.txid, input.vout);
    const coin = liveCoins.get(key);
    if (!coin || coin.valueGrains !== input.valueGrains || primaryCoins.get(key) !== input.valueGrains || backupCoins.get(key) !== input.valueGrains) return null;
    return coin;
  });
  return recoverable.every((coin): coin is WalletUtxo => coin !== null)
    ? { state: "recoverable", coins: recoverable as WalletUtxo[] }
    : { state: "unavailable" };
}
