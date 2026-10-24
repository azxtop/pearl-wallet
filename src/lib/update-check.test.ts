import { afterEach, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: { get } }));
import { loadLatestUpdate } from './update-check';
import { UPDATE_MANIFEST_URLS } from './update-manifest';
const manifest = { version: '0.2.44', apkUrl: 'https://pearlwallet.az1993.xyz/releases/PearlWallet-0.2.44-release.apk',
  githubApkUrl: 'https://github.com/azxtop/pearl-wallet/releases/download/v0.2.44/PearlWallet-0.2.44-release.apk', sha256: 'a'.repeat(64) };
afterEach(() => { get.mockReset(); });

it('uses the server backup when GitHub is unavailable and shares concurrent checks', async () => {
  get.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 200, data: manifest });
  const first = loadLatestUpdate(), second = loadLatestUpdate();
  expect(first).toBe(second);
  expect((await first).version).toBe('0.2.44');
  expect(get.mock.calls.map(([options]) => options.url)).toEqual([...UPDATE_MANIFEST_URLS]);
});

it('does not offer an update with a substituted APK location', async () => {
  get.mockResolvedValue({ status: 200, data: { ...manifest, githubApkUrl: 'https://example.com/app.apk' } });
  await expect(loadLatestUpdate()).rejects.toThrow('更新服务不可用');
});
