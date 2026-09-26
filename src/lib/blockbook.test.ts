import { afterEach, describe, expect, it, vi } from "vitest";
import { scanWalletBlockbook } from "./blockbook";

const addresses = [
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
];
const txid = "a".repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe("PearlResearch fallback", () => {
  it("deduplicates one transaction across wallet addresses and excludes pending UTXOs from spending", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const second = url.includes(addresses[1]!);
      const tx = { txid, confirmations: 0, blockTime: 123,
        vin: [{ addresses: [addresses[0]], value: "40" }],
        vout: [{ addresses: [addresses[0]], value: "10" }, { addresses: [addresses[1]], value: "100" }] };
      const body = url.includes("/utxo/")
        ? [{ txid, vout: second ? 1 : 0, value: second ? "100" : "10", height: second ? 0 : 100 }]
        : { address: second ? addresses[1] : addresses[0], balance: second ? "0" : "10", unconfirmedBalance: second ? "100" : "0", totalPages: 1, transactions: [tx] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const result = await scanWalletBlockbook(addresses);
    expect(result.balanceGrains).toBe(110n);
    expect(result.pendingGrains).toBe(100n);
    expect(result.utxos).toHaveLength(1);
    expect(result.activities).toMatchObject([{ txid, deltaGrains: 70n, confirmations: 0 }]);
    expect(result.partial).toBe(false);
  });

  it("marks a balance mismatch as partial so transfers are disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/utxo/")
      ? [] : { address: addresses[0], balance: "100", unconfirmedBalance: "0", totalPages: 1, transactions: [] }), { status: 200 })));
    const result = await scanWalletBlockbook([addresses[0]!]);
    expect(result.partial).toBe(true);
  });
});
