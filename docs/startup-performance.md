# Startup performance

How long this server takes to become usable, where that time goes, and how to measure it on your own machine.

Background reading in the README: [Troubleshooting → MCP server connection times out](../README.md#troubleshooting). This page is the deeper version, for anyone changing dependencies or debugging a timeout.

## Why it matters

Claude Code enforces a fixed 30000ms timeout on a stdio MCP connection. You can see the budget in its own log line:

```
Starting connection with timeout of 30000ms
```

There is no setting to raise it. If the server cannot finish its handshake inside that window the connection is dropped and every tool in this package disappears from the session. So startup time is not a nice-to-have here, it is a correctness constraint.

## The two launch paths

The MCP `command` in your client config decides which one you get.

| config | what runs |
| --- | --- |
| `npx -y google-tools-mcp` | npx re-resolves and verifies the whole dependency tree, then launches the server |
| `node <path>/dist/index.js` | the server, directly |

`npx` does the resolve work on **every launch**, not just the first, even when the exact version is already in the local cache. The launcher chain it produces is five processes deep:

```
claude.exe
└─ cmd /d /s /c "npx -y google-tools-mcp"
   └─ node .../npm/bin/npx-cli.js -y google-tools-mcp
      └─ cmd /d /s /c google-tools-mcp
         └─ node .../_npx/<hash>/node_modules/google-tools-mcp/dist/index.js
```

Four of those five are pure launcher overhead. The setup wizard installs globally and writes the direct path for this reason.

## Measured numbers

One Windows 11 machine, node v22.22.3, `google-tools-mcp@2.0.0`, warm npm cache. Single machine, so treat the absolute values as illustrative and the ratios as the point.

**Client-reported time to connect, via `npx`:**

```
20443ms
28433ms
```

**Server boot, launched directly, reading the server's own ready line:**

```
11211ms   (first run, cold page cache)
 7449ms
 8362ms
```

So dropping `npx` is worth roughly 12 to 20 seconds. That is the difference between comfortably inside the budget and losing the race.

**Where the remaining time goes.** Timing the three top-level imports in isolation:

```
googleapis: 6054ms   fastmcp: 1561ms   zod: 3ms
googleapis: 8403ms   fastmcp: 1683ms   zod: 4ms
```

These numbers were measured while `fastmcp` was still the runtime. It was removed in the 2026-07-28 migration and replaced by `@modelcontextprotocol/server` + `@modelcontextprotocol/node`, so its ~1.6s line is historical; re-measure with the snippet below before quoting a total. The conclusion is unchanged, because it was never about the MCP framework:

`import('googleapis')` is about 80% of server startup and essentially all of the variance. It is module resolution and evaluation across the umbrella package's 196MB and 1823 files, paid on every launch, warm cache included. Tracked in [issue #71](https://github.com/karthikcsq/google-tools-mcp/issues/71), which proposes swapping to the per-API `@googleapis/*` packages.

The practical read: after removing `npx`, roughly 8 to 11 seconds of the 30 second budget is gone before the server can answer a handshake, on a machine with nothing else wrong with it. Slow disks, antivirus real-time scanning, or a cold page cache consume the rest of the margin.

## How to measure it yourself

### 1. Client-reported connect time

For Claude Code, per-server logs are JSONL, one object per line:

- **Windows:** `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project-slug>\mcp-logs-google\*.jsonl`
- **macOS:** `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-google/*.jsonl`
- **Linux:** `~/.cache/claude-cli-nodejs/<project-slug>/mcp-logs-google/*.jsonl`

Look for `Successfully connected (transport: stdio) in ...ms` or `Connection timeout triggered after ...ms`.

### 2. Server boot time, in isolation

Spawn the server yourself and watch stderr. Hold the process open, since it exits when stdin closes:

```js
// timeboot.mjs
import { spawn } from 'child_process';
const t = Date.now();
const p = spawn(process.execPath, ['<path>/dist/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
p.stderr.on('data', (d) => {
  if (/running using stdio/i.test(d.toString())) console.log('ready in', Date.now() - t, 'ms');
});
setTimeout(() => p.kill(), 15000);
```

This number excludes the launcher entirely. Compare it against the client-reported time from step 1: the gap is your launcher overhead.

### 3. Import cost attribution

From the installed package directory:

```bash
node --input-type=module -e "
const t0=Date.now(); await import('googleapis');
const t1=Date.now(); await import('@modelcontextprotocol/server');
const t2=Date.now(); await import('zod');
console.log('googleapis: '+(t1-t0)+'ms  mcp-sdk: '+(t2-t1)+'ms  zod: '+(Date.now()-t2)+'ms');
"
```

Run it twice. The first run pays for cold page cache; the second is the real recurring cost.

## Gotcha: the ready line is not in the Claude Code log

The server logs its own startup time on its first ready line:

```
MCP Server running using stdio in 8362ms. Awaiting client connection...
```

That line is real, but you will not find it in `mcp-logs-google/*.jsonl`. Claude Code stops capturing the server's stderr the instant the handshake completes, and the ready line prints microseconds after. Checked across 18 log files spanning several versions: zero occurrences.

So the README's advice to compare the server's self-reported startup against the client-reported connect time cannot be followed inside Claude Code. Use method 2 above instead. Tracked in [issue #78](https://github.com/karthikcsq/google-tools-mcp/issues/78).

## If you are changing dependencies

Any new top-level import is paid on every launch by every user, against a budget that is already about a third consumed. Before adding one, time it with method 3. Prefer a lazy `await import()` inside the tool that needs it over a module-level import, so the cost lands on first use instead of on startup.

## Related issues

- [#46](https://github.com/karthikcsq/google-tools-mcp/issues/46) — original report of npx losing the race against the 30s timeout
- [#71](https://github.com/karthikcsq/google-tools-mcp/issues/71) — swap umbrella `googleapis` for per-API `@googleapis/*` packages
- [#78](https://github.com/karthikcsq/google-tools-mcp/issues/78) — startup timing is not visible where the README says to look
- [#80](https://github.com/karthikcsq/google-tools-mcp/issues/80) — setup wizard leaves an existing config on `npx`
