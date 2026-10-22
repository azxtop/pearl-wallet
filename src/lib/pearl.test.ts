import { afterEach, describe, expect, it, vi } from "vitest";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { derivePearlWallet, isValidMnemonic, newMnemonic } from "./pearl";
import { decryptMnemonic, encryptMnemonic } from "./keystore";

const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
afterEach(() => vi.unstubAllGlobals());
// Captured by Pearl Oyster for the BIP-39 vector seed, m/86'/808276'/0'/0/i.
const OYSTER_ADDRESSES = [
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
  "prl1pfrfqcvcmghjc3mpsazm9p9ktttyuewzlfmn40dzkwh0muejgkr3sfx9jwd",
  "prl1prmdvgxfgzmqzq5dj58enw6y7c55wpsfdpr0af7t79x65z6gmms8q4qa93j",
  "prl1pc9xyu484gw5wsnq7hg00733jlcr4ethphyxmavynyl8me0q7ec7q6qu3wx",
];

describe("Pearl Oyster compatibility", () => {
  it("rejects malformed Pearl addresses before binding wallet ciphertext to them", async () => {
    await expect(encryptMnemonic(VECTOR, "a-strong-test-password", "prl1p-invalid"))
      .rejects.toThrow("钱包地址无效");
  });
  it("stops creation if cryptographic randomness is unavailable or fails", () => {
    vi.stubGlobal("crypto", {});
    expect(() => newMnemonic()).toThrow("安全随机数不可用");
    vi.stubGlobal("crypto", { getRandomValues: () => { throw new Error("RNG unavailable"); } });
    expect(() => newMnemonic()).toThrow("RNG unavailable");
  });

  it("preserves all 128 entropy bits in BIP39 and wipes the temporary random buffer", () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, index) => index * 17);
    let supplied: Uint8Array | undefined;
    const random = vi.fn((buffer: Uint8Array) => { supplied = buffer; buffer.set(entropy); return buffer; });
    vi.stubGlobal("crypto", { getRandomValues: random });
    expect(mnemonicToEntropy(newMnemonic(), wordlist)).toEqual(entropy);
    expect(random).toHaveBeenCalledOnce();
    expect(supplied?.every((byte) => byte === 0)).toBe(true);
  });
  it("derives the same first five mainnet addresses", async () => {
    const result = await derivePearlWallet(VECTOR);
    expect(result.addresses.slice(0, 5)).toEqual(OYSTER_ADDRESSES);
  });

  it("creates valid BIP-39 entropy and restores through encrypted storage", async () => {
    const mnemonic = newMnemonic();
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(mnemonic)).toBe(true);
    const { addresses } = await derivePearlWallet(mnemonic);
    const encrypted = await encryptMnemonic(mnemonic, "a-strong-test-password", addresses[0]);
    expect(JSON.stringify(encrypted)).not.toContain(mnemonic);
    await expect(decryptMnemonic(encrypted, "wrong-password")).rejects.toThrow();
    await expect(decryptMnemonic({ ...encrypted, address: OYSTER_ADDRESSES[0] }, "a-strong-test-password")).rejects.toThrow();
    expect(await decryptMnemonic(encrypted, "a-strong-test-password")).toBe(mnemonic);
  });
});
