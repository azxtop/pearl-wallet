import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';

// Sends the existing read-only API key to one curl process, optionally over SSH.
// It does not store the key remotely or print the account response.
const target = process.argv[2];
const proxy = target?.startsWith('--proxy=') ? target.slice('--proxy='.length) : null;
if (proxy ? !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(proxy)
  : !target || !/^[a-zA-Z0-9@._-]+$/.test(target)) {
  throw new Error('Usage: node scripts/diagnose-safetrade-account.mjs user@host | --proxy=http://127.0.0.1:PORT');
}
const path = process.env.SAFETRADE_CREDENTIAL_FILE || 'private/safetrade.txt';
const lines = readFileSync(path, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
if (lines.length !== 4 || !lines[1] || !lines[3]) throw new Error('Invalid credential file');
const [key, secret] = [lines[1], lines[3]];
const nonce = String(Date.now());
const signature = createHmac('sha256', secret).update(nonce + key).digest('hex');
const escape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
const config = [
  'url = "https://safe.trade/api/v2/trade/account/balances/spot"',
  `header = "X-Auth-Apikey: ${escape(key)}"`,
  `header = "X-Auth-Nonce: ${nonce}"`,
  `header = "X-Auth-Signature: ${signature}"`,
  'header = "Content-Type: application/json;charset=utf-8"',
  `output = "${proxy ? 'NUL' : '/dev/null'}"`,
  'dump-header = "-"',
  'write-out = "HTTP %{http_code} remote %{remote_ip}"',
  'silent',
  'show-error',
  'max-time = 12',
].join('\n') + '\n';
const child = proxy
  ? spawn('curl.exe', ['--proxy', proxy, '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, 'curl --config -'], { stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
child.stderr.resume(); // Never print stderr because it could include sensitive request details.
child.on('error', (error) => { console.error(`Probe error: ${error.code || error.name}`); process.exitCode = 1; });
child.on('close', (code) => {
  if (code !== 0) { console.error(`Probe failed (exit ${code})`); process.exitCode = 1; }
  else console.log(output.split(/\r?\n/).filter((line) =>
    /^(HTTP\/|Server:|CF-RAY:|Content-Type:|cf-mitigated:|HTTP \d{3} remote )/i.test(line)
  ).join('\n'));
});
child.stdin.end(config);
