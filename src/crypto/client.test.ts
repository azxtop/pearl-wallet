import { afterEach, describe, expect, it, vi } from "vitest";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  reply(index: number, result: unknown) {
    const { id } = this.postMessage.mock.calls[index][0];
    this.onmessage?.({ data: { id, result } });
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); FakeWorker.instances = []; });

describe("wallet worker destruction", () => {
  it("immediately terminates the worker and cancels every in-flight operation on lock", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { wallet } = await import("./client");
    expect(FakeWorker.instances).toHaveLength(0);
    const create = wallet.create("public-test-password");
    const unlock = wallet.unlock({} as any, "public-test-password");
    const cancelled = Promise.all([
      expect(create).rejects.toThrow("钱包已锁定"), expect(unlock).rejects.toThrow("钱包已锁定"),
    ]);
    const previous = FakeWorker.instances[0];
    await wallet.lock();
    expect(previous.terminate).toHaveBeenCalledOnce();
    await cancelled;
    const next = wallet.create("public-test-password");
    expect(FakeWorker.instances).toHaveLength(2);
    previous.reply(0, { mnemonic: "stale secret" });
    FakeWorker.instances[1].reply(0, { mnemonic: "new test phrase" });
    await expect(next).resolves.toEqual({ mnemonic: "new test phrase" });
    await wallet.lock();
  });

  it("rejects pending calls after a worker crash and starts a fresh worker for the next authorization", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { wallet } = await import("./client");
    const operation = wallet.create("public-test-password");
    const rejected = expect(operation).rejects.toThrow("钱包进程异常");
    FakeWorker.instances[0].onerror?.({ preventDefault: vi.fn() });
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    const retry = wallet.create("public-test-password");
    FakeWorker.instances[1].reply(0, { ok: true });
    await expect(retry).resolves.toEqual({ ok: true });
    await wallet.lock();
  });
});
