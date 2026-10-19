import { describe, expect, it } from "vitest";
import { BIOMETRIC_ADDRESS_KEY, clearLegacyWalletData, clearMatchingLegacyWallet, initialProfiles, loadProfiles, profileName, profileRecoveryData, ProfileStorageError, PROFILES_KEY, saveProfiles } from "./profiles";
import type { EncryptedWallet } from "./keystore";

const address = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const watch = "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm";
const blob: EncryptedWallet = { version: 2, address, salt: "salt", iv: "iv", ciphertext: "ciphertext" };

function storage(values: Record<string, string> = {}) {
  const items = new Map(Object.entries(values));
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
}

describe("wallet profile migration", () => {
  it("preserves the encrypted legacy wallet and active watched address", () => {
    const items = storage({ "pearl-wallet-v1": JSON.stringify(blob), "pearl-wallet-public-addresses-v1": JSON.stringify([address]), "pearl-wallet-watch-address-v1": watch });
    const result = loadProfiles(items);
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0]).toMatchObject({ kind: "wallet", blob, addresses: [address] });
    expect(result.activeId).toBe(result.profiles[1]?.id);
    expect(items.getItem(PROFILES_KEY)).not.toBeNull();
    expect(items.getItem(BIOMETRIC_ADDRESS_KEY)).toBe(address);
  });

  it("keeps an existing profile store and checks duplicate names", () => {
    const items = storage({ [PROFILES_KEY]: JSON.stringify({ version: 2, activeId: "one", profiles: [{ id: "one", name: "Main", kind: "watch", address }] }) });
    const result = loadProfiles(items);
    expect(result.profiles[0]?.name).toBe("Main");
    expect(() => profileName(" Main ", result.profiles)).toThrow("已存在");
  });

  it("does not restore a deleted wallet from legacy storage on restart", () => {
    const items = storage({ "pearl-wallet-v1": JSON.stringify(blob), "pearl-wallet-public-addresses-v1": JSON.stringify([address]) });
    const migrated = loadProfiles(items);
    expect(migrated.profiles).toHaveLength(1);
    saveProfiles({ version: 2, activeId: null, profiles: [] }, items);
    clearLegacyWalletData(items);
    expect(items.getItem("pearl-wallet-v1")).toBeNull();
    expect(loadProfiles(items).profiles).toEqual([]);
  });

  it.each(["", "{truncated", "null", JSON.stringify({ version: 3, profiles: [] }), JSON.stringify({ version: 2, activeId: "one", profiles: [
    { id: "one", name: "Main", kind: "wallet", blob, addresses: [address] }, { name: "Damaged" },
  ] }), JSON.stringify({ version: 2, activeId: "one", profiles: [
    { id: "one", name: "Main", kind: "wallet", blob, addresses: [address] }, { id: "one", name: "Duplicate", kind: "watch", address: watch },
  ] })])("preserves unreadable current data without migration or overwrite: %s", (raw) => {
    const items = storage({ [PROFILES_KEY]: raw, "pearl-wallet-v1": JSON.stringify(blob) });
    expect(() => loadProfiles(items)).toThrow(ProfileStorageError);
    expect(() => saveProfiles({ version: 2, activeId: null, profiles: [] }, items)).toThrow(ProfileStorageError);
    expect(items.getItem(PROFILES_KEY)).toBe(raw);
    expect(items.getItem("pearl-wallet-v1")).toBe(JSON.stringify(blob));
    expect(initialProfiles(items).error).toBeTruthy();
    const recovery = JSON.parse(profileRecoveryData(items));
    expect(recovery.entries[PROFILES_KEY]).toBe(raw);
  });

  it("recovers a stale selection without writing or discarding intact wallets", () => {
    const original = JSON.stringify({ version: 2, activeId: "missing", profiles: [{ id: "one", name: "Main", kind: "wallet", blob, addresses: [address] }] });
    const items = storage({ [PROFILES_KEY]: original });
    expect(loadProfiles(items)).toMatchObject({ activeId: "one", profiles: [{ blob }] });
    expect(items.getItem(PROFILES_KEY)).toBe(original);
  });

  it("keeps damaged legacy data instead of silently replacing it with an empty store", () => {
    const items = storage({ "pearl-wallet-v1": "{truncated" });
    expect(() => loadProfiles(items)).toThrow(ProfileStorageError);
    expect(items.getItem(PROFILES_KEY)).toBeNull();
    expect(items.getItem("pearl-wallet-v1")).toBe("{truncated");
  });

  it("never removes a legacy copy before the matching verified blob is durably saved", () => {
    const items = storage({ "pearl-wallet-v1": JSON.stringify(blob) });
    expect(() => clearMatchingLegacyWallet(blob, items)).toThrow();
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
    const store = { version: 2 as const, activeId: "one", profiles: [{ id: "one", name: "Main", kind: "wallet" as const, blob, addresses: [address] }] };
    expect(() => saveProfiles(store, { ...items, setItem: () => { throw new Error("QuotaExceededError"); } })).toThrow();
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
    expect(() => saveProfiles(store, { ...items, setItem: () => {} })).toThrow("保存校验失败");
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
    saveProfiles(store, items);
    expect(() => clearMatchingLegacyWallet({ ...blob, ciphertext: "not-the-saved-blob" }, items)).toThrow();
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
    clearMatchingLegacyWallet(blob, items);
    expect(items.getItem("pearl-wallet-v1")).toBeNull();
    expect(loadProfiles(items).profiles).toHaveLength(1);
  });

  it("does not delete an unrelated legacy wallet or report success when deletion fails", () => {
    const items = storage({ "pearl-wallet-v1": JSON.stringify(blob) });
    clearMatchingLegacyWallet({ ...blob, address: watch }, items);
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
    loadProfiles(items);
    expect(() => clearMatchingLegacyWallet(blob, { ...items, removeItem: () => {} })).toThrow("清理失败");
    expect(items.getItem("pearl-wallet-v1")).not.toBeNull();
  });
});
