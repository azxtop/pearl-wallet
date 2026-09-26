import { describe, expect, it, vi } from "vitest";
import { scriptForAddress } from "../lib/send";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const password = "a-long-test-password";

describe("wallet worker authorization and signing", () => {
  it("requires the current wallet and password before signing a Taproot input", async () => {
    let lastMessage: { id: number; result?: any; error?: string } | null = null;
    const fakeSelf = { postMessage: (message: typeof lastMessage) => { lastMessage = message; }, onmessage: null as null | ((event: any) => Promise<void>) };
    vi.stubGlobal("self", fakeSelf);
    await import("./wallet-worker");
    let id = 0;
    async function request(cmd: string, payload: Record<string, unknown>) {
      lastMessage = null;
      await fakeSelf.onmessage!({ data: { id: ++id, cmd, payload } });
      const message = lastMessage as { id: number; result?: any; error?: string } | null;
      expect(message?.id).toBe(id);
      return message!;
    }

    const restored = await request("restore", { mnemonic, password });
    expect(restored.error).toBeUndefined();
    const { blob, addresses } = restored.result;
    const preview = {
      destination: addresses[1], amountGrains: "10000000", feeGrains: "200", changeGrains: "89999800",
      inputs: [{ txid: "11".repeat(32), vout: 0, valueGrains: "100000000", scriptHex: scriptForAddress(addresses[0]), poolIndex: 0 }],
      outputs: [{ address: addresses[1], amountGrains: "10000000" }, { address: addresses[0], amountGrains: "89999800" }],
    };
    expect((await request("sign", { blob, preview, password: "wrong-password" })).error).toBeTruthy();
    const signed = await request("sign", { blob, preview, password });
    expect(signed.error).toBeUndefined();
    expect(signed.result.rawHex).toMatch(/^[0-9a-f]{200,}$/);
    expect((await request("unlockBiometric", { blob: { ...blob, address: addresses[1] }, mnemonic })).error).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
