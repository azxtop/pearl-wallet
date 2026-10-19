import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.pearl.localwallet",
  appName: "Pearl Wallet",
  webDir: "dist",
  // Native bridge debug logs include plugin arguments (including a mnemonic
  // when enabling biometrics). Disable them for both build variants.
  loggingBehavior: "none",
  android: { allowMixedContent: false },
};

export default config;
