'use strict';
const { classify } = require('./classify');
const DECODER = new TextDecoder('utf-8', { fatal: true });

// Line-framed stdout filter. Valid JSON-RPC lines are passed on byte-for-byte.
// Everything else goes to onNoise. Suspected corrupted frames go to onCorrupt
// and are never forwarded or silently dropped.
class StdoutFilter {
  constructor({ onRpc, onNoise, onCorrupt, allowBatch = false, maxLineBytes = 16 * 1024 * 1024 }) {
    this.allowBatch = allowBatch;
    this.onRpc = onRpc;
    this.onNoise = onNoise;
    this.onCorrupt = onCorrupt;
    this.maxLineBytes = maxLineBytes;
    this.chunks = [];
    this.size = 0;
    this.stats = { rpc: 0, noise: 0, noiseBytes: 0, corrupt: 0 };
    this.overflow = false;
  }

  push(buf) {
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) {
        const rest = buf.subarray(start);
        if (rest.length) {
          this.chunks.push(rest);
          this.size += rest.length;
          if (this.size > this.maxLineBytes) this._overflow();
        }
        return;
      }
      this.chunks.push(buf.subarray(start, nl));
      this.size += nl - start;
      start = nl + 1;
      this._emit(true);
    }
  }

  end() {
    if (this.size > 0) this._emit(false);
  }

  _overflow() {
    // A line this long is not a sane protocol frame; report it, do not buffer forever.
    this.overflow = true;
    this.stats.corrupt++;
    this.onCorrupt(`line longer than ${this.maxLineBytes} bytes without a newline`, true);
    this.chunks = [];
    this.size = 0;
  }

  _emit(hadNewline) {
    const raw = Buffer.concat(this.chunks);
    this.chunks = [];
    this.size = 0;
    let line;
    try { line = DECODER.decode(raw); } catch (_) {
      // Not valid UTF-8: MCP requires UTF-8, so this cannot be a protocol message.
      this.stats.noise++;
      this.stats.noiseBytes += raw.length;
      this.onNoise('<invalid UTF-8, ' + raw.length + ' bytes>');
      return;
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const kind = classify(line, { allowBatch: this.allowBatch });
    if (kind === 'empty') return;
    if (kind === 'rpc') {
      this.stats.rpc++;
      this.onRpc(line.trim(), hadNewline);
    } else if (kind === 'batch') {
      this.stats.corrupt++;
      this.onCorrupt('JSON-RPC batch received, but batching is not part of MCP 2025-06-18 or later (use --allow-batch for 2025-03-26 servers)', true);
    } else if (kind === 'corrupt') {
      this.stats.corrupt++;
      this.onCorrupt(line, false);
    } else {
      this.stats.noise++;
      this.stats.noiseBytes += Buffer.byteLength(line);
      this.onNoise(line);
    }
  }
}

module.exports = { StdoutFilter };
