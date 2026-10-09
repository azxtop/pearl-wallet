import { isValidPearlAddress } from './pearl';
import type { WalletProfile } from './profiles';

export const ADDRESS_BOOK_KEY = 'pearl-address-book-v1';
export type SavedAddress = { address: string; note: string };
export type AddressChoice = SavedAddress & { profileId: string; kind: 'wallet' | 'watch'; index: number };

export function profileAddressChoices(profiles: WalletProfile[]): AddressChoice[] {
  const choices: AddressChoice[] = [];
  for (const profile of profiles) {
    const addresses = profile.kind === 'watch' ? [profile.address] : [profile.blob.address, ...profile.addresses];
    const seen = new Set<string>();
    for (const address of addresses) {
      if (!isValidPearlAddress(address) || seen.has(address)) continue;
      seen.add(address);
      const index = seen.size;
      choices.push({ address, note: profile.kind === 'watch' ? profile.name : `地址 ${index}`, profileId: profile.id, kind: profile.kind, index });
    }
  }
  return choices;
}

export function parseSavedAddresses(raw: string | null): SavedAddress[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.slice(0, 100).flatMap((item): SavedAddress[] => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      if (typeof row.address !== 'string' || !isValidPearlAddress(row.address) || seen.has(row.address)) return [];
      seen.add(row.address);
      return [{ address: row.address, note: typeof row.note === 'string' ? row.note.trim().slice(0, 50) : '' }];
    });
  } catch { return []; }
}

export function loadSavedAddresses(): SavedAddress[] {
  try { return parseSavedAddresses(localStorage.getItem(ADDRESS_BOOK_KEY)); }
  catch { return []; }
}

export function saveSavedAddresses(entries: SavedAddress[]): void {
  localStorage.setItem(ADDRESS_BOOK_KEY, JSON.stringify(entries));
}
