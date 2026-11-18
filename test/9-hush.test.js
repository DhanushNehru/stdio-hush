'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { classify } = require('../src/classify');

const BIN = path.join(__dirname, '..', 'bin', 'stdio-hush.js');
const FIX = path.join(__dirname, 'fixtures', 'noisy.js');
const REQ = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';

function hush(mode, args = [], input = REQ) {
  return spawnSync(process.execPath, [BIN, ...args, '--', process.execPath, FIX], {
    input, env: { ...process.env, MODE: mode }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
}

test('classify: message shapes', () => {
  assert.strictEqual(classify('{"jsonrpc":"2.0","id":1,"result":{}}'), 'rpc');
  assert.strictEqual(classify('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}'), 'rpc');
  assert.strictEqual(classify('{"jsonrpc":"2.0","method":"notifications/x"}'), 'rpc');
  assert.strictEqual(classify('{"jsonrpc":"2.0","id":1,"result":1,"error":{}}'), 'noise');
  assert.strictEqual(classify('{"jsonrpc":"2.0","id":1}'), 'noise');
  assert.strictEqual(classify('{"jsonrpc":"2.0"}'), 'noise');
  assert.strictEqual(classify('{"jsonrpc":"2.0","id":1,"resu'), 'corrupt');
  assert.strictEqual(classify('{"foo":1}'), 'noise');
  assert.strictEqual(classify('[1,2,3]'), 'noise');
  assert.strictEqual(classify('[]'), 'noise');
  assert.strictEqual(classify('{"jsonrpc":"1.0","method":"a"}'), 'noise');
  assert.strictEqual(classify('hello'), 'noise');
  assert.strictEqual(classify('   '), 'empty');
  assert.strictEqual(classify('{not json'), 'noise');
});

test('classify: batches only with allowBatch', () => {
  const b = '[{"jsonrpc":"2.0","id":1,"result":1}]';
  assert.strictEqual(classify(b), 'batch');
  assert.strictEqual(classify(b, { allowBatch: true }), 'rpc');
});

test('drops noise from stdout, keeps protocol, does NOT echo text by default', () => {
  const r = hush('noise');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '{"jsonrpc":"2.0","id":1,"result":{"ok":true,"unicode":"héllo ✓"}}\n');
  assert.doesNotMatch(r.stderr, /dotenv|debug: got/);
  assert.match(r.stderr, /dropped 2 non-protocol stdout line\(s\)/);
});

test('secret-looking noise never appears on stderr or stdout by default', () => {
  const r = hush('secret');
  assert.doesNotMatch(r.stderr + r.stdout, /SECRET123/);
  assert.match(r.stderr, /dropped 1 non-protocol/);
});

test('--show-noise echoes the dropped text (explicit opt in)', () => {
  const r = hush('secret', ['--show-noise']);
  assert.match(r.stderr, /SECRET123/);
  assert.doesNotMatch(r.stdout, /SECRET123/);
});

test('clean server: nothing on stderr, output untouched', () => {
  const r = hush('clean');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
});

test('--strict exits 70 when noise was seen, protocol output still valid', () => {
  const r = hush('noise', ['--strict']);
  assert.strictEqual(r.status, 70);
  assert.match(r.stdout, /"ok":true/);
});

test('broken protocol frame is fatal, never forwarded, text hidden by default', () => {
  const r = hush('corrupt');
  assert.strictEqual(r.status, 70);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /not valid JSON/);
  assert.doesNotMatch(r.stderr, /"jsonrpc"/);
});

test('server that ignores SIGTERM is killed after corruption', () => {
  const t0 = Date.now();
  const r = hush('ignoreterm');
  assert.strictEqual(r.status, 70);
  assert.ok(Date.now() - t0 < 8000);
});

test('2 MB message passes intact', () => {
  const m = JSON.parse(hush('big').stdout);
  assert.strictEqual(m.result.blob.length, 2_000_000);
});

