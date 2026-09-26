import { describe, expect, it } from "vitest";
import { isNewerVersion, parseUpdateManifest } from "./update-manifest";

const valid = {
  version: "0.2.9",
  apkUrl: "https://pearlwallet.az1993.xyz/releases/PearlWallet-0.2.9-release.apk",
  githubApkUrl: "https://github.com/azxtop/pearl-wallet/releases/download/v0.2.9/PearlWallet-0.2.9-release.apk",
  sha256: "a".repeat(64),
};

describe("update manifest", () => {
  it("accepts the pinned GitHub and server locations", () => {
    expect(parseUpdateManifest(JSON.stringify(valid))).toEqual({
      version: valid.version,
      apkUrl: valid.githubApkUrl,
      backupApkUrl: valid.apkUrl,
      sha256: valid.sha256,
    });
  });

  it("rejects substituted APK locations and invalid hashes", () => {
    expect(() => parseUpdateManifest({ ...valid, apkUrl: "https://example.com/wallet.apk" })).toThrow();
    expect(() => parseUpdateManifest({ ...valid, githubApkUrl: valid.apkUrl })).toThrow();
    expect(() => parseUpdateManifest({ ...valid, sha256: "wrong" })).toThrow();
  });

  it("compares every numeric version component", () => {
    expect(isNewerVersion("0.2.10", "0.2.9")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.2.9")).toBe(true);
    expect(isNewerVersion("0.2.8", "0.2.9")).toBe(false);
  });
});
