import { describe, expect, it } from "vitest";
import { BIOMETRIC_ADDRESS_KEY, clearLegacyWalletData, loadProfiles, profileName, PROFILES_KEY, saveProfiles } from "./profiles";

const address = "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74";
const watch = "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm";
const blob = { version: 2, address, salt: "salt", iv: "iv", ciphertext: "ciphertext" };

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
});
