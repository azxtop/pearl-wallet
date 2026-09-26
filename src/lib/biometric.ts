import { Capacitor, registerPlugin } from "@capacitor/core";

interface BiometricVaultPlugin {
  available(): Promise<{ available: boolean; enabled: boolean }>;
  enable(options: { mnemonic: string }): Promise<{ enabled: boolean }>;
  authenticate(): Promise<{ mnemonic: string }>;
  disable(): Promise<{ enabled: boolean }>;
}

const native = registerPlugin<BiometricVaultPlugin>("BiometricVault");

export const biometric = {
  async status() {
    if (!Capacitor.isNativePlatform()) return { available: false, enabled: false };
    return native.available();
  },
  enable: (mnemonic: string) => native.enable({ mnemonic }),
  authenticate: () => native.authenticate(),
  disable: () => native.disable(),
};
