import { isNewerVersion } from './update-manifest';

export const UPDATE_DEFER_KEY = 'pearl-update-deferred-v1';
export function shouldOfferUpdate(page: string, current: string, latest: string | undefined, deferred: string | null, now = Date.now()): boolean {
  if (page === 'wallet' || !latest || !isNewerVersion(latest, current)) return false;
  try {
    const value = JSON.parse(deferred ?? 'null');
    if (value?.version === latest && typeof value.until === 'number' && value.until > now) return false;
  } catch { /* A damaged preference must not suppress future updates. */ }
  return true;
}
