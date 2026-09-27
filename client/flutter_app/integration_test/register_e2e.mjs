// Register preview E2E driver: call the debug VM service extension
// ext.pai.debug.registerFill to fill/submit the form programmatically
// (window-level input injection is blocked when the screen is covered
// by a fullscreen game). Usage:
//   node register_e2e.mjs <vmServiceHttpUrl> '<jsonParams>'
// Service extensions are per-isolate: resolve the main isolate via getVM
// first, then carry isolateId inside the request params.
const url = process.argv[2];
const params = process.argv[3] ?? '{}';
if (!url) { console.error('usage: node register_e2e.mjs <vmServiceUrl> [jsonParams]'); process.exit(2); }

const wsUrl = new URL(url);
const scheme = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const wsAddr = `${scheme}//${wsUrl.host}${wsUrl.pathname.replace(/\/$/, '')}/ws${wsUrl.search}`;

let pending = null;
let idSeq = 0;

function rpc(method, rpcParams) {
  const id = `r${++idSeq}`;
  return new Promise((resolve, reject) => {
    pending = { id, resolve, reject, method };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: rpcParams ?? {} }));
  });
}

const ws = new WebSocket(wsAddr);
const timer = setTimeout(() => { console.error('TIMEOUT waiting for VM service response'); process.exit(1); }, 8000);
ws.onopen = async () => {
  try {
    const vm = await rpc('getVM');
    const isolates = vm.result?.isolates ?? [];
    const main = isolates.find((i) => i.name === 'main') ?? isolates[0];
    if (!main) throw new Error('no isolate found');
    console.log('isolate:', main.id, main.name);
    const resp = await rpc('ext.pai.debug.registerFill', { isolateId: main.id, ...JSON.parse(params) });
    console.log('response:', JSON.stringify(resp));
    clearTimeout(timer);
    ws.close();
    process.exit(resp.error ? 1 : 0);
  } catch (e) {
    clearTimeout(timer);
    console.error('FAILED:', e.message ?? e);
    process.exit(1);
  }
};
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (pending && msg.id === pending.id) {
    const p = pending;
    pending = null;
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg);
  }
};
ws.onerror = (e) => { clearTimeout(timer); console.error('WS error', e.message ?? e); process.exit(1); };
