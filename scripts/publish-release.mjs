import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('server/update.json', 'utf8'));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (manifest.version !== version) throw new Error('Package and update versions differ');
const tag = `v${version}`;
const filename = `PearlWallet-${version}-release.apk`;
const bytes = readFileSync(`releases/${filename}`);
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== manifest.sha256) throw new Error('APK hash does not match update manifest');
const credential = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 10000,
  env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
});
const token = credential.stdout.split(/\r?\n/).find((line) => line.startsWith('password='))?.slice(9);
if (credential.status !== 0 || !token) throw new Error('GitHub credential unavailable');
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const localTag = spawnSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' });
if (localTag.status !== 0 || localTag.stdout.trim() !== commit) throw new Error('Release tag must point to the current commit');
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PearlWalletRelease' };
const notes = `Pearl Wallet ${version} 预发布版

- 新增 Gate PEARL/USDT 现货行情：六个 K 线周期、完整盘口、最新成交与历史筛选。
- Gate 行情由服务器持续采集，WebSocket 实时更新盘口与成交，并保存 K 线和近期成交记录。
- 新增应用更新提示：离开 Wallet 进入 Market 或设置后才检查和提示更新，支持稍后提醒。
- 保留手动检查更新；GitHub 下载为主，服务器下载作为备用。

验证：148 项测试通过，类型检查、Android 构建及正式版签名校验通过；测试机已检查 Gate 行情、完整盘口、成交筛选与更新提示。

此版本经过有范围的技术复核，尚不属于第三方独立安全审计，也未完成真实主网转账测试。
APK 与旧正式版签名一致，可覆盖升级并保留钱包数据。debug 版签名不同，请勿通过卸载旧钱包来切换版本；先确保助记词已离线备份。

SHA-256: ${hash}`;
async function checked(response) {
  const body = await response.json();
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${String(body.message || 'request failed').slice(0, 120)}`);
  return body;
}
const url = 'https://api.github.com/repos/azxtop/pearl-wallet/releases';
let release;
const existing = await fetch(`${url}/tags/${tag}`, { headers });
if (existing.ok) release = await existing.json();
else if (existing.status === 404) {
  release = await checked(await fetch(url, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag, target_commitish: commit, name: `Pearl Wallet ${tag}`, prerelease: true, draft: true,
      body: notes,
    }),
  }));
} else await checked(existing);
if (!release.assets.some((asset) => asset.name === filename)) {
  const uploadUrl = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(filename)}`;
  const asset = await checked(await fetch(uploadUrl, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(bytes.length) }, body: bytes,
  }));
  if (asset.size !== bytes.length || asset.digest !== `sha256:${hash}`) throw new Error('Uploaded APK does not match local size and SHA-256');
} else {
  const asset = release.assets.find((item) => item.name === filename);
  if (asset.size !== bytes.length || asset.digest && asset.digest !== `sha256:${hash}`) throw new Error('Existing release asset does not match the local APK');
}
const checksumName = `${filename}.sha256`;
if (!release.assets.some((asset) => asset.name === checksumName)) {
  const checksum = Buffer.from(`${hash}  ${filename}\n`, 'utf8');
  await checked(await fetch(`${release.upload_url.split('{')[0]}?name=${encodeURIComponent(checksumName)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain', 'Content-Length': String(checksum.length) }, body: checksum,
  }));
}
// Publish only after all assets have been uploaded and checked. The caller
// updates main's manifest after this succeeds, so updaters never see a 404.
release = await checked(await fetch(release.url, {
  method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: `Pearl Wallet ${tag}`, body: notes, draft: false, prerelease: true }),
}));
console.log('Release:', release.html_url);
console.log('Asset:', `${release.html_url.replace('/tag/', '/download/')}/${filename}`);
console.log('SHA-256:', hash);
