import { Capacitor, registerPlugin } from "@capacitor/core";

type ScreenPrivacyPlugin = { setSecure(options: { secure: boolean }): Promise<void> };
const native = registerPlugin<ScreenPrivacyPlugin>("ScreenPrivacy");

export const screenPrivacy = {
  setSecure: (secure: boolean) => Capacitor.isNativePlatform() ? native.setSecure({ secure }) : Promise.resolve(),
};
