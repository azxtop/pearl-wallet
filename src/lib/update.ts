import { Capacitor, registerPlugin } from "@capacitor/core";

interface UpdateInstallerPlugin {
  install(options: { url: string; backupUrl: string; sha256: string }): Promise<{ started: boolean }>;
}

const native = registerPlugin<UpdateInstallerPlugin>("UpdateInstaller");

export async function installUpdate(url: string, backupUrl: string, sha256: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await native.install({ url, backupUrl, sha256 });
}
