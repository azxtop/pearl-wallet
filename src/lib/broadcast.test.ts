import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastPearlTx } from "./rpc";
import { broadcastViaExplorer } from "./explorer";
import { verifiedBroadcastId } from "./send";

const txid = "ab".repeat(32);
afterEach(() => vi.unstubAllGlobals());

describe("broadcast acknowledgements", () => {
  it.each(["cd".repeat(32), "short", null, 42, {}, [txid]])("rejects a forged or malformed acknowledgement: %j", (reply) => {
    expect(() => verifiedBroadcastId(reply, txid)).toThrow("广播结果与本机签名交易不一致");
  });
  it("compares transaction IDs without trusting casing", () => {
    expect(verifiedBroadcastId(txid.toUpperCase(), txid)).toBe(txid);
  });
  it("checks the node response against the locally signed transaction", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: "cd".repeat(32), error: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(broadcastPearlTx("00", txid)).rejects.toThrow("广播结果与本机签名交易不一致");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ result: txid, error: null }), { status: 200 }));
    await expect(broadcastPearlTx("00", txid)).resolves.toBe(txid);
  });
  it("checks the fallback explorer response too", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ txid: "cd".repeat(32) }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(broadcastViaExplorer("00", txid)).rejects.toThrow("广播结果与本机签名交易不一致");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ txid }), { status: 200 }));
    await expect(broadcastViaExplorer("00", txid)).resolves.toBe(txid);
  });
});
