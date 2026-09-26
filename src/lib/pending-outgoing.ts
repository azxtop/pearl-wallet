import type { SendPreview } from "./send";
import type { Activity, WalletSnapshot, WalletUtxo } from "./rpc";

const KEY = "pearl-wallet-pending-outgoing-v1";
const ACTIVE_MS = 48 * 60 * 60 * 1000;
const TXID = /^[a-f0-9]{64}$/i;

type Coin = { txid: string; vout: number; valueGrains: bigint };
type OwnedOutput = { vout: number; valueGrains: bigint };

export type PendingOutgoing = {
  profileId: string;
  pool: string;
  txid: string;
  createdAt: number;
  inputs: Coin[];
  ownedOutputs: OwnedOutput[];
};

export function pendingFromBroadcast(profileId: string, addresses: string[], txid: string, preview: SendPreview, now = Date.now()): PendingOutgoing {
  if (!TXID.test(txid)) throw new Error("广播交易 ID 无效");
  const owned = new Set(addresses);
  return {
    profileId,
    pool: addresses.join("|"),
    txid,
    createdAt: now,
    inputs: preview.inputs.map((input) => ({ txid: input.txid, vout: input.vout, valueGrains: BigInt(input.valueGrains) })),
    ownedOutputs: preview.outputs.flatMap((output, vout) => owned.has(output.address) ? [{ vout, valueGrains: BigInt(output.amountGrains) }] : []),
  };
}

function parseCoin(value: unknown): Coin {
  const coin = value as Record<string, unknown>;
  if (!coin || typeof coin.txid !== "string" || !TXID.test(coin.txid) || !Number.isInteger(coin.vout)
    || (coin.vout as number) < 0 || typeof coin.valueGrains !== "string" || !/^\d+$/.test(coin.valueGrains)) throw new Error("待确认输入无效");
  return { txid: coin.txid, vout: coin.vout as number, valueGrains: BigInt(coin.valueGrains) };
}

function parseOutput(value: unknown): OwnedOutput {
  const output = value as Record<string, unknown>;
  if (!output || !Number.isInteger(output.vout) || (output.vout as number) < 0
    || typeof output.valueGrains !== "string" || !/^\d+$/.test(output.valueGrains)) throw new Error("待确认输出无效");
  return { vout: output.vout as number, valueGrains: BigInt(output.valueGrains) };
}

export function loadPendingOutgoing(storage: Pick<Storage, "getItem"> = localStorage): PendingOutgoing[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values)) return [];
    return values.slice(0, 100).flatMap((value): PendingOutgoing[] => {
      try {
        const record = value as Record<string, unknown>;
        if (!record || typeof record.profileId !== "string" || typeof record.pool !== "string"
          || typeof record.txid !== "string" || !TXID.test(record.txid)
          || typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)
          || !Array.isArray(record.inputs) || !Array.isArray(record.ownedOutputs)) throw new Error("待确认记录无效");
        return [{ profileId: record.profileId, pool: record.pool, txid: record.txid, createdAt: record.createdAt,
          inputs: record.inputs.map(parseCoin), ownedOutputs: record.ownedOutputs.map(parseOutput) }];
      } catch { return []; }
    });
  } catch { return []; }
}

export function savePendingOutgoing(records: PendingOutgoing[], storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(KEY, JSON.stringify(records.slice(-100).map((record) => ({
    ...record,
    inputs: record.inputs.map((input) => ({ ...input, valueGrains: input.valueGrains.toString() })),
    ownedOutputs: record.ownedOutputs.map((output) => ({ ...output, valueGrains: output.valueGrains.toString() })),
  }))));
}

export function reconcilePendingOutgoing(records: PendingOutgoing[], profileId: string, pool: string, snapshot: WalletSnapshot): PendingOutgoing[] {
  const confirmed = new Set(snapshot.activities.filter((item) => item.confirmations > 0).map((item) => item.txid.toLowerCase()));
  const knownOutputs = new Set([...snapshot.utxos, ...(snapshot.pendingOutputs ?? [])]
    .map((coin) => `${coin.txid.toLowerCase()}:${coin.vout}`));
  return records.filter((item) => item.profileId !== profileId || item.pool !== pool
    || !confirmed.has(item.txid.toLowerCase())
    || item.ownedOutputs.some((output) => !knownOutputs.has(`${item.txid.toLowerCase()}:${output.vout}`)));
}

export function projectWalletSnapshot(snapshot: WalletSnapshot, records: PendingOutgoing[], now = Date.now()): {
  balanceGrains: bigint;
  pendingGrains: bigint;
  availableUtxos: WalletUtxo[];
  activities: Activity[];
  estimated: boolean;
  staleTxids: Set<string>;
} {
  const visible = new Map(snapshot.activities.map((item) => [item.txid.toLowerCase(), item]));
  const knownCoins = new Set([...snapshot.utxos, ...(snapshot.pendingOutputs ?? [])].map((coin) => `${coin.txid.toLowerCase()}:${coin.vout}`));
  const spent = new Set<string>();
  const staleTxids = new Set<string>();
  let balanceGrains = snapshot.balanceGrains;
  let pendingGrains = snapshot.pendingGrains ?? 0n;
  let estimated = false;
  for (const record of records) {
    if (visible.get(record.txid.toLowerCase())?.confirmations
      && record.ownedOutputs.every((output) => knownCoins.has(`${record.txid.toLowerCase()}:${output.vout}`))) continue;
    const deltaGrains = record.ownedOutputs.reduce((sum, output) => sum + output.valueGrains, 0n)
      - record.inputs.reduce((sum, input) => sum + input.valueGrains, 0n);
    if (!visible.has(record.txid.toLowerCase())) visible.set(record.txid.toLowerCase(), {
      txid: record.txid, deltaGrains, time: Math.floor(record.createdAt / 1000), confirmations: 0,
    });
    // A broadcast that never confirms (dropped from the mempool, never relayed) must not
    // lock its inputs forever: once the record goes stale, its inputs become spendable again.
    if (now - record.createdAt > ACTIVE_MS) { staleTxids.add(record.txid.toLowerCase()); continue; }
    for (const input of record.inputs) {
      const key = `${input.txid.toLowerCase()}:${input.vout}`;
      spent.add(key);
    }
    estimated = true;
    for (const input of record.inputs) {
      const key = `${input.txid.toLowerCase()}:${input.vout}`;
      if (knownCoins.has(key)) balanceGrains -= input.valueGrains;
    }
    for (const output of record.ownedOutputs) {
      const key = `${record.txid.toLowerCase()}:${output.vout}`;
      if (!knownCoins.has(key)) { balanceGrains += output.valueGrains; pendingGrains += output.valueGrains; }
    }
  }
  const availableUtxos = snapshot.utxos.filter((utxo) => !spent.has(`${utxo.txid.toLowerCase()}:${utxo.vout}`));
  const activities = Array.from(visible.values()).filter((item) => item.deltaGrains !== 0n)
    .sort((a, b) => Number(b.confirmations === 0) - Number(a.confirmations === 0) || b.time - a.time);
  return { balanceGrains, pendingGrains, availableUtxos, activities, estimated, staleTxids };
}
