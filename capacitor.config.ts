import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.pearl.localwallet",
  appName: "Pearl Wallet",
  webDir: "dist",
  android: { allowMixedContent: false },
};

export default config;
