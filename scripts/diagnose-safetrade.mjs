import https from 'node:https';
import { randomBytes } from 'node:crypto';

// Run on the intended host before deploying. This makes no authenticated requests.
const probes = [
  ['SafeTrade homepage', 'https://safe.trade/'],
  ['PRL/USDT public trades', 'https://safe.trade/api/v2/trade/public/markets/prlusdt/trades?limit=1'],
  ['Alternative domain homepage', 'https://safetrade.com/'],
  ['Alternative domain public trades', 'https://safetrade.com/api/v2/trade/public/markets/prlusdt/trades?limit=1'],
  ['Public WebSocket upgrade', 'https://safe.trade/api/v2/websocket/public', true],
];

function probe(label, address, websocket = false) {
  return new Promise((resolve) => {
    const headers = websocket ? {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    } : {};
    const request = https.get(address, { headers, timeout: 10_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        if (Buffer.concat(chunks).length < 2048) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ label, status: response.statusCode, server: response.headers.server,
          contentType: response.headers['content-type'], cfRay: response.headers['cf-ray'],
          cfMitigated: response.headers['cf-mitigated'],
          location: response.headers.location, body: body.replace(/\s+/g, ' ').slice(0, 350) });
      });
    });
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ label, status: response.statusCode, upgrade: response.headers.upgrade,
        server: response.headers.server, cfRay: response.headers['cf-ray'] });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolve({ label, error: `${error.code || error.name}: ${error.message}` }));
  });
}

for (const [label, address, websocket] of probes) {
  console.log(JSON.stringify(await probe(label, address, websocket)));
}
