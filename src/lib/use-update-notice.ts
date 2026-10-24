import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { loadLatestUpdate } from './update-check';
import { shouldOfferUpdate, UPDATE_DEFER_KEY } from './update-policy';
import type { UpdateManifest } from './update-manifest';

export function useUpdateNotice(page: string, currentVersion: string, blocked: boolean, options: { native?: boolean; load?: typeof loadLatestUpdate } = {}) {
  const [latest, setLatest] = useState<UpdateManifest | null>(null);
  const [deferred, setDeferred] = useState(() => { try { return localStorage.getItem(UPDATE_DEFER_KEY); } catch { return null; } });
  const [foreground, setForeground] = useState(() => !document.hidden);
  const [clock, setClock] = useState(Date.now);
  const nextCheck = useRef(0);
  const checking = useRef(false);
  const load = options.load ?? loadLatestUpdate;
  const enabled = (options.native ?? Capacitor.isNativePlatform()) && page !== 'wallet' && foreground && !blocked;
  useEffect(() => {
    const onVisibility = () => { setForeground(!document.hidden); setClock(Date.now()); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const check = () => {
      setClock(Date.now());
      if (checking.current || Date.now() < nextCheck.current) return;
      checking.current = true;
      void load().then((manifest) => { setLatest(manifest); nextCheck.current = Date.now() + 6 * 3600_000; })
        .catch(() => { nextCheck.current = Date.now() + 30 * 60_000; })
        .finally(() => { checking.current = false; });
    };
    const initial = setTimeout(check, 1500);
    const timer = setInterval(check, 60_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [enabled, load]);
  const dismiss = useCallback(() => {
    if (!latest) return;
    const value = JSON.stringify({ version: latest.version, until: Date.now() + 24 * 3600_000 });
    setDeferred(value);
    try { localStorage.setItem(UPDATE_DEFER_KEY, value); } catch { /* Session deferral still works. */ }
  }, [latest]);
  const available = enabled && shouldOfferUpdate(page, currentVersion, latest?.version, deferred, clock) ? latest : null;
  return { available, dismiss };
}
