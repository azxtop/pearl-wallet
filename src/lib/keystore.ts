import { isValidPearlAddress } from "./pearl";

export interface EncryptedWallet {
  version: 2;
  address: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

const ITERATIONS = 600_000;
function associatedData(address: string): Uint8Array {
  return new TextEncoder().encode(`pearl-android-wallet|v2|${address}|PBKDF2-SHA256|AES-256-GCM`);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(password);
  try {
    const base = await crypto.subtle.importKey("raw", raw, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    raw.fill(0);
  }
}

export async function encryptMnemonic(mnemonic: string, password: string, address: string): Promise<EncryptedWallet> {
  if (password.length < 12) throw new Error("密码至少需要 12 个字符");
  // The address is bound into the AES-GCM associated data; validate it fully so a
  // malformed string can never be silently bound into a wallet blob.
  if (!isValidPearlAddress(address)) throw new Error("钱包地址无效");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(mnemonic);
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(address) }, key, plaintext));
    return { version: 2, address, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptMnemonic(blob: EncryptedWallet, password: string): Promise<string> {
  if (blob.version !== 2 || typeof blob.address !== "string") throw new Error("钱包版本不受支持");
  const salt = fromBase64(blob.salt);
  const iv = fromBase64(blob.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("钱包数据损坏");
  const key = await deriveKey(password, salt);
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(blob.address) },
      key,
      fromBase64(blob.ciphertext),
    ));
    try {
      return new TextDecoder().decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new Error("密码错误或钱包数据损坏");
  }
}
