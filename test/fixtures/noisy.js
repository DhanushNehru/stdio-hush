// Fake MCP-ish stdio server. MODE env controls the misbehaviour.
const mode = process.env.MODE || 'noise';
if (mode === 'many') {
  // 300k small messages as fast as possible, then exit
  let n = 0; const N = 300000;
  (function pump() {
    let ok = true;
    while (n < N && ok) { ok = process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { i: n } }) + '\n'); n++; }
    if (n < N) process.stdout.once('drain', pump); else { process.stdout.end(); process.stdin.destroy(); }
  })();
  return;
}
if (mode === 'ignoreterm') {
  process.on('SIGTERM', () => {});
  process.stdout.write('{"jsonrpc":"2.0","id":1,"resu\n');
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'badutf8') { process.stdout.write(Buffer.from([0xff, 0xfe, 0x41, 0x0a])); }
if (mode === 'ignoreterm2') { process.on('SIGTERM', () => {}); console.error('ready'); setInterval(() => {}, 1000); return; }
if (mode === 'secret') console.log('API_KEY=sk-live-SECRET123');
if (mode === 'noise') console.log('[dotenv@17.0.0] injecting env (0) -- tip: quiet');
process.stdin.setEncoding('utf8');
let b = '';
process.stdin.on('data', (d) => {
  b += d;
  let i;
  while ((i = b.indexOf('\n')) >= 0) {
    const l = b.slice(0, i); b = b.slice(i + 1);
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (mode === 'noise') console.log('debug: got ' + m.method);
    if (mode === 'corrupt') {
      const full = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
      process.stdout.write(full.slice(0, 20) + '\n');
      return;
    }
    if (mode === 'big') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { blob: 'x'.repeat(2_000_000) } }) + '\n');
      continue;
    }
    if (mode === 'echo') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { len: l.length } }) + '\n'); continue; }
    if (mode === 'batch') {
      process.stdout.write(JSON.stringify([{ jsonrpc: '2.0', id: m.id, result: 1 }, { jsonrpc: '2.0', id: 99, result: 2 }]) + '\n');
      continue;
    }
    if (mode === 'crlf') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'ok' }) + '\r\n'); continue; }
    if (mode === 'exit3') { process.exit(3); }
    if (mode === 'partial-tail') { process.stdout.write('half a banner without newline'); process.exit(0); }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { ok: true, unicode: 'héllo ✓' } }));
  }
});
