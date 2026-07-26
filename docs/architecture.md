# How this repo works

Orientation for anyone changing the code. The user-facing guide is the top-level [README](../README.md); this page is about the internals.

## The thing that surprises everyone: `dist/` is the source

There is no build step. No TypeScript, no bundler, no transpile. `dist/*.js` is plain JavaScript ESM, hand-edited, and it is what ships. You edit `dist/`, you run `dist/`, npm publishes `dist/`.

Two consequences worth internalizing:

- `package.json` has `"files": ["dist"]`, so nothing outside `dist/` reaches the published package. Tests, scripts, and docs are repo-only.
- Some files under `dist/` still carry a stale header comment naming a `src/*.ts` path (for example `dist/types.js` opens with `// src/types.ts`). That is leftover from before the fork. No such source file exists. Ignore the comment and edit the `.js`.

## Entry point

`dist/index.js` is the `bin` target (`google-tools-mcp`) and the thing every MCP client launches.

It dispatches on `process.argv[2]` before doing anything else:

- `setup` → lazily imports `dist/setup.js` and runs the guided wizard (`dist/index.js:29`)
- `auth` → runs the OAuth flow only (`dist/index.js:41`)
- anything else → starts the MCP server

Both subcommands are dynamic imports, so the wizard's dependencies are not paid for on a normal server launch.

## Transports

stdio by default, which is what every desktop MCP client uses. HTTP is opt-in through the environment:

| variable | default | meaning |
| --- | --- | --- |
| `GOOGLE_MCP_TRANSPORT` | `stdio` | `http` or `httpStream` selects the long-lived HTTP server |
| `GOOGLE_MCP_PORT` | `3939` | HTTP port |
| `GOOGLE_MCP_ENDPOINT` | `/mcp` | HTTP path |
| `GOOGLE_MCP_HTTP_TOKEN` | generated per run | bearer token; set it to keep it stable across restarts |
| `GOOGLE_MCP_HTTP_NO_AUTH` | unset | disables auth, refuses to combine with a non-loopback host |

The HTTP path is guarded in `dist/httpAuth.js`, which is also where the non-loopback-plus-no-auth combination is rejected rather than quietly accepted.

## Tool registration

`dist/tools/index.js` owns this. Tools are grouped into **12 categories**, each with an `async loader(server)` that dynamically imports its modules:

```
files          documents      spreadsheets   email
email_threads  email_labels   email_settings calendar
forms          slides         tasks          maps
```

Each category maps to a directory under `dist/tools/`. The loaders are `await import()` rather than top-level imports, which keeps the module graph lazy at the category level.

**Every tool is wrapped before registration.** `registerAllTools` monkey-patches the server's `addTool` (`dist/tools/index.js:100-118`) so each tool's `execute` gets three behaviors for free:

1. **Session binding** — `runWithSession(args[1]?.sessionId ?? null, ...)` so per-session state, like the read-before-edit tracker in `dist/readTracker.js`, stays isolated across concurrent HTTP clients. Under stdio there is one client and `sessionId` is undefined, which maps to the default namespace.
2. **Auth retry** — `withAuthRetry` transparently refreshes and retries once on an auth failure, so an expired access token does not surface as a tool error.
3. **Error hints** — `appendHintToError(err, toolName)` attaches actionable guidance to the thrown error.

If you are adding a tool, you get all three by registering through the normal path. Do not call the underlying `addTool` directly.

## Adding a tool

1. Create the module under the right `dist/tools/<category>/` directory, exporting a `register(server)` (or a named `registerXTools(server)` matching the directory's convention).
2. Wire it into that category's `index.js`, or into the category loader in `dist/tools/index.js` if the directory has no index.
3. Add a test under `tests/`.
4. Update the tool counts in the README. They have drifted before, see [issue #72](https://github.com/karthikcsq/google-tools-mcp/issues/72).

Mind the startup cost: a new top-level import is paid by every user on every launch. See [startup-performance.md](startup-performance.md).

## Auth and config

`dist/auth.js` exports `getConfigDir`, `getTokenPath`, `SCOPES`, `authorize`, and `runAuthFlow`.

Everything lives in one directory, `~/.config/google-tools-mcp/`:

- `.env` — `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, written by the setup wizard
- `token.json` — the refresh token and granted scopes
- `credentials.json` — alternative credential source, supported instead of `.env`

Auth is deferred. The server starts and completes its MCP handshake without touching Google; the first tool call triggers `authorize()`. This is deliberate, since the handshake races a fixed 30 second client timeout.

## Dependencies

`fastmcp` (the MCP server framework), `googleapis`, `google-auth-library`, `zod` for schemas, `@clack/prompts` + `chalk` for the wizard, and `markdown-it` / `diff` / `mammoth` / `pdf-parse` for document conversion.

`googleapis` dominates startup cost. Before adding anything at the top level, read [startup-performance.md](startup-performance.md).

## Tests

34 files under `tests/`, jest, ESM.

```bash
npm test              # node --experimental-vm-modules .../jest.js
npm run test:ci       # same, with --ci --coverage
```

The `--experimental-vm-modules` flag is required. A bare `npx jest` fails on `import` syntax.

## Running a single tool locally

```bash
npm run local:tool
```

`scripts/call-local-tool.js` invokes a tool directly against `dist/tools/index.js`, no MCP client involved. Useful for iterating on one tool without restarting a client.

## Running the whole server from a clone

```bash
npm install
npm start        # equivalent to: node dist/index.js
```

Do **not** use `npx .` for this. Passing a path to npx creates a `file:` dependency, which npm links rather than copies, leaving a junction in the npx cache that points back at your clone. On Windows a later recursive delete follows that junction into the working tree. Use `npm start` or `node dist/index.js`.

## Releasing

See [RELEASING.md](../RELEASING.md). Publishing runs through `.github/workflows/publish.yml` and is gated on the `npm-publish` GitHub environment.
