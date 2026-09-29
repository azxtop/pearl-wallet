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
      body: `PRL send screen now shows the active wallet and balance, 25%/50%/75%/MAX amount shortcuts, and three selectable fee rates. The chosen rate is used in the transaction preview. SafeTrade assets show available plus order-locked balances as totals and an estimated combined value in USDT.\n\nSHA-256: ${hash}`,
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
