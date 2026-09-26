import { describe, expect, it, vi } from "vitest";
import { WalletSynchronizer } from "./wallet-sync";
import type { WalletSnapshot } from "./rpc";

const address = "prl1p53nv89eh06ccqrc40dpnugxm5gd780xh8pnv577szpdnd33l7weszyyljq";
const snapshot: WalletSnapshot = { balanceGrains: 1n, pendingGrains: 0n, utxos: [], activities: [], partial: false, updatedAt: 1 };

describe("wallet polling and failover", () => {
  it("checks every five seconds but only reloads history when the probe changes", async () => {
    let now = 1_000;
    let fingerprint = "first";
    const probe = vi.fn(async () => ({ fingerprint }));
    const scan = vi.fn(async () => snapshot);
    const backup = { probe: vi.fn(async () => ({ fingerprint: "backup" })), scan: vi.fn(async () => snapshot) };
    const sync = new WalletSynchronizer({ pearlchain: { probe, scan }, pearlresearch: backup }, () => now);
    expect((await sync.check([address], null, true)).kind).toBe("updated");
    now += 4_000;
    expect((await sync.check([address], snapshot)).kind).toBe("skipped");
    now += 1_000;
    expect((await sync.check([address], snapshot)).kind).toBe("unchanged");
    expect(scan).toHaveBeenCalledTimes(1);
    fingerprint = "changed";
    now += 5_000;
    expect((await sync.check([address], snapshot)).kind).toBe("updated");
    expect(scan).toHaveBeenCalledTimes(2);
    expect(backup.probe).not.toHaveBeenCalled();
  });

  it("pauses a failing primary, slows backup checks, then returns to primary", async () => {
    let now = 1_000;
    let failing = true;
    const primary = { probe: vi.fn(async () => {
      if (failing) throw new Error("Pearlchain HTTP 403");
      return { fingerprint: "primary" };
    }), scan: vi.fn(async () => snapshot) };
    const backup = { probe: vi.fn(async () => ({ fingerprint: "backup" })), scan: vi.fn(async () => snapshot) };
    const sync = new WalletSynchronizer({ pearlchain: primary, pearlresearch: backup }, () => now);
    expect((await sync.check([address], null, true)).source).toBe("pearlresearch");
    now += 5_000;
    expect((await sync.check([address], snapshot)).kind).toBe("skipped");
    now += 10_000;
    expect((await sync.check([address], snapshot)).source).toBe("pearlresearch");
    expect(primary.probe).toHaveBeenCalledTimes(1);
    failing = false;
    now = 61_000;
    expect((await sync.check([address], snapshot)).source).toBe("pearlchain");
    expect(primary.scan).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated SSE events but lets an event check before the five-second timer", async () => {
    let now = 1_000;
    const probe = vi.fn(async () => ({ fingerprint: "same" }));
    const sync = new WalletSynchronizer({
      pearlchain: { probe, scan: async () => snapshot },
      pearlresearch: { probe, scan: async () => snapshot },
    }, () => now);
    await sync.check([address], null, true);
    now += 1_000;
    expect((await sync.check([address], snapshot, false, undefined, true)).kind).toBe("skipped");
    now += 1_000;
    expect((await sync.check([address], snapshot, false, undefined, true)).kind).toBe("unchanged");
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
