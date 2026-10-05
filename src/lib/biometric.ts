import { Capacitor, registerPlugin } from "@capacitor/core";

interface BiometricVaultPlugin {
  available(options: { address: string; legacyAddress: string | null }): Promise<{ available: boolean; enabled: boolean }>;
  enable(options: { address: string; mnemonic: string }): Promise<{ enabled: boolean }>;
  authenticate(options: { address: string; legacyAddress: string | null }): Promise<{ mnemonic: string }>;
  disable(options: { address: string; legacyAddress: string | null }): Promise<{ enabled: boolean }>;
}

const native = registerPlugin<BiometricVaultPlugin>("BiometricVault");

export const biometric = {
  async status(address: string, legacyAddress: string | null) {
    if (!Capacitor.isNativePlatform()) return { available: false, enabled: false };
    return native.available({ address, legacyAddress });
  },
  enable: (address: string, mnemonic: string) => native.enable({ address, mnemonic }),
  authenticate: (address: string, legacyAddress: string | null) => native.authenticate({ address, legacyAddress }),
  disable: (address: string, legacyAddress: string | null) => native.disable({ address, legacyAddress }),
};
