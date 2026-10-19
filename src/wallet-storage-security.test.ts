import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMatchingLegacyWallet, loadProfiles, PROFILES_KEY, saveProfiles, type ProfileStore } from "./lib/profiles";
import { encryptMnemonic, decryptMnemonic, type EncryptedWallet } from "./lib/keystore";

const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const address = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const oldPassword = "old-public-test-password", newPassword = "new-public-test-password";

const source = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerText = "";
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "changePassword") handlerText = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function fixture(writeFails = false) {
  const original = await encryptMnemonic(phrase, oldPassword, address);
  const values = new Map<string, string>([["pearl-wallet-v1", JSON.stringify(original)], ["pearl-wallet-public-addresses-v1", JSON.stringify([address])]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let profileStore = loadProfiles(storage);
  const activeProfile = profileStore.profiles[0];
  const duplicate = { ...activeProfile, id: "duplicate", name: "Same seed" };
  profileStore = { ...profileStore, profiles: [...profileStore.profiles, duplicate] };
  saveProfiles(profileStore, storage);
  const replies = new Map<number, any>();
  const worker: any = { postMessage: (reply: any) => replies.set(reply.id, reply) };
  vi.stubGlobal("self", worker); await import("./crypto/wallet-worker");
  const cleanup = vi.fn((blob: EncryptedWallet) => { clearMatchingLegacyWallet(blob, storage); return true; });
  const scope: Record<string, any> = {
    blob: original, oldPassword, newPassword, profileStore, activeProfile, walletAccessGeneration: { current: 0 },
    accessCurrent: () => true, run: async (action: () => Promise<void>) => action(),
    wallet: { changePassword: async (blob: unknown, oldPassword: string, newPassword: string) => {
      await worker.onmessage({ data: { id: 1, cmd: "changePassword", payload: { blob, oldPassword, newPassword } } });
      if (replies.get(1).error) throw new Error(replies.get(1).error);
      return replies.get(1).result;
    } },
    persistProfiles: (next: ProfileStore) => {
      saveProfiles(next, writeFails ? { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } } : storage);
      profileStore = next;
    },
    cleanupLegacyAfterAuthorization: cleanup, setOldPassword: vi.fn(), setNewPassword: vi.fn(), setNotice: vi.fn(),
  };
  const code = ts.transpile(`const handler = ${handlerText};`, { target: ts.ScriptTarget.ES2022 });
  const handler = new Function(...Object.keys(scope), `${code}; return handler;`)(...Object.values(scope));
  return { storage, scope, cleanup, change: () => handler({ preventDefault: vi.fn() }) };
}

describe("actual password-change flow and durable ciphertext cleanup", () => {
  it("updates every duplicate of the same wallet and removes the old legacy ciphertext after persistence", async () => {
    const app = await fixture();
    await app.change();
    expect(app.cleanup).toHaveBeenCalledOnce();
    expect(app.storage.getItem("pearl-wallet-v1")).toBeNull();
    const saved = JSON.parse(app.storage.getItem(PROFILES_KEY)!);
    expect(saved.profiles).toHaveLength(2);
    for (const profile of saved.profiles) {
      expect(await decryptMnemonic(profile.blob, newPassword)).toBe(phrase);
      await expect(decryptMnemonic(profile.blob, oldPassword)).rejects.toThrow();
    }
  });

  it("preserves the old wallet and does not clean up anything if writing the new password fails", async () => {
    const app = await fixture(true);
    await expect(app.change()).rejects.toThrow("QuotaExceededError");
    expect(app.cleanup).not.toHaveBeenCalled();
    expect(await decryptMnemonic(JSON.parse(app.storage.getItem("pearl-wallet-v1")!), oldPassword)).toBe(phrase);
    for (const profile of JSON.parse(app.storage.getItem(PROFILES_KEY)!).profiles) {
      expect(await decryptMnemonic(profile.blob, oldPassword)).toBe(phrase);
    }
    expect(app.scope.setNotice).not.toHaveBeenCalled();
  });
});
