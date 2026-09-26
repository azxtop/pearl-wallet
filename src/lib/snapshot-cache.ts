import type { WalletSnapshot } from "./rpc";

const KEY = "pearl-wallet-snapshots-v1";

export type CachedSnapshot = { pool: string; data: WalletSnapshot };
export type SnapshotCache = Record<string, CachedSnapshot>;

function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("Invalid cached amount");
  return BigInt(value);
}

function decodeEntry(raw: unknown): CachedSnapshot {
  if (!raw || typeof raw !== "object") throw new Error("Invalid cached entry");
  const entry = raw as { pool?: unknown; data?: Record<string, unknown> };
  const data = entry.data;
  if (typeof entry.pool !== "string" || !data || !Array.isArray(data.utxos) || !Array.isArray(data.activities)
    || typeof data.partial !== "boolean" || typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)) {
    throw new Error("Invalid cached snapshot");
  }
  const utxos = data.utxos.map((item: unknown) => {
    const utxo = item as Record<string, unknown>;
    if (!utxo || typeof utxo.txid !== "string" || !/^[\da-f]{64}$/i.test(utxo.txid)
      || !Number.isInteger(utxo.vout) || !Number.isInteger(utxo.poolIndex)
      || typeof utxo.scriptHex !== "string" || !/^[\da-f]+$/i.test(utxo.scriptHex)) throw new Error("Invalid cached UTXO");
    return { txid: utxo.txid, vout: utxo.vout as number, valueGrains: amount(utxo.valueGrains), scriptHex: utxo.scriptHex, poolIndex: utxo.poolIndex as number };
  });
  const activities = data.activities.map((item: unknown) => {
    const activity = item as Record<string, unknown>;
    if (!activity || typeof activity.txid !== "string" || !/^[\da-f]{64}$/i.test(activity.txid)
      || typeof activity.time !== "number" || !Number.isFinite(activity.time)
      || typeof activity.confirmations !== "number" || !Number.isFinite(activity.confirmations)) throw new Error("Invalid cached activity");
    return { txid: activity.txid, deltaGrains: amount(activity.deltaGrains), time: activity.time, confirmations: activity.confirmations };
  });
  return { pool: entry.pool, data: { balanceGrains: amount(data.balanceGrains), pendingGrains: amount(data.pendingGrains ?? "0"), utxos, activities, partial: data.partial, updatedAt: data.updatedAt } };
}

export function loadSnapshotCache(storage: Pick<Storage, "getItem"> = localStorage): SnapshotCache {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { version?: number; entries?: Record<string, unknown> };
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return {};
    const result: SnapshotCache = {};
    for (const [id, entry] of Object.entries(parsed.entries)) {
      try { result[id] = decodeEntry(entry); } catch { /* Ignore damaged entries only. */ }
    }
    return result;
  } catch { return {}; }
}

export function saveSnapshotCache(cache: SnapshotCache, storage: Pick<Storage, "setItem"> = localStorage): void {
  const entries = Object.fromEntries(Object.entries(cache).map(([id, entry]) => [id, {
    pool: entry.pool,
    data: {
      ...entry.data,
      balanceGrains: entry.data.balanceGrains.toString(),
      pendingGrains: (entry.data.pendingGrains ?? 0n).toString(),
      utxos: entry.data.utxos.map((item) => ({ ...item, valueGrains: item.valueGrains.toString() })),
      activities: entry.data.activities.slice(0, 500).map((item) => ({ ...item, deltaGrains: item.deltaGrains.toString() })),
    },
  }]));
  storage.setItem(KEY, JSON.stringify({ version: 1, entries }));
}
