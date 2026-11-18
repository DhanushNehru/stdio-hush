'use strict';
const { spawn } = require('child_process');
const os = require('os');
const { StdoutFilter } = require('./filter');

const HELP = `stdio-hush [options] -- <command> [args...]

Runs an MCP stdio server and keeps its stdout limited to JSON-RPC messages.
Valid JSON-RPC 2.0 lines pass through unchanged. Any other stdout line
(banner, debug print) is dropped from stdout and counted. By default its
text is NOT echoed anywhere, because it may contain secrets.

Options:
  --show-noise     print the dropped lines to stderr (opt in; may expose secrets)
  --strict         exit 70 if any non-protocol line was seen
  --allow-batch    pass JSON-RPC batch arrays (MCP 2025-03-26 only)
  --max-line <n>   largest allowed line in bytes (default 16777216)
  -h, --help       show this help

A line that looks like a broken protocol frame, or a batch without
--allow-batch, is never forwarded or hidden: the server is stopped and
hush exits 70. Otherwise the exit code follows the server.`;

function parseArgs(argv) {
  const o = { strict: false, showNoise: false, allowBatch: false, maxLine: 16 * 1024 * 1024, cmd: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--show-noise') o.showNoise = true;
    else if (a === '--allow-batch') o.allowBatch = true;
    else if (a === '--max-line') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1024) throw new Error('--max-line needs an integer of at least 1024');
      o.maxLine = n;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else break;
  }
  o.cmd = argv.slice(i);
  return o;
}

function run(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((resolve) => {
    let opts;
    try { opts = parseArgs(argv); } catch (e) {
      stderr.write(`stdio-hush: ${e.message}\n`);
      return resolve(2);
    }
    if (opts.help) { stdout.write(HELP + '\n'); return resolve(0); }
    if (opts.cmd.length === 0) {
      stderr.write('stdio-hush: missing command after --\n' + HELP + '\n');
      return resolve(2);
    }

    let fatal = false;
    let killTimer = null;
    let waitingDrain = false;
    const child = spawn(opts.cmd[0], opts.cmd.slice(1), {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });

    const stopChild = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
      killTimer.unref();
    };

    const filter = new StdoutFilter({
      maxLineBytes: opts.maxLine,
      allowBatch: opts.allowBatch,
      onRpc: (line) => {
        // Respect backpressure: stop reading the child until the client drains.
        if (!stdout.write(line + '\n') && !waitingDrain) {
          waitingDrain = true;
          child.stdout.pause();
          stdout.once('drain', () => { waitingDrain = false; child.stdout.resume(); });
        }
      },
      onNoise: (line) => {
        if (opts.showNoise) stderr.write(`[hush] dropped from stdout: ${line}\n`);
      },
      onCorrupt: (info, isMessage) => {
        if (fatal) return;
        fatal = true;
        const detail = isMessage ? info : `a line of ${Buffer.byteLength(info)} bytes that starts like a JSON-RPC message but is not valid JSON` + (opts.showNoise ? `: ${info.slice(0, 300)}` : '');
        stderr.write(`[hush] ERROR: stopping the server. stdout contained ${detail}\n`);
        stopChild();
      },
    });

    child.stdout.on('data', (d) => { if (!fatal) filter.push(d); });
    child.stdout.on('end', () => { if (!fatal) filter.end(); });

    stdin.on('error', () => {});
    child.stdin.on('error', () => {}); // child exited early
    stdin.pipe(child.stdin);

    // A client that wants to stop us sends a signal; pass it on and make sure
    // a server that ignores it does not outlive us (SIGKILL after 2 s).
    const fwd = (sig) => () => {
      try { child.kill(sig); } catch (_) {}
      if (!killTimer) {
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000);
        killTimer.unref();
      }
    };
    process.on('SIGINT', fwd('SIGINT'));
    process.on('SIGTERM', fwd('SIGTERM'));

    child.on('error', (err) => {
      stderr.write(`stdio-hush: could not start "${opts.cmd[0]}": ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      const s = filter.stats;
      if (s.noise > 0) {
        stderr.write(`[hush] dropped ${s.noise} non-protocol stdout line(s) (${s.noiseBytes} bytes); ${s.rpc} protocol message(s) passed through.${opts.showNoise ? '' : ' Use --show-noise to see the text (may contain secrets).'}\n`);
      }
      if (fatal) return resolve(70);
      if (opts.strict && s.noise > 0) return resolve(70);
      if (signal) return resolve(128 + (os.constants.signals[signal] || 0));
      resolve(code === null ? 1 : code);
    });
  });
}

module.exports = { run, parseArgs };
