import type { EncryptedWallet } from "./keystore";
import { isValidPearlAddress } from "./pearl";

export const PROFILES_KEY = "pearl-wallet-profiles-v2";
export const BIOMETRIC_ADDRESS_KEY = "pearl-wallet-biometric-address-v1";
const LEGACY_WALLET_KEY = "pearl-wallet-v1";
const LEGACY_ADDRESSES_KEY = "pearl-wallet-public-addresses-v1";
const LEGACY_WATCH_KEY = "pearl-wallet-watch-address-v1";

export type WalletProfile =
  | { id: string; name: string; kind: "wallet"; blob: EncryptedWallet; addresses: string[] }
  | { id: string; name: string; kind: "watch"; address: string };

export type ProfileStore = { version: 2; activeId: string | null; profiles: WalletProfile[] };

type ProfileStorage = Pick<Storage, "getItem" | "setItem">;
const STORAGE_ERROR = "本机钱包数据读取异常，原始数据已保留。请勿卸载应用或清除数据，请先复制加密数据用于恢复。";
export class ProfileStorageError extends Error {
  constructor(message = STORAGE_ERROR) { super(message); this.name = "ProfileStorageError"; }
}

function validAddresses(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 20 && value.every((address) => typeof address === "string" && isValidPearlAddress(address));
}

function validProfile(value: unknown): value is WalletProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<WalletProfile>;
  if (typeof profile.id !== "string" || !profile.id || typeof profile.name !== "string" || !profile.name.trim()) return false;
  if (profile.kind === "watch") return typeof profile.address === "string" && isValidPearlAddress(profile.address);
  if (profile.kind === "wallet") {
    const blob = profile.blob;
    return blob?.version === 2 && typeof blob.address === "string" && isValidPearlAddress(blob.address)
      && typeof blob.salt === "string" && typeof blob.iv === "string" && typeof blob.ciphertext === "string"
      && validAddresses(profile.addresses);
  }
  return false;
}

function parseStored(raw: string | null): ProfileStore | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as ProfileStore;
    if (!value || value.version !== 2 || !Array.isArray(value.profiles) || !value.profiles.every(validProfile)) throw new ProfileStorageError();
    if (new Set(value.profiles.map((profile) => profile.id)).size !== value.profiles.length) throw new ProfileStorageError();
    // The selection is disposable metadata. A missing/stale selection must
    // never discard the otherwise intact encrypted wallets.
    const activeId = value.activeId === null || value.profiles.some((profile) => profile.id === value.activeId)
      ? value.activeId : value.profiles[0]?.id ?? null;
    return { version: 2, activeId, profiles: value.profiles };
  } catch { throw new ProfileStorageError(); }
}

export function loadProfiles(storage: ProfileStorage = localStorage): ProfileStore {
  const existing = parseStored(storage.getItem(PROFILES_KEY));
  if (existing) return existing;
  const legacyWallet = (() => {
    try {
      const raw = storage.getItem(LEGACY_WALLET_KEY);
      const value: unknown = raw ? JSON.parse(raw) : null;
      if (raw !== null && !value) throw new ProfileStorageError();
      return value;
    } catch { throw new ProfileStorageError(); }
  })();
  const addresses = (() => {
    try {
      const raw = storage.getItem(LEGACY_ADDRESSES_KEY);
      const value: unknown = raw ? JSON.parse(raw) : null;
      return validAddresses(value) ? value : [];
    } catch { return []; }
  })();
  const profiles: WalletProfile[] = [];
  const walletProfile = { id: crypto.randomUUID(), name: "钱包 1", kind: "wallet" as const, blob: legacyWallet as EncryptedWallet, addresses };
  if (legacyWallet !== null && !validProfile(walletProfile)) throw new ProfileStorageError();
  if (validProfile(walletProfile)) profiles.push(walletProfile);
  const watch = storage.getItem(LEGACY_WATCH_KEY);
  if (watch && isValidPearlAddress(watch)) profiles.push({ id: crypto.randomUUID(), name: "观察钱包 1", kind: "watch", address: watch });
  const activeId = watch && profiles.some((profile) => profile.kind === "watch")
    ? profiles.find((profile) => profile.kind === "watch")!.id
    : profiles[0]?.id ?? null;
  const result: ProfileStore = { version: 2, activeId, profiles };
  saveProfiles(result, storage);
  if (profiles.some((profile) => profile.kind === "wallet") && !storage.getItem(BIOMETRIC_ADDRESS_KEY)) {
    storage.setItem(BIOMETRIC_ADDRESS_KEY, walletProfile.blob.address);
  }
  return result;
}

export function saveProfiles(store: ProfileStore, storage: ProfileStorage = localStorage): void {
  // Refuse to overwrite unreadable existing data, including data damaged after
  // startup. Do not create a second stale ciphertext copy as a backup here.
  parseStored(storage.getItem(PROFILES_KEY));
  const encoded = JSON.stringify(store);
  parseStored(encoded);
  storage.setItem(PROFILES_KEY, encoded);
  if (storage.getItem(PROFILES_KEY) !== encoded) throw new ProfileStorageError("钱包保存校验失败，已停止操作，请保留应用数据并重试。");
}

export function initialProfiles(storage: ProfileStorage = localStorage): { store: ProfileStore; error: string } {
  try { return { store: loadProfiles(storage), error: "" }; }
  catch (error) {
    return { store: { version: 2, activeId: null, profiles: [] }, error: error instanceof Error ? error.message : STORAGE_ERROR };
  }
}

export function profileRecoveryData(storage: Pick<Storage, "getItem"> = localStorage): string {
  return JSON.stringify({ format: "pearl-wallet-storage-recovery-v1", entries: Object.fromEntries(
    [PROFILES_KEY, LEGACY_WALLET_KEY, LEGACY_ADDRESSES_KEY, LEGACY_WATCH_KEY].map((key) => [key, storage.getItem(key)]),
  ) }, null, 2);
}

export function clearMatchingLegacyWallet(verifiedBlob: EncryptedWallet, storage: Pick<Storage, "getItem" | "removeItem"> = localStorage): void {
  const address = verifiedBlob.address;
  const raw = storage.getItem(LEGACY_WALLET_KEY);
  if (raw === null) return;
  let legacy: Partial<EncryptedWallet>;
  try { legacy = JSON.parse(raw) as Partial<EncryptedWallet>; } catch { return; }
  if (!legacy || legacy.address !== address) return;
  const saved = parseStored(storage.getItem(PROFILES_KEY));
  if (!saved?.profiles.some((profile) => profile.kind === "wallet" && profile.blob.address === address
    && profile.blob.version === verifiedBlob.version && profile.blob.salt === verifiedBlob.salt
    && profile.blob.iv === verifiedBlob.iv && profile.blob.ciphertext === verifiedBlob.ciphertext)) {
    throw new ProfileStorageError("未找到已保存的钱包，已保留旧版加密数据。");
  }
  storage.removeItem(LEGACY_WALLET_KEY);
  if (storage.getItem(LEGACY_WALLET_KEY) !== null) throw new Error("旧版加密副本清理失败，请重试。");
  storage.removeItem(LEGACY_ADDRESSES_KEY);
}

export function clearLegacyWalletData(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(LEGACY_WALLET_KEY);
  storage.removeItem(LEGACY_ADDRESSES_KEY);
}

export function profileName(name: string, profiles: WalletProfile[]): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 24) throw new Error("钱包名称需为 1–24 个字符");
  if (profiles.some((profile) => profile.name === trimmed)) throw new Error("钱包名称已存在");
  return trimmed;
}
