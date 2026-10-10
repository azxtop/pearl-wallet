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
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'PearlWalletRelease' };
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
      tag_name: tag, target_commitish: commit, name: `Pearl Wallet ${tag}`, prerelease: true,
      body: `Pearl Wallet 0.2.32 预发布版\n\n- “查看更多成交”页面支持顶部下拉刷新。\n- 刷新期间保留已有成交记录，新结果返回后更新列表；原有刷新按钮仍可使用。\n\nSHA-256: ${hash}`,
    }),
  }));
} else await checked(existing);
if (!release.assets.some((asset) => asset.name === filename)) {
  const uploadUrl = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(filename)}`;
  const asset = await checked(await fetch(uploadUrl, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(bytes.length) }, body: bytes,
  }));
  if (asset.size !== bytes.length) throw new Error('Uploaded asset size mismatch');
}
console.log('Release:', release.html_url);
console.log('Asset:', `${release.html_url.replace('/tag/', '/download/')}/${filename}`);
console.log('SHA-256:', hash);
