import { afterEach, describe, expect, it, vi } from "vitest";
import { HDKey } from "@scure/bip32";
import { scriptForAddress } from "../lib/send";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const password = "a-long-test-password";

async function workerFixture() {
  const messages = new Map<number, any>();
  const host = { postMessage: (message: any) => messages.set(message.id, message), onmessage: null as null | ((event: any) => Promise<void>) };
  vi.stubGlobal("self", host);
  await import("./wallet-worker");
  let nextId = 0;
  return async (cmd: string, payload: Record<string, unknown> = {}) => {
    const id = ++nextId;
    await host.onmessage!({ data: { id, cmd, payload } });
    expect(messages.get(id)?.id).toBe(id);
    return messages.get(id)!;
  };
}

function trackPrivateKeys() {
  const keys: HDKey[] = [];
  const fromMasterSeed = HDKey.fromMasterSeed;
  const deriveChild = HDKey.prototype.deriveChild;
  vi.spyOn(HDKey, "fromMasterSeed").mockImplementation(function (...args) {
    const key = fromMasterSeed.apply(HDKey, args); keys.push(key); return key;
  });
  vi.spyOn(HDKey.prototype, "deriveChild").mockImplementation(function (this: HDKey, index) {
    const key = deriveChild.call(this, index); keys.push(key); return key;
  });
  return () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.privateKey).toBeNull();
      expect((key as any).privKey).toBeUndefined();
      expect(() => key.sign(new Uint8Array(32))).toThrow("No privateKey");
    }
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("wallet worker authorization and signing", () => {
  it("destroys every private scalar after successful and rejected operations, retaining no unlocked signing session", async () => {
    const assertDestroyed = trackPrivateKeys();
    const request = await workerFixture();

    const restored = await request("restore", { mnemonic, password });
    expect(restored.error).toBeUndefined(); assertDestroyed();
    const { blob, addresses } = restored.result;
    expect((await request("verifyPassword", { blob, password: "wrong-password" })).error).toBeTruthy();
    expect((await request("verifyPassword", { blob, password })).result).toEqual({ ok: true }); assertDestroyed();
    expect((await request("unlock", { blob, password })).result.addresses).toEqual(addresses); assertDestroyed();
    expect((await request("export", { blob, password })).result.mnemonic).toBe(mnemonic); assertDestroyed();
    const preview = {
      destination: addresses[1], amountGrains: "10000000", feeGrains: "200", changeGrains: "89999800",
      inputs: [{ txid: "11".repeat(32), vout: 0, valueGrains: "100000000", scriptHex: scriptForAddress(addresses[0]), poolIndex: 0 }],
      outputs: [{ address: addresses[1], amountGrains: "10000000" }, { address: addresses[0], amountGrains: "89999800" }],
    };
    expect((await request("sign", { blob, preview, password: "wrong-password" })).error).toBeTruthy();
    expect((await request("sign", { blob, preview })).error).toBeTruthy();
    const signed = await request("sign", { blob, preview, password });
    expect(signed.error).toBeUndefined();
    expect(signed.result.rawHex).toMatch(/^[0-9a-f]{200,}$/); assertDestroyed();
    expect((await request("sign", { blob, preview: { ...preview, feeGrains: "999" }, password })).error).toBeTruthy(); assertDestroyed();
    expect((await request("unlockBiometric", { blob, mnemonic })).result.addresses).toEqual(addresses); assertDestroyed();
    expect((await request("unlockBiometric", { blob: { ...blob, address: addresses[1] }, mnemonic })).error).toBeTruthy(); assertDestroyed();
    const changed = await request("changePassword", { blob, oldPassword: password, newPassword: "a-new-test-password" });
    expect(changed.error).toBeUndefined(); assertDestroyed();
    expect((await request("unlock", { blob: changed.result.blob, password: "a-new-test-password" })).error).toBeUndefined(); assertDestroyed();
  }, 15_000);

  it("rejects operations already deriving when a lock arrives and destroys their keys", async () => {
    const assertDestroyed = trackPrivateKeys();
    const request = await workerFixture();
    const pending = request("restore", { mnemonic, password });
    expect((await request("lock")).result).toEqual({ ok: true });
    expect((await pending).error).toContain("钱包已锁定");
    assertDestroyed();
  });

  it("destroys partially derived keys when a derivation fails partway through the address pool", async () => {
    const assertDestroyed = trackPrivateKeys();
    const trackedDerive = vi.mocked(HDKey.prototype.deriveChild).getMockImplementation()!;
    vi.spyOn(HDKey.prototype, "deriveChild").mockImplementation(function (this: HDKey, index) {
      if (this.depth === 4 && index === 3) throw new Error("injected derivation failure");
      return trackedDerive.call(this, index);
    });
    const request = await workerFixture();
    expect((await request("restore", { mnemonic, password })).error).toBe("injected derivation failure");
    assertDestroyed();
  });
});
