import type { EncryptedWallet } from "../lib/keystore";
import type { SendPreview } from "../lib/send";

const worker = new Worker(new URL("./wallet-worker.ts", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();

worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
  const waiter = pending.get(event.data.id);
  if (!waiter) return;
  pending.delete(event.data.id);
  if (event.data.error) waiter.reject(new Error(event.data.error));
  else waiter.resolve(event.data.result);
};

function call<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
    worker.postMessage({ id, cmd, payload });
  });
}

export const wallet = {
  create: (password: string) => call<{ mnemonic: string; blob: EncryptedWallet; addresses: string[] }>("create", { password }),
  restore: (mnemonic: string, password: string) => call<{ blob: EncryptedWallet; addresses: string[] }>("restore", { mnemonic, password }),
  unlock: (blob: EncryptedWallet, password: string) => call<{ addresses: string[] }>("unlock", { blob, password }),
  unlockBiometric: (blob: EncryptedWallet, mnemonic: string) => call<{ addresses: string[] }>("unlockBiometric", { blob, mnemonic }),
  lock: () => call<{ ok: true }>("lock"),
  export: (blob: EncryptedWallet, password: string) => call<{ mnemonic: string }>("export", { blob, password }),
  changePassword: (blob: EncryptedWallet, oldPassword: string, newPassword: string) => call<{ blob: EncryptedWallet }>("changePassword", { blob, oldPassword, newPassword }),
  sign: (blob: EncryptedWallet, preview: SendPreview, auth: { password?: string; biometricMnemonic?: string }) => call<{ rawHex: string }>("sign", { blob, preview, ...auth }),
};
