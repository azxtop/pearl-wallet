import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { parseUpdateManifest, UPDATE_MANIFEST_URLS, type UpdateManifest } from './update-manifest';

let pending: Promise<UpdateManifest> | null = null;
export function loadLatestUpdate(): Promise<UpdateManifest> {
  if (pending) return pending;
  pending = (async () => {
    for (const url of UPDATE_MANIFEST_URLS) {
      try {
        const response = Capacitor.isNativePlatform()
          ? await CapacitorHttp.get({ url, connectTimeout: 8000, readTimeout: 8000 })
          : await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async (result) => ({ status: result.status, data: await result.text() }));
        if (response.status !== 200) continue;
        return parseUpdateManifest(response.data);
      } catch { /* Try the backup manifest. */ }
    }
    throw new Error('更新服务不可用');
  })().finally(() => { pending = null; });
  return pending;
}
