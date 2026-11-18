'use strict';
// Decide what a single stdout line is.
//  "rpc"     valid JSON-RPC 2.0 message (or a batch of them when allowBatch)
//  "batch"   a valid JSON-RPC batch while allowBatch is off
//  "noise"   anything else (banner, debug print, log line)
//  "corrupt" looks like a protocol frame but is not valid JSON (e.g. cut off or interleaved)
const FRAME_START = /^\s*(\[\s*)?\{\s*"jsonrpc"\s*:/;

// JSON-RPC 2.0 shape: request/notification has a string "method";
// a response has an "id" and exactly one of "result" / "error".
function isMessage(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o) || o.jsonrpc !== '2.0') return false;
  if (typeof o.method === 'string') return true;
  return 'id' in o && ('result' in o) !== ('error' in o);
}

// Batches were allowed in MCP 2025-03-26 and removed from 2025-06-18 onward,
// so they are only treated as protocol traffic when allowBatch is set.
function classify(line, { allowBatch = false } = {}) {
  const text = line.trim();
  if (text === '') return 'empty';
  if (text[0] === '{' || text[0] === '[') {
    try {
      const v = JSON.parse(text);
      if (isMessage(v)) return 'rpc';
      if (Array.isArray(v) && v.length > 0 && v.every(isMessage)) return allowBatch ? 'rpc' : 'batch';
    } catch (_) {
      if (FRAME_START.test(text)) return 'corrupt';
    }
  }
  return 'noise';
}

module.exports = { classify };
