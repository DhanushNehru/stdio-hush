# stdio-hush

Runs an MCP stdio server and keeps its stdout limited to JSON-RPC messages.

The MCP stdio transport says a server must not write anything to stdout that is not a valid MCP message. Some servers do anyway (a dotenv banner, a debug `console.log`, a stray `print`). `stdio-hush` sits between the client and such a server and drops those lines from stdout, so the client only sees protocol messages.

```sh
# in your client config, put it in front of the real command
stdio-hush -- node ./server.js
```

## What it does

- Passes valid JSON-RPC 2.0 lines (request, notification, response) through unchanged.
- Drops any other stdout line and counts it. The text is **not** printed by default, because noisy output can contain secrets. Use `--show-noise` to print it to stderr.
- Never hides a broken frame. If a line starts like a JSON-RPC message but is not valid JSON, or a line exceeds `--max-line`, it stops the server and exits 70.
- JSON-RPC batches were removed from MCP in 2025-06-18, so a batch is treated as an error unless you pass `--allow-batch` (for 2025-03-26 servers).
- `--strict` exits 70 if any noise was seen, handy in CI.
- No traffic logging, no files written, no dependencies. Node 18+.

## What it does not do

- It does not fix the server. The right fix is to stop writing to stdout.
- It only knows newline-delimited stdio framing. It does not touch HTTP transports.
- Whether noise breaks a connection depends on the client. In testing, the official TypeScript and Python SDK clients kept working with a noisy server (Python logs a parse error for each noisy line); some other clients reportedly fail.
- Tested on Linux only. Windows launching (`npx`, `.cmd` shims) is not handled.

## Spec notes (checked against the 2026-07-28 and earlier stdio pages)

- Framing: one JSON-RPC message per line, UTF-8, no embedded newlines. Lines that are not valid UTF-8 are treated as noise.
- Server-initiated requests are not allowed on stdout in 2026-07-28 but were allowed in earlier revisions (sampling, elicitation, roots). `stdio-hush` does not judge message direction or version, so it passes requests through.
- Shutdown: the client closes stdin; `stdio-hush` passes end-of-input to the server and exits when the server exits. It does not force-kill a server after stdin closes (that is the client's job per the spec). If `stdio-hush` itself gets SIGINT/SIGTERM, it forwards the signal and sends SIGKILL after 2 seconds if the server is still running. If the client SIGKILLs `stdio-hush`, the server can be left running; this is not handled.
- stdin is passed through untouched. It is not validated.
- Windows and process-group/job-object handling are not implemented or tested.
