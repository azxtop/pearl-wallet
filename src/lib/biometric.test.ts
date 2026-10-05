import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  available: vi.fn(),
  enable: vi.fn(),
  authenticate: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => native,
}));

import { biometric } from "./biometric";

describe("wallet-specific biometric calls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries and unlocks the selected wallet without losing the legacy address", async () => {
    native.available.mockResolvedValue({ available: true, enabled: true });
    native.authenticate.mockResolvedValue({ mnemonic: "test mnemonic" });
    await biometric.status("prl1walletone", "prl1walletone");
    await biometric.status("prl1wallettwo", "prl1walletone");
    await biometric.authenticate("prl1walletone", "prl1walletone");
    expect(native.available).toHaveBeenNthCalledWith(1, { address: "prl1walletone", legacyAddress: "prl1walletone" });
    expect(native.available).toHaveBeenNthCalledWith(2, { address: "prl1wallettwo", legacyAddress: "prl1walletone" });
    expect(native.authenticate).toHaveBeenCalledWith({ address: "prl1walletone", legacyAddress: "prl1walletone" });
  });

  it("enables and disables only the chosen wallet", async () => {
    native.enable.mockResolvedValue({ enabled: true });
    native.disable.mockResolvedValue({ enabled: false });
    await biometric.enable("prl1wallettwo", "test mnemonic");
    await biometric.disable("prl1wallettwo", "prl1walletone");
    expect(native.enable).toHaveBeenCalledWith({ address: "prl1wallettwo", mnemonic: "test mnemonic" });
    expect(native.disable).toHaveBeenCalledWith({ address: "prl1wallettwo", legacyAddress: "prl1walletone" });
  });
});
