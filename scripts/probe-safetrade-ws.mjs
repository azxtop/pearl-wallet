const url = process.env.SAFETRADE_WS_URL || 'wss://safe.trade/api/v2/websocket/public';
const socket = new WebSocket(url);
const timer = setTimeout(() => socket.close(), 20_000);
let messages = 0;
socket.addEventListener('open', () => {
  console.log('open');
  socket.send(JSON.stringify({ event: 'subscribe', streams: ['pearlusdt.trades', 'pearlusdt.depth', 'global.tickers'] }));
});
socket.addEventListener('message', ({ data }) => {
  const raw = String(data);
  let value;
  try { value = JSON.parse(raw); } catch { value = raw; }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const relevant = Object.fromEntries(keys.filter((key) => key.includes('pearlusdt') || !key.includes('tickers')).map((key) => [key, value[key]]));
    if (value['global.tickers'] && typeof value['global.tickers'] === 'object') {
      relevant['global.tickers.pearlusdt'] = value['global.tickers'].pearlusdt;
    }
    console.log(JSON.stringify(relevant).slice(0, 2000));
  } else console.log(raw.slice(0, 2000));
  if (++messages >= 8) socket.close();
});
socket.addEventListener('error', (error) => console.log('error', error.message || 'WebSocket error'));
socket.addEventListener('close', (event) => {
  clearTimeout(timer);
  console.log('close', event.code, event.reason);
});
