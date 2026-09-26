export type UpdateManifest = {
  version: string;
  apkUrl: string;
  backupApkUrl: string;
  sha256: string;
};

export const UPDATE_MANIFEST_URLS = [
  "https://raw.githubusercontent.com/azxtop/pearl-wallet/main/server/update.json",
  "https://pearlwallet.az1993.xyz/api/update",
] as const;

const VERSION = /^\d+\.\d+\.\d+$/;
const HASH = /^[0-9a-f]{64}$/i;

export function parseUpdateManifest(data: unknown): UpdateManifest {
  const value = typeof data === "string" ? JSON.parse(data) as unknown : data;
  if (!value || typeof value !== "object") throw new Error("版本信息无效");
  const item = value as Record<string, unknown>;
  if (typeof item.version !== "string" || !VERSION.test(item.version)) throw new Error("版本信息无效");
  const file = `PearlWallet-${item.version}-release.apk`;
  const githubUrl = `https://github.com/azxtop/pearl-wallet/releases/download/v${item.version}/${file}`;
  const serverUrl = `https://pearlwallet.az1993.xyz/releases/${file}`;
  // Keep apkUrl on the server so already-installed 0.2.8 clients can upgrade.
  if (item.apkUrl !== serverUrl || item.githubApkUrl !== githubUrl || typeof item.sha256 !== "string" || !HASH.test(item.sha256)) {
    throw new Error("安装包信息无效");
  }
  return { version: item.version, apkUrl: githubUrl, backupApkUrl: serverUrl, sha256: item.sha256 };
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  return a.some((number, index) => number > b[index]! && a.slice(0, index).every((value, i) => value === b[i]));
}
