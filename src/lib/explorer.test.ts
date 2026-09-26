import { afterEach, describe, expect, it, vi } from "vitest";
import { grains, probeWalletExplorer, scanWalletExplorer } from "./explorer";

const addresses = [
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
];
const txid = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe("Pearlchain fallback", () => {
  it("detects a changed UTXO even when the balance stays the same", async () => {
    let currentTxid = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{
      address: addresses[0], used: true, balance: "100", utxos: [{ txid: currentTxid, vout: 0, value: "100", blockHeight: 1 }],
    }] }), { status: 200 })));
    const before = await probeWalletExplorer([addresses[0]!]);
    currentTxid = "b".repeat(64);
    const after = await probeWalletExplorer([addresses[0]!]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("combines UTXOs and a transaction affecting two owned addresses", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.endsWith("/scan")
        ? { results: addresses.map((address, index) => ({ address, used: true, balance: index ? "30" : "70", utxos: [{ txid, vout: index, value: index ? "30" : "70" }] })) }
        : { txTotal: 1, transactions: [{ txid, net: url.includes(addresses[0]!) ? "70" : "30", time: 100, confirmed: true }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const snapshot = await scanWalletExplorer(addresses);
    expect(snapshot.balanceGrains).toBe(100n);
    expect(snapshot.utxos.map((item) => item.poolIndex)).toEqual([0, 1]);
    expect(snapshot.activities).toHaveLength(1);
    expect(snapshot.activities[0]!.deltaGrains).toBe(100n);
    expect(snapshot.partial).toBe(false);
  });

  it("rejects imprecise numeric amounts", () => {
    expect(() => grains(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("loads history when a funded address is incorrectly marked unused", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const body = url.endsWith("/scan")
        ? { results: addresses.map((address, index) => ({ address, used: false, balance: index ? "0" : "1000000", utxos: index ? [] : [{ txid, vout: 0, value: "1000000" }] })) }
        : { txTotal: 1, transactions: [{ txid, net: "1000000", time: 100, confirmed: true }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const snapshot = await scanWalletExplorer(addresses);
    expect(calls.some((url) => url.includes(`/address/${addresses[0]}`))).toBe(true);
    expect(snapshot.activities[0]?.deltaGrains).toBe(1000000n);
  });

  it("shows a pending incoming transaction without treating its UTXO as spendable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.endsWith("/scan")
        ? { results: [{ address: addresses[0], used: true, balance: "1000000", utxos: [{ txid, vout: 0, value: "1000000", blockHeight: 0 }] }] }
        : url.includes("/address/")
          ? { txTotal: 0, transactions: [] }
          : { txid, confirmations: null, blockTime: null, vin: [{ address: "outside", value: "1000000" }], vout: [{ address: addresses[0], value: "1000000" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const snapshot = await scanWalletExplorer([addresses[0]!]);
    expect(snapshot.balanceGrains).toBe(1000000n);
    expect(snapshot.pendingGrains).toBe(1000000n);
    expect(snapshot.utxos).toHaveLength(0);
    expect(snapshot.activities).toMatchObject([{ txid, deltaGrains: 1000000n, confirmations: 0 }]);
    expect(snapshot.partial).toBe(false);
  });
});
