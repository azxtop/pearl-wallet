import { probeWalletExplorer, scanWalletExplorer, type ExplorerProbe } from "./explorer";
import { probeWalletBlockbook, scanWalletBlockbook } from "./blockbook";
import type { WalletSnapshot } from "./rpc";

export type Source = "pearlchain" | "pearlresearch";
type Probe = { fingerprint: string };
type Backend = { probe: (addresses: string[]) => Promise<Probe>; scan: (addresses: string[], probe: Probe) => Promise<WalletSnapshot> };
type Health = { failures: number; blockedUntil: number };
type SyncResult = { kind: "unchanged" | "updated" | "skipped"; source?: Source; snapshot?: WalletSnapshot };

const backends: Record<Source, Backend> = {
  pearlchain: {
    probe: probeWalletExplorer,
    scan: (addresses, probe) => scanWalletExplorer(addresses, probe as ExplorerProbe),
  },
  pearlresearch: {
    probe: probeWalletBlockbook,
    scan: (addresses) => scanWalletBlockbook(addresses),
  },
};

export class WalletSynchronizer {
  private health: Record<Source, Health> = {
    pearlchain: { failures: 0, blockedUntil: 0 },
    pearlresearch: { failures: 0, blockedUntil: 0 },
  };
  private last = new Map<string, { source: Source; fingerprint: string; fullAt: number }>();
  private nextCheckAt = 0;
  private lastCheckAt = 0;

  constructor(private services: Record<Source, Backend> = backends, private clock: () => number = Date.now) {}

  async check(addresses: string[], current: WalletSnapshot | null, forceFull = false, onFullStart?: () => void, urgent = false): Promise<SyncResult> {
    const now = this.clock();
    const canUseUrgent = urgent && now >= this.health.pearlchain.blockedUntil;
    if (!forceFull && (canUseUrgent ? now - this.lastCheckAt < 2_000 : now < this.nextCheckAt)) return { kind: "skipped" };
    this.lastCheckAt = now;
    const pool = addresses.join("|");
    let lastError: unknown;
    for (const source of ["pearlchain", "pearlresearch"] as const) {
      const health = this.health[source];
      if (now < health.blockedUntil) continue;
      try {
        const probe = await this.services[source].probe(addresses);
        const previous = this.last.get(pool);
        const needsFull = forceFull || !current || !previous || previous.source !== source
          || previous.fingerprint !== probe.fingerprint || (current.partial && now - previous.fullAt >= 60_000);
        let snapshot: WalletSnapshot | undefined;
        if (needsFull) {
          onFullStart?.();
          snapshot = await this.services[source].scan(addresses, probe);
          this.last.set(pool, { source, fingerprint: probe.fingerprint, fullAt: this.clock() });
        }
        health.failures = 0;
        health.blockedUntil = 0;
        const interval = source === "pearlchain" ? 5_000 : Math.max(15_000, addresses.length * 5_000);
        this.nextCheckAt = this.clock() + interval;
        if (source === "pearlresearch" && this.health.pearlchain.blockedUntil > this.clock()) {
          this.nextCheckAt = Math.min(this.nextCheckAt, this.health.pearlchain.blockedUntil);
        }
        return snapshot ? { kind: "updated", source, snapshot } : { kind: "unchanged", source };
      } catch (error) {
        lastError = error;
        health.failures++;
        health.blockedUntil = this.clock() + Math.min(60_000 * 2 ** (health.failures - 1), 300_000);
        console.warn(`${source} wallet sync paused`, error instanceof Error ? error.message : String(error));
      }
    }
    this.nextCheckAt = Math.min(this.health.pearlchain.blockedUntil, this.health.pearlresearch.blockedUntil);
    throw lastError instanceof Error ? lastError : new Error("链上服务暂不可用");
  }
}
