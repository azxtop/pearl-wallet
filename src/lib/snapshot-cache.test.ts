import { describe, expect, it } from "vitest";
import { loadSnapshotCache, saveSnapshotCache } from "./snapshot-cache";

describe("wallet snapshot cache", () => {
  it("restores bigint balances and activity separately for each profile", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const txid = "a".repeat(64);
    saveSnapshotCache({ first: { pool: "address-1", data: {
      balanceGrains: 123456789012345678n,
      pendingGrains: 100n,
      pendingOutputs: [{ txid, vout: 1, valueGrains: 100n }],
      utxos: [],
      activities: [{ txid, deltaGrains: 100n, time: 1, confirmations: 0 }],
      partial: false,
      updatedAt: 123,
    } } }, storage);
    const loaded = loadSnapshotCache(storage);
    expect(loaded.first?.data.balanceGrains).toBe(123456789012345678n);
    expect(loaded.first?.data.activities[0]?.deltaGrains).toBe(100n);
    expect(loaded.first?.data.pendingOutputs?.[0]?.valueGrains).toBe(100n);
    expect(loaded.second).toBeUndefined();
  });

  it("ignores a damaged entry without losing valid entries", () => {
    const storage = { getItem: () => JSON.stringify({ version: 1, entries: { broken: { pool: "x", data: {} }, okay: { pool: "y", data: {
      balanceGrains: "1", pendingGrains: "0", utxos: [], activities: [], partial: false, updatedAt: 1,
    } } } }) };
    expect(Object.keys(loadSnapshotCache(storage))).toEqual(["okay"]);
  });
});
