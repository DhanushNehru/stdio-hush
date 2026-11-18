#!/usr/bin/env node
'use strict';
require('../src/cli').run(process.argv.slice(2)).then((code) => {
  // Do not call process.exit(): when stdout is a pipe, writes are async and
  // exiting early would drop queued output. Let the event loop drain instead.
  process.exitCode = code;
  process.stdin.unpipe();
  process.stdin.destroy();
});
