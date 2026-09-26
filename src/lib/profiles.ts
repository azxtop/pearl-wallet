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
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ProfileStore;
    if (value.version !== 2 || !Array.isArray(value.profiles) || !value.profiles.every(validProfile)) return null;
    if (value.activeId !== null && !value.profiles.some((profile) => profile.id === value.activeId)) return null;
    return value;
  } catch { return null; }
}

export function loadProfiles(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): ProfileStore {
  const existing = parseStored(storage.getItem(PROFILES_KEY));
  if (existing) return existing;
  const legacyWallet = (() => {
    try {
      const raw = storage.getItem(LEGACY_WALLET_KEY);
      const value: unknown = raw ? JSON.parse(raw) : null;
      return value;
    } catch { return null; }
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
  if (validProfile(walletProfile)) profiles.push(walletProfile);
  const watch = storage.getItem(LEGACY_WATCH_KEY);
  if (watch && isValidPearlAddress(watch)) profiles.push({ id: crypto.randomUUID(), name: "观察钱包 1", kind: "watch", address: watch });
  const activeId = watch && profiles.some((profile) => profile.kind === "watch")
    ? profiles.find((profile) => profile.kind === "watch")!.id
    : profiles[0]?.id ?? null;
  const result: ProfileStore = { version: 2, activeId, profiles };
  storage.setItem(PROFILES_KEY, JSON.stringify(result));
  if (profiles.some((profile) => profile.kind === "wallet") && !storage.getItem(BIOMETRIC_ADDRESS_KEY)) {
    storage.setItem(BIOMETRIC_ADDRESS_KEY, walletProfile.blob.address);
  }
  return result;
}

export function saveProfiles(store: ProfileStore, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(PROFILES_KEY, JSON.stringify(store));
}

export function profileName(name: string, profiles: WalletProfile[]): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 24) throw new Error("钱包名称需为 1–24 个字符");
  if (profiles.some((profile) => profile.name === trimmed)) throw new Error("钱包名称已存在");
  return trimmed;
}