test('line over --max-line is fatal', () => {
  const r = hush('big', ['--max-line', '100000']);
  assert.strictEqual(r.status, 70);
  assert.match(r.stderr, /longer than 100000/);
});

test('batch is fatal by default, passes with --allow-batch', () => {
  const a = hush('batch');
  assert.strictEqual(a.status, 70);
  assert.strictEqual(a.stdout, '');
  assert.match(a.stderr, /batch/i);
  const b = hush('batch', ['--allow-batch']);
  assert.strictEqual(b.status, 0);
  assert.strictEqual(JSON.parse(b.stdout).length, 2);
});

test('CRLF framing normalised to LF', () => {
  assert.strictEqual(hush('crlf').stdout, '{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
});

test('child exit code propagated', () => {
  assert.strictEqual(hush('exit3').status, 3);
});

test('unterminated trailing text is counted, not lost silently', () => {
  const r = hush('partial-tail');
  assert.match(r.stderr, /dropped 1 non-protocol/);
  assert.strictEqual(r.stdout, '');
});

test('large stdin (5 MB single message) reaches the server intact', () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'x', params: { p: 'y'.repeat(5_000_000) } });
  const r = hush('echo', [], big + '\n');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(JSON.parse(r.stdout).result.len, big.length);
});

test('slow reader: 300k messages arrive complete and in order (backpressure)', async () => {
  const p = spawn(process.execPath, [BIN, '--', process.execPath, FIX], { env: { ...process.env, MODE: 'many' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let count = 0, last = -1, ordered = true, tail = '';
  p.stdout.on('data', async (d) => {
    p.stdout.pause();
    const lines = (tail + d.toString()).split('\n'); tail = lines.pop();
    for (const l of lines) { const i = JSON.parse(l).params.i; if (i !== last + 1) ordered = false; last = i; count++; }
    setTimeout(() => p.stdout.resume(), 1);
  });
  const code = await new Promise((r) => p.on('close', r));
  assert.strictEqual(code, 0);
  assert.strictEqual(count, 300000);
  assert.ok(ordered);
});

test('stdin EOF lets the server finish and hush exits cleanly', () => {
  const r = hush('clean', [], REQ);
  assert.strictEqual(r.status, 0);
});

test('SIGTERM to hush is forwarded to the server', async () => {
  const p = spawn(process.execPath, [BIN, '--', process.execPath, '-e', 'process.on("SIGTERM",()=>{console.error("got-term");process.exit(0)});setInterval(()=>{},1000);console.error("ready")'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; if (/ready/.test(err) && !p.killed) p.kill('SIGTERM'); });
  const code = await new Promise((r) => p.on('close', r));
  assert.match(err, /got-term/);
  assert.strictEqual(code, 0);
});

test('missing command / bad option / unstartable command', () => {
  assert.strictEqual(spawnSync(process.execPath, [BIN], { encoding: 'utf8' }).status, 2);
  assert.strictEqual(spawnSync(process.execPath, [BIN, '--nope', '--', 'x'], { encoding: 'utf8' }).status, 2);
  const r = spawnSync(process.execPath, [BIN, '--', 'definitely-not-a-real-binary-xyz'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 127);
  assert.match(r.stderr, /could not start/);
});

test('invalid UTF-8 line is dropped as noise, not forwarded altered', () => {
  const r = hush('badutf8');
  assert.match(r.stderr, /dropped 1 non-protocol/);
  assert.doesNotMatch(r.stdout, /\ufffd/);
});

test('SIGTERM to hush kills a server that ignores SIGTERM (after 2s)', async () => {
  const p = spawn(process.execPath, [BIN, '--', process.execPath, FIX], { env: { ...process.env, MODE: 'ignoreterm2' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; if (/ready/.test(err) && !p.killed) p.kill('SIGTERM'); });
  const t0 = Date.now();
  await new Promise((r) => p.on('close', r));
  assert.ok(Date.now() - t0 < 8000);
});
