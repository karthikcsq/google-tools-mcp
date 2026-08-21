# google-tools-mcp

The **easiest way** to connect your AI agent to Google Workspace.

**156 tools** for Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, Tasks, and Maps — all in one package. One install, one auth, and you're done.

```bash
npx -y google-tools-mcp setup
```

## Contents

- [Quick Start](#quick-start)
- [Tool Categories](#tool-categories)
- [Common Workflows](docs/workflows.md)
- [Local Working Copies](#local-working-copies)
- [Environment Variables](#environment-variables)
- [Shared HTTP mode](#shared-http-mode-one-server-for-many-clients)
- [Troubleshooting](#troubleshooting)
- [Development / Contributing](#development--contributing)

## Why google-tools-mcp?

- **One command to install.** No cloning repos, no building from source, no Docker. Just `npx -y google-tools-mcp setup` and it works.
- **One login for everything.** A single OAuth flow gives you Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, and Tasks. No juggling multiple tokens or servers.
- **Auth that stays out of your way.** No browser popup until your first tool call. After that, your token is saved and you won't be asked again.
- **Read anything in your Drive.** PDFs, Word docs (.docx), spreadsheets — your AI agent can read them directly. No extra setup.
- **156 tools, zero config.** Every tool is available the moment the server starts. Send emails, create Docs and Slides, manage Tasks and calendar events, build forms, search places — it's all there.
- **Switch between Google accounts.** Set a profile name and keep work and personal accounts completely separate.
- **No telemetry. No tracking. Fully open source.**

## Quick Start

You can be up and running in under 5 minutes.

### Guided Setup (recommended)

Run the setup wizard — it opens the right Google Cloud Console pages for you and saves your credentials automatically:

```bash
npx -y google-tools-mcp setup
```

The wizard walks you through:
1. Enabling all required Google APIs (opens in your browser)
2. Configuring the OAuth consent screen
3. Creating OAuth credentials
4. Authenticating with Google

The setup wizard can add the MCP server to Codex or Claude Code automatically when their CLIs are installed. You can also add it manually later (see [Step 3](#step-3-add-to-your-mcp-client) below).

### Manual Setup

<details>
<summary>Click to expand manual setup instructions</summary>

#### Step 1: Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Docs API**, **Google Sheets API**, **Google Drive API**, **Gmail API**, **Google Calendar API**, **Google Forms API**, **Google Slides API**, and **Google Tasks API**
4. Go to **OAuth consent screen** and configure it (External is fine for personal use). If your app's publishing status is **Testing** (the default), you must add your Google account as a test user — go to **OAuth consent screen** → **Test users** → **Add users** and enter your email. Without this, Google will block the OAuth flow with an "Access denied" or "app not verified" error.
5. Go to **Credentials** → **Create Credentials** → **OAuth Client ID**
6. Select **Desktop application** as the application type
7. Download the credentials or note your **Client ID** and **Client Secret**

#### Step 2: Provide Your Credentials

Choose **one** of the following methods (whichever you prefer):

#### Option A: Use `credentials.json`

Download the JSON file from Google Cloud Console and place it in either location:

```
~/.config/google-tools-mcp/credentials.json   (recommended — shared across projects)
./credentials.json                              (local to your project)
```

That's it — no env vars needed. The server will find it automatically.

#### Option B: Create a `.env` file

Create a `.env` file in either location:

```
~/.config/google-tools-mcp/.env   (recommended — shared across projects)
./.env                             (local to your project)
```

With the following contents:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_MCP_OAUTH_PORT=37547  # optional: fixed localhost callback port for remote OAuth
```

#### Option C: Set env vars in your MCP config

Add the credentials directly to your MCP configuration:

```json
{
  "mcpServers": {
    "google": {
      "command": "google-tools-mcp",
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

(Requires `npm install -g google-tools-mcp` first: see [Step 3](#step-3-add-to-your-mcp-client) and the [Troubleshooting](#troubleshooting) section for why `npx` isn't used here.)

> **Credential lookup order:** env vars → `~/.config/google-tools-mcp/.env` → project root `.env` → `~/.config/google-tools-mcp/credentials.json` → project root `credentials.json`

</details>

### Step 3: Add to Your MCP Client

#### Local unpublished checkout

To call a local tool directly without publishing or using MCP transport, use
`local:tool`. This loads the unpublished checkout, registers the real tools in
memory, validates the arguments, and calls the tool's `execute` function:

```bash
npm run local:tool -- list
npm run local:tool -- help
npm run local:tool -- readDocument documentId=... format=markdown
```

For larger arguments, put JSON in a file and pass it with `@`:

```bash
npm run local:tool -- replaceDocumentWithMarkdown @args.json
```

> **Why `npm install -g` instead of `npx`?** The guided setup wizard installs the package globally and points your MCP client straight at it, instead of using `npx -y google-tools-mcp`. `npx` re-resolves the whole dependency tree on every single launch, which can take 30+ seconds on some machines (this package pulls in the full `googleapis` client library). That's long enough to lose the race against Claude Code's fixed 30s stdio MCP connection timeout. See [Troubleshooting](#troubleshooting) below if you're setting this up by hand.

First, install once:

```bash
npm install -g google-tools-mcp
```

#### Codex

```bash
codex mcp add google -- google-tools-mcp
```

With env vars (Option C):

```bash
codex mcp add google \
  --env GOOGLE_CLIENT_ID=your-client-id \
  --env GOOGLE_CLIENT_SECRET=your-client-secret \
  -- google-tools-mcp
```

#### Claude Code

**User-scope** (available in all projects):

```bash
claude mcp add -s user google -- google-tools-mcp
```

**Project-scope** (available only in the current project):

```bash
claude mcp add google -- google-tools-mcp
```

With env vars (Option C):

```bash
# User-scope
claude mcp add -s user google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- google-tools-mcp

# Project-scope
claude mcp add google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- google-tools-mcp
```

#### Project-Local Installation (with profile)

Via the `claude` CLI:

```bash
claude mcp add -s user google \
  -e GOOGLE_MCP_PROFILE=myprofile \
  -- google-tools-mcp
```

Or manually in your `.mcp.json`:

```json
{
  "mcpServers": {
    "google": {
      "command": "google-tools-mcp",
      "env": {
        "GOOGLE_MCP_PROFILE": "myprofile"
      }
    }
  }
}
```

#### Other MCP clients

Add this to your MCP configuration (e.g., `.mcp.json`, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "google": {
      "command": "google-tools-mcp"
    }
  }
}
```

If using Option C, add an `"env"` block with your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

<details>
<summary>Prefer <code>npx</code> anyway, or can't install globally?</summary>

Every example above works with `npx -y google-tools-mcp` in place of `google-tools-mcp` (e.g. `codex mcp add google -- npx -y google-tools-mcp`). It requires no global install, but pays npx's dependency-resolution cost on every launch: see [Troubleshooting](#troubleshooting) for what that costs you.

</details>

### Step 4: Authenticate

On your first tool call, the server will automatically open your browser for Google OAuth consent. Sign in and grant access — the token is saved to `~/.config/google-tools-mcp/token.json` for future use.

**Remote MCP host / local browser:** Set `GOOGLE_MCP_OAUTH_PORT` to a fixed loopback port and create a persistent SSH local forward from the browser machine. See [Remote OAuth with a persistent SSH tunnel](docs/remote-oauth-tunnel.md).

You can also run the auth flow manually anytime:

```bash
npx google-tools-mcp auth
```

### Multi-Account Support

Set the `GOOGLE_MCP_PROFILE` env var to use separate tokens per profile:

```json
{
  "env": {
    "GOOGLE_MCP_PROFILE": "work"
  }
}
```

This stores tokens in `~/.config/google-tools-mcp/work/` instead of the default directory.

## Troubleshooting

### The `google` MCP server won't connect / "connection timed out"

**Symptom:** Claude Code (or another MCP client) reports that the `google` server failed to connect, timed out, or keeps disconnecting, with no other visible error. It may work sometimes and fail other times on the same machine.

**Cause:** If your MCP config launches the server with `npx -y google-tools-mcp`, `npx` re-resolves and verifies the entire dependency tree (this package pulls in the full `googleapis` client library, a large `node_modules`) on **every single launch**, not just the first. On some machines, especially Windows (likely antivirus real-time scanning of npm's file I/O during install/verify), this reliably takes 30-34 seconds, even when the exact version is already cached locally. Claude Code's stdio MCP connection timeout is a fixed 30 seconds, so `npx`-launched servers are right on the failure line and frequently lose the race.

Launching directly (`node dist/index.js`, or the global-install path below) is faster, but it is not a guarantee. Measured on one affected Windows machine on 2026-07-24, three runs each: `npx` took 23.0s, 25.3s and 24.6s, a direct `node` launch took 14.7s, 26.0s and 12.2s. So skipping `npx` is worth roughly 7 seconds on average and removes a large source of variance, but on a machine with slow disk I/O a direct launch can still come close to the limit. If it still times out after you switch, what is left is the cost of reading this package's dependency tree off disk, tracked in [issue #71](https://github.com/karthikcsq/google-tools-mcp/issues/71). Full writeup in [issue #46](https://github.com/karthikcsq/google-tools-mcp/issues/46), and see [docs/startup-performance.md](docs/startup-performance.md) for the per-import breakdown and how to measure any of this on your own machine.

**Where to look:** MCP clients that log per-server connection attempts will show the exact timing. For Claude Code, per-server logs live at:

- **Windows:** `%LOCALAPPDATA%\claude-cli-nodejs\Cache\<project-slug>\mcp-logs-google\*.jsonl`
- **macOS:** `~/Library/Caches/claude-cli-nodejs/<project-slug>/mcp-logs-google/*.jsonl`: the `claude-cli-nodejs` cache root and per-server log folder are corroborated by an independent user report ([anthropics/claude-code#18869](https://github.com/anthropics/claude-code/issues/18869)), though not confirmed with this exact server name
- **Linux:** `~/.cache/claude-cli-nodejs/<project-slug>/mcp-logs-google/*.jsonl` (same convention as macOS, under the XDG cache dir, and unconfirmed; if it's not there, check wherever `claude doctor` / your Claude Code version reports its cache directory)

Look for lines like `"Connection timeout triggered after ...ms"` or `"Successfully connected ... in ...ms"`. Claude Code captures the pre-handshake category line, such as `Loaded all 12 categories in 1123ms.`, which measures server startup before the connection completes. The later ready line remains useful when you run the server directly. If startup is fast but the client still reports a near-30000ms connection time, the delay is before the server process starts, commonly in `npx`.

For per-tool failures, see the [diagnostics runbook](docs/troubleshooting-runbook.md). It documents the redacted JSONL records written by default and how `troubleshoot` summarizes them.

**Fix:** Install the package globally and point your MCP client directly at it instead of using `npx`:

```bash
npm install -g google-tools-mcp
```

Then use `google-tools-mcp` (no `npx`) as the MCP `command`: see [Step 3](#step-3-add-to-your-mcp-client) for exact commands per client. Running `npx -y google-tools-mcp setup` does this for you automatically: the guided setup wizard installs the package globally and points the MCP entry straight at it. If the global install isn't possible on your machine (e.g. no write access to the global npm directory), it falls back to `npx`, but only if `npx` is actually on PATH, since a machine that can't reach npm usually can't reach npx either. If `npx` isn't there either, it falls back to launching whichever copy of the package is running the wizard right now. If none of the three works, it stops, explains why, and writes nothing to your MCP config rather than leaving you with a command that can't run.

### Updates stop arriving after switching off `npx`

**Cause:** `npx -y google-tools-mcp` re-resolves to whatever is currently published on every launch, so it auto-updates by accident. The global-install path above trades that away for startup speed: your MCP client launches a fixed `node <path>` command that points at whatever was installed the moment you ran setup, and nothing else ever runs `npm install -g` again on its own. Left alone, a global-install user keeps running that same version forever, missing every release after it.

**Fix:** Update it yourself whenever you like:

```bash
npm install -g google-tools-mcp@latest
```

(or just re-run `npx -y google-tools-mcp setup`, which does the same install and re-points your MCP config). The server also helps you notice: on startup, after the MCP connection is already established, it makes a strictly time-boxed (2s), non-blocking, at-most-once-per-24-hours check against the npm registry for the latest published version, and logs a one-line warning if you're behind. This check runs after the connection handshake and is never awaited, so a slow or unreachable network can't delay or reintroduce the `npx` startup-timeout race this section is about; worst case, it just never gets to print the notice.
## Development / Contributing

Contributor-facing deep dives live in [`docs/`](docs/README.md), indexed there.

`dist/` is the hand-edited source for this repository. It contains plain JavaScript; there is no TypeScript, bundler, or build step.

A few files under `dist/` still carry a leftover header comment naming a `src/*.ts` path (for example, `dist/types.js` starts with `// src/types.ts`) from before this repo was forked. No such source file exists here; treat the comment as stale and edit the `.js` file directly.

Run the server directly from a clone:

```bash
npm install
npm start
# Equivalent: node dist/index.js
```

To make an MCP client run the clone instead of the published package, use an absolute path in its configuration. Pin `command` to the absolute Node executable too, not a bare `node`: desktop and GUI MCP clients often launch with a minimal PATH that doesn't include `node` (this is especially common with nvm, volta, or fnm), even when `node` resolves fine in your own shell. Confirming `node` works in a terminal doesn't prove what the GUI client's process can resolve, since it may not inherit your shell's PATH at all, so hand it the resolved path directly. Get that path with:

```bash
node -p "process.execPath"
```

Then use that output as `command`:

```json
{
  "mcpServers": {
    "google": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/google-tools-mcp/dist/index.js"]
    }
  }
}
```

On Windows, write both paths with forward slashes (`C:/Users/you/google-tools-mcp/dist/index.js`) or escape backslashes (`C:\\Users\\...`) — a bare `C:\Users\...` is invalid JSON.

Alternatively, link the clone into npm's global executable directory, then configure the client with `"command": "google-tools-mcp"`. This has the same bare-command risk described above: a GUI client's PATH doesn't have to match your shell's, so after linking, resolve the absolute path once with `command -v google-tools-mcp` (macOS/Linux) or `where google-tools-mcp` (Windows) and put that path in `command` instead of the bare name.

```bash
cd /absolute/path/to/google-tools-mcp
npm install
npm link
```

Watch for source/runtime drift: editing a clone has no effect while the MCP client still launches `npx google-tools-mcp` or a separately installed global copy. Check the client's configured command and arguments, then use `command -v google-tools-mcp` (macOS/Linux) or `where google-tools-mcp` (Windows) to see which executable is selected. Restart the MCP client after changing its configuration or relinking.

## Tool Categories

### `files` (27 tools)
Google Drive file management and content reading.

`listDriveFiles`, `searchDocuments`, `getFileInfo`, `getFilePath`, `createFolder`, `listFolderContents`, `getFolderInfo`, `moveFile`, `copyFile`, `renameFile`, `deleteFile`, `createDocument`, `createDocumentFromTemplate`, `listSharedDrives`, `listSharedWithMe`, `downloadFile`, `uploadFile`, `listPermissions`, `addPermission`, `removePermission`, `updatePermission`, `listRevisions`, `getRevision`, `updateRevision`, `readFile`, `searchFileContents`, `readDriveFile`

### `documents` (22 tools)
Google Docs read/write/format with markdown support.

`readDocument`, `appendText`, `deleteRange`, `modifyText`, `findAndReplace`, `insertTable`, `insertTableWithData`, `insertPageBreak`, `insertImage`, `listTabs`, `addTab`, `renameTab`, `applyParagraphStyle`, `getFormatting`, `addComment`, `deleteComment`, `getComment`, `listComments`, `replyToComment`, `resolveComment`, `appendMarkdown`, `replaceDocumentWithMarkdown`

### `spreadsheets` (30 tools)
Google Sheets operations.

`readSpreadsheet`, `writeSpreadsheet`, `batchWrite`, `appendRows`, `clearRange`, `createSpreadsheet`, `getSpreadsheetInfo`, `addSheet`, `deleteSheet`, `duplicateSheet`, `renameSheet`, `formatCells`, `readCellFormat`, `autoResizeColumns`, `freezeRowsAndColumns`, `setColumnWidths`, `addConditionalFormatting`, `copyFormatting`, `setDropdownValidation`, `createTable`, `deleteTable`, `getTable`, `listTables`, `appendTableRows`, `updateTableRange`, `insertChart`, `deleteChart`, `groupRows`, `ungroupAllRows`, `deleteColumns`

### `email` (16 tools)
Gmail messages and drafts (hot-path tools stay granular).

`sendMessage`, `replyMessage`, `forwardMessage`, `getMessage`, `listMessages`, `modifyMessage`, `deleteMessage`, `trashMessage`, `batchGetMessages`, `getAttachment`, `createDraft`, `updateDraft`, `deleteDraft`, `getDraft`, `listDrafts`, `sendDraft`

### `email_threads` (6 tools)
Gmail thread-level operations.

`getThread`, `listThreads`, `batchGetThreads`, `modifyThread`, `deleteThread`, `trashThread`

### `email_labels` (1 tool)
Gmail label management, consolidated into one dispatch tool.

`manageLabel` (action: `create` | `patch` | `delete` | `get` | `list`)

### `email_settings` (6 tools)
Gmail admin and configuration, consolidated into dispatch tools.

`manageGmailSettings` (resource: `imap` | `pop` | `vacation` | `language` | `autoForwarding` | `forwardingAddress` | `delegate` | `sendAs`), `manageSmime`, `manageFilter`, `getProfile`, `watchMailbox`, `stopMailWatch`

### `calendar` (8 tools)
Google Calendar — events, availability, and calendar management.

`listCalendars`, `getEvents`, `manageEvent`, `getBusy`, `getFree`, `moveEvent`, `listRecurringEventInstances`, `manageCalendar`

> **Backward compatibility:** every former snake_case tool name (`get_imap`, `list_messages`, `manage_event`, …) is still available as a deprecated alias that forwards to its new implementation, but they are **opt-in, not loaded by default** — registering them by default would grow the tool surface these issues exist to shrink. Set `GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true` to register them. See [Gmail tool migration](#gmail-tool-migration-snake_case--camelcase).

### `forms` (6 tools)
Google Forms — create/read forms, manage responses, and publish settings.

`create_form`, `get_form`, `batch_update_form`, `get_form_response`, `list_form_responses`, `set_publish_settings`

### `slides` (16 tools)
Google Slides presentation creation and editing.

`createPresentation`, `updatePresentation`, `getPresentation`, `formatSlidesText`, `formatSlidesParagraph`, `styleSlidesShape`, `setSlidesBackground`, `createSlidesTextBox`, `createSlidesShape`, `getSpeakerNotes`, `updateSpeakerNotes`, `deleteSlide`, `duplicateSlide`, `reorderSlides`, `replaceAllTextInSlides`, `exportSlideThumbnail`

### `tasks` (8 tools)
Google Tasks task-list and task management.

`listTaskLists`, `createTaskList`, `deleteTaskList`, `listTasks`, `createTask`, `updateTask`, `completeTask`, `deleteTask`

### `maps` (6 tools)
Google Maps and Places tools for geocoding, reverse geocoding, nearby and text search, place details, and directions.

`mapsGeocode`, `mapsReverseGeocode`, `mapsSearchNearby`, `mapsSearchPlaces`, `mapsPlaceDetails`, `mapsDirections`

These tools require `GOOGLE_MAPS_API_KEY`, a Google Maps Platform API key, separate from the Google OAuth credentials used everywhere else and not covered by the setup wizard or by [Step 1](#step-1-create-google-oauth-credentials) above. To get one: enable the **Geocoding API**, **Places API (New)**, and **Routes API** for your Google Cloud project, then go to **Credentials** → **Create Credentials** → **API key**, and set it as `GOOGLE_MAPS_API_KEY`. Without it, the `maps` tools are still listed, but calling any of them fails with a clear error telling you to set the key.

The categories above contain 152 service-specific tools. Four general utilities — `help`, `logout`, `troubleshoot`, and `feedback` — bring the default server surface to 156 tools. See [Common Workflows](docs/workflows.md) for practical examples.

## Local Working Copies

`readDocument` (markdown format) saves what it reads to a local working-copy file, keyed by document ID and tab, so you can edit that file directly and push it back with `replaceDocumentWithMarkdown` using `filePath` instead of pasting content inline. `replaceDocumentWithMarkdown` also mirrors any inline `markdown=` push into that same file, so it always reflects what's actually on the document.

If the document contains content markdown can't represent (images, footnotes, a generated table of contents, or other Docs elements with no markdown equivalent), `readDocument` appends a warning after the markdown listing exactly what a full `replaceDocumentWithMarkdown` push would permanently remove. Use `modifyText` or `appendMarkdown` instead for those documents.

These files live in a per-user directory under the OS temp dir (`google-tools-mcp-<user>`), created with restrictive permissions and checked on every write so a planted symlink is refused rather than followed. Set `GOOGLE_MCP_WORKSPACE_DIR` to use a different directory instead.

## Configuration

On startup, configuration is loaded from these locations in order. A value is
used from the first source that defines it:

| Priority | Source |
|---|---|
| 1 | Real process environment, including an explicitly empty value |
| 2 | User config: `~/.config/google-tools-mcp/.env` (or `$XDG_CONFIG_HOME/google-tools-mcp/.env`) |
| 3 | `.env` in the server's current working directory |
| 4 | `.env` at the installed package root |

`GOOGLE_MCP_PROFILE` selects the user config directory and must be set in the
real process environment. It is ignored if placed in a `.env` file, with a
startup warning. Missing config files are normal; an unreadable config file
produces a warning naming its path.

This user-scoped file is particularly useful on Windows. MCP clients launched
over stdio may not inherit a Windows user environment variable set after the
client was started, while they can still read this file. Environment variables
present in the spawned server always take precedence.

Keep `.env` readable only by your user: use `chmod 600` on POSIX. On Windows,
the default user-profile ACL is sufficient.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | No* | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | No* | OAuth 2.0 Client Secret |
| `GOOGLE_MCP_PROFILE` | No | Profile name for multi-account support (see above) |
| `GOOGLE_MCP_OAUTH_PORT` | No | Fixed loopback port for the interactive OAuth callback. Defaults to an ephemeral port; set a fixed port when forwarding the callback over SSH. See [Remote OAuth with a persistent SSH tunnel](docs/remote-oauth-tunnel.md). |
| `GOOGLE_MCP_TRANSPORT` | No | `stdio` (default) or `http`. Use `http` to run one shared server (see [Shared HTTP mode](#shared-http-mode-one-server-for-many-clients) and [docs/http-mode.md](docs/http-mode.md)) |
| `GOOGLE_MCP_PORT` | No | Port for HTTP transport (default `3939`) |
| `GOOGLE_MCP_ENDPOINT` | No | URL path for HTTP transport (default `/mcp`) |
| `GOOGLE_MCP_HTTP_TOKEN` | No | Overrides the private persistent HTTP token. Normally generated once at `<configDir>/http-token` and reused across restarts; never printed |
| `GOOGLE_MCP_HTTP_HOST` | No | Bind address for HTTP transport (default `127.0.0.1`). Only loopback hosts are accepted until supported TLS deployment exists |
| `GOOGLE_MCP_HTTP_ALLOWED_ORIGINS` | No | Comma-separated extra `Origin` values to accept (loopback origins are always allowed). Requests with a foreign browser `Origin` are otherwise rejected |
| `GOOGLE_MCP_HTTP_NO_AUTH` | No | Set to `1` to disable the bearer-token requirement. Only safe when you fully trust every process on the machine |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`, or `silent` |
| `GOOGLE_MCP_LOG_FILE` | No | Plain log path. Defaults to `~/.config/google-tools-mcp/server.log`; set `0`, `false`, or `off` to disable, or set a custom path |
| `GOOGLE_MCP_JSONL_FILE` | No | Structured tool-call JSONL path. Defaults to `~/.config/google-tools-mcp/server.jsonl` (or alongside a custom plain log); set `0`, `false`, or `off` to disable |
| `GOOGLE_MCP_ENABLE_LEGACY_ALIASES` | No | Set to `true` to register the deprecated snake_case tool aliases (off by default; see [Gmail tool migration](#gmail-tool-migration-snake_case--camelcase)) |
| `GOOGLE_MCP_WORKSPACE_DIR` | No | Overrides where local working copies of Google Docs are saved (see [Local working copies](#local-working-copies)). Defaults to a per-user directory under the OS temp dir |
| `SERVICE_ACCOUNT_PATH` | No | Path to service account JSON key (alternative to OAuth) |
| `GOOGLE_IMPERSONATE_USER` | No | Email to impersonate with service account |
| `GOOGLE_MCP_NO_UPDATE_CHECK` | No | Set to any value to skip the background check for a newer published version |
| `NO_UPDATE_NOTIFIER` | No | Same effect as `GOOGLE_MCP_NO_UPDATE_CHECK`, following the npm-ecosystem-standard opt-out name from the `update-notifier` package |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps Platform API key (separate from OAuth). Without it, `maps` tools remain listed but fail with a clear error when called |

\* Not required as env vars if you provide credentials via `.env` file or `credentials.json` (see [Step 2](#step-2-provide-your-credentials)).

The background version check is also skipped automatically when `CI` is set to anything other than `false`, so automated test runs never make an unannounced outbound call.

## Shared HTTP mode (one server for many clients)

By default the server uses **stdio** transport: each MCP client spawns its own
`google-tools-mcp` process. If you run several clients at once (e.g. many editor
or agent sessions), that's one Node process per session, each holding memory.

Run setup and choose **One shared loopback server**, or manage it directly with
the supported lifecycle commands:

```bash
google-tools-mcp start
google-tools-mcp status
google-tools-mcp restart
google-tools-mcp stop
```

`start` attaches when the configured profile already has a healthy managed
instance. `serve` is the foreground command for login items and service
managers. State is published atomically to `<configDir>/http-server.json`; the
stable 0600 bearer token lives at `<configDir>/http-token`. An occupied foreign
port fails with a `GOOGLE_MCP_PORT` remedy instead of silently changing URLs.

Setup writes the different native client shapes: Claude Code gets an HTTP URL
and authorization header, while Codex gets the URL plus
`--bearer-token-env-var GOOGLE_MCP_HTTP_TOKEN`. Setup probes authenticated MCP
discovery before changing either entry, so it never reports success over a dead
server. See [the operations reference](docs/http-mode.md) for native manual
registration and start-at-login examples.

### Breaking change in 3.0.0: HTTP is stateless

The server speaks MCP **2026-07-28** on the official MCP TypeScript SDK v2. The
whole HTTP session lifecycle is gone. **stdio is unaffected** — if you don't set
`GOOGLE_MCP_TRANSPORT`, nothing in your config needs to change.

Removed, all returning `404` after the auth check:

- `GET /sse` and its `POST /messages` companion (the legacy SSE compatibility
  transport the old runtime always stood up).
- `GET /ping`, the old unauthenticated liveness route. Use authenticated
  `GET /healthz`, which returns exactly `{"status":"ok"}`.
- The `GET` that attached to a session's event stream and the `DELETE` that
  terminated a session.
- The `Mcp-Session-Id` header. It is never required and never returned.

What's left is one `POST` endpoint (`GOOGLE_MCP_ENDPOINT`, default `/mcp`) plus
authenticated `GET /healthz`.

The consequence for tools: **read state is never carried between HTTP
requests.** Google Docs edits over HTTP take an explicit `readHandle` returned
by `readDocument` — opaque, server-minted, single-use for a mutation, bound to
the credential, profile, file, tab, revision, and structure, and expiring in
under 24 hours. `writeSpreadsheet`, `batchWrite`, `clearSpreadsheetRange`, and
`deleteFile` have no handle wiring yet and fail closed over HTTP; use stdio for
those.

Full reference, including exact Claude Code and Codex reconfiguration steps (and
the `CODEX_MCP_PROTOCOL_VERSION=2026-07-28` env entry Codex needs):
**[docs/http-mode.md](docs/http-mode.md)**.

### Security

The HTTP endpoint exposes your **authenticated** Google Workspace tool surface
(Gmail, Drive, Calendar, Docs, ...). It is guarded so it can't be driven by other
processes or by web pages on your machine:

- **Bearer token required, on every route.** Every request must send
  `Authorization: Bearer <token>`. One middleware runs ahead of routing, so the
  MCP endpoint, `/healthz`, and the `404` for every other path are all gated
  identically — an unauthenticated caller can't even probe which paths exist.
  A random token is generated once in the private config directory and reused;
  it is never printed or logged. `GOOGLE_MCP_HTTP_TOKEN` overrides that file.
  Requests without a valid token get `401`.
- **Loopback only.** Binds to `127.0.0.1` by default, so the port isn't reachable
  from the network. Non-loopback hosts are refused in every token mode until a
  supported TLS deployment boundary exists. Empty or whitespace-only hosts are
  refused too.
- **Origin checked.** Requests carrying a non-loopback browser `Origin` are
  rejected (DNS-rebinding protection). Add trusted origins via
  `GOOGLE_MCP_HTTP_ALLOWED_ORIGINS` if needed.

Notes:
- Use `google-tools-mcp serve` in a login item or user service. Cross-platform
  examples and failure recovery are in [docs/http-mode.md](docs/http-mode.md).
- Read-before-edit state is scoped to a single HTTP request and dies with it, so
  clients can't satisfy or clobber each other's guard state. They still share one
  process and one OAuth/token state, so a crash or token expiry affects everyone.
- One process serves one configured Google profile and one effective service
  principal. Multiple profiles or horizontal scale are out of scope for this
  release.
- stdio remains the setup default; shared HTTP is explicit opt-in.

## Migrating from gdrive-tools-mcp / gmail-tools-mcp

This package replaces both [`gdrive-tools-mcp`](https://www.npmjs.com/package/gdrive-tools-mcp) and [`gmail-tools-mcp`](https://www.npmjs.com/package/gmail-tools-mcp). To migrate:

1. Replace both MCP server entries with a single `google-tools-mcp` entry
2. Re-authenticate (the combined server uses its own config dir at `~/.config/google-tools-mcp/`)
3. All tools are available immediately — no discovery step needed

## Gmail tool migration (snake_case → camelCase)

Gmail and Calendar tools were unified to camelCase, and the rarely-used Gmail
account-config tools were consolidated into dispatch tools. **Every old name
still works** as a deprecated alias that forwards to the new implementation,
but the aliases are **opt-in** — they are not registered by default, since
loading all 72 of them alongside the new camelCase + dispatch tools would grow
the default tool surface instead of shrinking it. Set
`GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true` if you still depend on the old
snake_case names.

### Renamed (behavior and parameters unchanged)

| Old name | New name |
|---|---|
| `send_message` | `sendMessage` |
| `reply_message` | `replyMessage` |
| `forward_message` | `forwardMessage` |
| `get_message` | `getMessage` |
| `list_messages` | `listMessages` |
| `modify_message` | `modifyMessage` |
| `delete_message` | `deleteMessage` |
| `trash_message` | `trashMessage` |
| `batch_get_messages` | `batchGetMessages` |
| `get_attachment` | `getAttachment` |
| `create_draft` | `createDraft` |
| `update_draft` | `updateDraft` |
| `delete_draft` | `deleteDraft` |
| `get_draft` | `getDraft` |
| `list_drafts` | `listDrafts` |
| `send_draft` | `sendDraft` |
| `get_thread` | `getThread` |
| `list_threads` | `listThreads` |
| `batch_get_threads` | `batchGetThreads` |
| `modify_thread` | `modifyThread` |
| `delete_thread` | `deleteThread` |
| `trash_thread` | `trashThread` |
| `get_profile` | `getProfile` |
| `watch_mailbox` | `watchMailbox` |
| `stop_mail_watch` | `stopMailWatch` |
| `list_calendars` | `listCalendars` |
| `get_events` | `getEvents` |
| `manage_event` | `manageEvent` |
| `get_busy` | `getBusy` |
| `get_free` | `getFree` |
| `move_event` | `moveEvent` |
| `list_recurring_event_instances` | `listRecurringEventInstances` |
| `manage_calendar` | `manageCalendar` |

### Consolidated into dispatch tools

| Old name(s) | New dispatch call |
|---|---|
| `get_imap` / `update_imap` | `manageGmailSettings` resource=`imap` action=`get`/`update` |
| `get_pop` / `update_pop` | `manageGmailSettings` resource=`pop` action=`get`/`update` |
| `get_vacation` / `update_vacation` | `manageGmailSettings` resource=`vacation` action=`get`/`update` |
| `get_language` / `update_language` | `manageGmailSettings` resource=`language` action=`get`/`update` |
| `get_auto_forwarding` / `update_auto_forwarding` | `manageGmailSettings` resource=`autoForwarding` action=`get`/`update` |
| `list_forwarding_addresses` / `get_forwarding_address` / `create_forwarding_address` / `delete_forwarding_address` | `manageGmailSettings` resource=`forwardingAddress` action=`list`/`get`/`create`/`delete` |
| `list_delegates` / `get_delegate` / `add_delegate` / `remove_delegate` | `manageGmailSettings` resource=`delegate` action=`list`/`get`/`create`/`delete` |
| `list_send_as` / `get_send_as` / `create_send_as` / `patch_send_as` / `update_send_as` / `delete_send_as` / `verify_send_as` | `manageGmailSettings` resource=`sendAs` action=`list`/`get`/`create`/`patch`/`update`/`delete`/`verify` |
| `list_smime_info` / `get_smime_info` / `insert_smime_info` / `delete_smime_info` / `set_default_smime_info` | `manageSmime` action=`list`/`get`/`insert`/`delete`/`setDefault` |
| `list_filters` / `get_filter` / `create_filter` / `delete_filter` | `manageFilter` action=`list`/`get`/`create`/`delete` |
| `list_labels` / `get_label` / `create_label` / `patch_label` / `delete_label` | `manageLabel` action=`list`/`get`/`create`/`patch`/`delete` |

## License

MIT

## Releasing

Maintainers: see [RELEASING.md](RELEASING.md) for the tag-triggered npm
publishing workflow and its one-time trusted-publisher setup.
