import type { EncryptedWallet } from "../lib/keystore";
import type { SendPreview } from "../lib/send";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();

function destroyWorker(message = "钱包已锁定，操作已取消") {
  const previous = worker;
  worker = null;
  previous?.terminate();
  for (const waiter of pending.values()) waiter.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const current = new Worker(new URL("./wallet-worker.ts", import.meta.url), { type: "module" });
  worker = current;
  current.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    if (worker !== current) return;
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    pending.delete(event.data.id);
    if (event.data.error) waiter.reject(new Error(event.data.error));
    else waiter.resolve(event.data.result);
  };
  current.onerror = (event) => {
    event.preventDefault();
    if (worker === current) destroyWorker("钱包进程异常，请重新授权");
  };
  current.onmessageerror = () => {
    if (worker === current) destroyWorker("钱包进程通信失败，请重新授权");
  };
  return current;
}

function call<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    try {
      const current = getWorker();
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      current.postMessage({ id, cmd, payload });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

export const wallet = {
  create: (password: string) => call<{ mnemonic: string; blob: EncryptedWallet; addresses: string[] }>("create", { password }),
  restore: (mnemonic: string, password: string) => call<{ blob: EncryptedWallet; addresses: string[] }>("restore", { mnemonic, password }),
  unlock: (blob: EncryptedWallet, password: string) => call<{ addresses: string[] }>("unlock", { blob, password }),
  unlockBiometric: (blob: EncryptedWallet, mnemonic: string) => call<{ addresses: string[] }>("unlockBiometric", { blob, mnemonic }),
  lock: () => { destroyWorker(); return Promise.resolve({ ok: true as const }); },
  export: (blob: EncryptedWallet, password: string) => call<{ mnemonic: string }>("export", { blob, password }),
  verifyPassword: (blob: EncryptedWallet, password: string) => call<{ ok: true }>("verifyPassword", { blob, password }),
  changePassword: (blob: EncryptedWallet, oldPassword: string, newPassword: string) => call<{ blob: EncryptedWallet }>("changePassword", { blob, oldPassword, newPassword }),
  sign: (blob: EncryptedWallet, preview: SendPreview, auth: { password?: string; biometricMnemonic?: string }) => call<{ rawHex: string; txid: string }>("sign", { blob, preview, ...auth }),
};
