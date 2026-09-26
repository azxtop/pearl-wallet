import { describe, expect, it } from "vitest";
import { loadPendingOutgoing, pendingFromBroadcast, projectWalletSnapshot, reconcilePendingOutgoing, savePendingOutgoing } from "./pending-outgoing";
import type { WalletSnapshot } from "./rpc";
import type { SendPreview } from "./send";

const inputTxid = "a".repeat(64);
const sentTxid = "b".repeat(64);
const own = "own-address";
const other = "recipient-address";
const preview: SendPreview = {
  destination: other, amountGrains: "100", feeGrains: "10", changeGrains: "890",
  inputs: [{ txid: inputTxid, vout: 0, valueGrains: "1000", scriptHex: "5120", poolIndex: 0 }],
  outputs: [{ address: other, amountGrains: "100" }, { address: own, amountGrains: "890" }],
};
const coin = { txid: inputTxid, vout: 0, valueGrains: 1000n, scriptHex: "5120", poolIndex: 0 };
const base: WalletSnapshot = { balanceGrains: 1000n, pendingGrains: 0n, utxos: [coin], activities: [], partial: false, updatedAt: 1 };
const now = 1_000_000;
const pending = pendingFromBroadcast("wallet-1", [own], sentTxid, preview, now);

describe("locally broadcast transactions", () => {
  it("shows an outgoing activity and estimated change before an indexer notices the transaction", () => {
    const view = projectWalletSnapshot(base, [pending], now);
    expect(view.balanceGrains).toBe(890n);
    expect(view.pendingGrains).toBe(890n);
    expect(view.availableUtxos).toEqual([]);
    expect(view.activities).toMatchObject([{ txid: sentTxid, deltaGrains: -110n, confirmations: 0 }]);
  });

  it("keeps change visible when the spent input disappears before pending output appears", () => {
    const snapshot = { ...base, balanceGrains: 0n, utxos: [] };
    expect(projectWalletSnapshot(snapshot, [pending], now).balanceGrains).toBe(890n);
  });

  it("does not count a pending output twice once the explorer reports it", () => {
    const snapshot = { ...base, balanceGrains: 890n, pendingGrains: 890n, utxos: [],
      pendingOutputs: [{ txid: sentTxid, vout: 1, valueGrains: 890n }] };
    const view = projectWalletSnapshot(snapshot, [pending], now);
    expect(view.balanceGrains).toBe(890n);
    expect(view.pendingGrains).toBe(890n);
  });

  it("hands a confirmed transfer back to the explorer without duplicate activity", () => {
    const snapshot = { ...base, balanceGrains: 890n, utxos: [{ ...coin, txid: sentTxid, vout: 1, valueGrains: 890n }], activities: [{ txid: sentTxid, deltaGrains: -110n, time: 3, confirmations: 1 }] };
    expect(reconcilePendingOutgoing([pending], "wallet-1", own, snapshot)).toEqual([]);
    expect(projectWalletSnapshot(snapshot, [pending], now).activities).toHaveLength(1);
    expect(projectWalletSnapshot(snapshot, [pending], now).estimated).toBe(false);
  });

  it("keeps estimated change until a confirmed activity also has its output indexed", () => {
    const snapshot = { ...base, balanceGrains: 0n, utxos: [], activities: [{ txid: sentTxid, deltaGrains: -110n, time: 3, confirmations: 1 }] };
    expect(reconcilePendingOutgoing([pending], "wallet-1", own, snapshot)).toEqual([pending]);
    const view = projectWalletSnapshot(snapshot, [pending], now);
    expect(view.balanceGrains).toBe(890n);
    expect(view.activities).toHaveLength(1);
    expect(view.activities[0]?.confirmations).toBe(1);
  });

  it("handles a transfer to another owned address as a fee-only balance change", () => {
    const self = pendingFromBroadcast("wallet-1", [own], sentTxid, { ...preview, outputs: [
      { address: own, amountGrains: "100" }, { address: own, amountGrains: "890" },
    ] }, now);
    const view = projectWalletSnapshot(base, [self], now);
    expect(view.balanceGrains).toBe(990n);
    expect(view.activities[0]?.deltaGrains).toBe(-10n);
  });

  it("shows a full balance transfer as pending activity while spendable balance is zero", () => {
    const full = pendingFromBroadcast("wallet-1", [own], sentTxid, {
      ...preview, amountGrains: "990", changeGrains: "0",
      outputs: [{ address: other, amountGrains: "990" }],
    }, now);
    const view = projectWalletSnapshot({ ...base, balanceGrains: 0n, utxos: [] }, [full], now);
    expect(view.balanceGrains).toBe(0n);
    expect(view.availableUtxos).toEqual([]);
    expect(view.activities).toMatchObject([{ txid: sentTxid, deltaGrains: -1000n, confirmations: 0 }]);
  });

  it("restores public pending metadata after an app restart", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    savePendingOutgoing([pending], storage);
    expect(loadPendingOutgoing(storage)).toEqual([pending]);
  });

  it("releases the inputs of an unresolved transfer after 48 hours so they can be spent again", () => {
    const view = projectWalletSnapshot(base, [pending], now + 49 * 60 * 60 * 1000);
    expect(view.balanceGrains).toBe(1000n);
    expect(view.estimated).toBe(false);
    expect(view.availableUtxos).toEqual([coin]);
    expect(view.staleTxids.has(sentTxid)).toBe(true);
    expect(view.activities).toMatchObject([{ txid: sentTxid, deltaGrains: -110n, confirmations: 0 }]);
  });

  it("still locks the inputs of a fresh unconfirmed transfer", () => {
    const view = projectWalletSnapshot(base, [pending], now + 60 * 60 * 1000);
    expect(view.availableUtxos).toEqual([]);
    expect(view.estimated).toBe(true);
  });
});
