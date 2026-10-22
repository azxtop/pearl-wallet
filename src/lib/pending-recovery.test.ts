import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPendingOutgoing, parsePendingTxState } from "./pending-recovery";
import type { PendingOutgoing } from "./pending-outgoing";
import type { WalletSnapshot } from "./rpc";

const txid = "b".repeat(64);
const inputTxid = "a".repeat(64);
const address = "prl1pm2u7jht5vqqw32k5e2m87dpwhavwwrjnd6d7tjtpsv3l8qzzgdds8d449j";
const record: PendingOutgoing = { profileId: "wallet", pool: address, txid, createdAt: 1,
  inputs: [{ txid: inputTxid, vout: 1, valueGrains: 1000n }], ownedOutputs: [] };
const coin = { txid: inputTxid, vout: 1, valueGrains: 1000n, scriptHex: "5120", poolIndex: 0 };
const snapshot: WalletSnapshot = { balanceGrains: 1000n, utxos: [coin], activities: [], partial: false, updatedAt: 1 };
const response = (status: number, data: unknown) => ({ ok: status === 200, status, json: async () => data });

afterEach(() => vi.unstubAllGlobals());

describe("pending transaction recovery", () => {
  it("recognizes only the known not-found responses", () => {
    expect(parsePendingTxState("pearlchain", txid, { status: 500, data: { error: `RPC error -5: No information available about transaction ${txid}` } })).toBe("absent");
    expect(parsePendingTxState("pearlresearch", txid, { status: 400, data: { error: `Transaction '${txid}' not found` } })).toBe("absent");
    expect(() => parsePendingTxState("pearlchain", txid, { status: 500, data: { error: "database unavailable" } })).toThrow();
    expect(parsePendingTxState("pearlresearch", txid, { status: 200, data: { txid, confirmations: 1 } })).toBe("confirmed");
  });

  it("requires both explorers and the current snapshot to show original inputs as unspent", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/tx/")) return url.includes("pearlchain")
        ? response(500, { error: `RPC error -5: No information available about transaction ${txid}` })
        : response(400, { error: `Transaction '${txid}' not found` });
      if (url.endsWith("/scan")) return response(200, { results: [{ address, used: true, balance: "1000", utxos: [{ txid: inputTxid, vout: 1, value: "1000" }] }] });
      if (url.includes("/utxo/")) return response(200, [{ txid: inputTxid, vout: 1, value: "1000" }]);
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await auditPendingOutgoing(record, [address], snapshot)).toEqual({ state: "recoverable", coins: [coin] });
    expect(await auditPendingOutgoing(record, [address], { ...snapshot, utxos: [] })).toEqual({ state: "unavailable" });
  });

  it("does not offer recovery while either explorer sees the old transaction", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("pearlchain")
      ? response(500, { error: `RPC error -5: No information available about transaction ${txid}` })
      : response(200, { txid, confirmations: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await auditPendingOutgoing(record, [address], snapshot)).toEqual({ state: "pending" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
