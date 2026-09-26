import { describe, expect, it } from "vitest";
import { derivePearlWallet, isValidMnemonic, newMnemonic } from "./pearl";
import { decryptMnemonic, encryptMnemonic } from "./keystore";

const VECTOR = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// Captured by Pearl Oyster for the BIP-39 vector seed, m/86'/808276'/0'/0/i.
const OYSTER_ADDRESSES = [
  "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74",
  "prl1pyx3nlscz8rvsxqhcjtyqt2g5szuk9ss7m5saszu3afwwhvn9zp2sz62rhm",
  "prl1pfrfqcvcmghjc3mpsazm9p9ktttyuewzlfmn40dzkwh0muejgkr3sfx9jwd",
  "prl1prmdvgxfgzmqzq5dj58enw6y7c55wpsfdpr0af7t79x65z6gmms8q4qa93j",
  "prl1pc9xyu484gw5wsnq7hg00733jlcr4ethphyxmavynyl8me0q7ec7q6qu3wx",
];

describe("Pearl Oyster compatibility", () => {
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
