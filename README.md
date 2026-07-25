# google-tools-mcp

The **easiest way** to connect your AI agent to Google Workspace.

**159 tools** for Drive, Docs, Sheets, Gmail, Calendar, Forms, and Maps — all in one package. One install, one auth, and you're done.

```bash
npx -y google-tools-mcp setup
```

## Why google-tools-mcp?

- **One command to install.** No cloning repos, no building from source, no Docker. Just `npx -y google-tools-mcp` and it works.
- **One login for everything.** A single OAuth flow gives you Drive, Docs, Sheets, Gmail, Calendar, and Forms. No juggling multiple tokens or servers.
- **Auth that stays out of your way.** No browser popup until your first tool call. After that, your token is saved and you won't be asked again.
- **Read anything in your Drive.** PDFs, Word docs (.docx), spreadsheets — your AI agent can read them directly. No extra setup.
- **159 tools, zero config.** Every tool is available the moment the server starts. Send emails, create docs, manage calendar events, build forms, search places — it's all there.
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
3. Enable the **Google Docs API**, **Google Sheets API**, **Google Drive API**, **Gmail API**, **Google Calendar API**, and **Google Forms API**
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
```

#### Option C: Set env vars in your MCP config

Add the credentials directly to your MCP configuration:

```json
{
  "mcpServers": {
    "google": {
      "command": "npx",
      "args": ["-y", "google-tools-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

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

#### Codex

```bash
codex mcp add google -- npx -y google-tools-mcp
```

With env vars (Option C):

```bash
codex mcp add google \
  --env GOOGLE_CLIENT_ID=your-client-id \
  --env GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y google-tools-mcp
```

#### Claude Code

**User-scope** (available in all projects):

```bash
claude mcp add -s user google -- npx -y google-tools-mcp
```

**Project-scope** (available only in the current project):

```bash
claude mcp add google -- npx -y google-tools-mcp
```

With env vars (Option C):

```bash
# User-scope
claude mcp add -s user google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y google-tools-mcp

# Project-scope
claude mcp add google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y google-tools-mcp
```

#### Project-Local Installation (with profile)

Via the `claude` CLI:

```bash
claude mcp add -s user google \
  -e GOOGLE_MCP_PROFILE=myprofile \
  -- npx -y google-tools-mcp
```

Or manually in your `.mcp.json`:

```json
{
  "mcpServers": {
    "google": {
      "command": "npx",
      "args": ["-y", "google-tools-mcp"],
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
      "command": "npx",
      "args": ["-y", "google-tools-mcp"]
    }
  }
}
```

If using Option C, add an `"env"` block with your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Step 4: Authenticate

On your first tool call, the server will automatically open your browser for Google OAuth consent. Sign in and grant access — the token is saved to `~/.config/google-tools-mcp/token.json` for future use.

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

## Development / Contributing

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

### `files` (18 tools)
Google Drive file management and content reading.

`listDriveFiles`, `searchDocuments`, `getFileInfo`, `getFilePath`, `createFolder`, `listFolderContents`, `getFolderInfo`, `moveFile`, `copyFile`, `renameFile`, `deleteFile`, `createDocument`, `createDocumentFromTemplate`, `listSharedDrives`, `listSharedWithMe`, `downloadFile`, `readFile`, `searchFileContents`

### `documents` (22 tools)
Google Docs read/write/format with markdown support.

`readDocument`, `appendText`, `deleteRange`, `modifyText`, `findAndReplace`, `insertTable`, `insertTableWithData`, `insertPageBreak`, `insertImage`, `listTabs`, `addTab`, `renameTab`, `applyParagraphStyle`, `getFormatting`, `addComment`, `deleteComment`, `getComment`, `listComments`, `replyToComment`, `resolveComment`, `appendMarkdown`, `replaceDocumentWithMarkdown`

### `spreadsheets` (29 tools)
Google Sheets operations.

`readSpreadsheet`, `writeSpreadsheet`, `batchWrite`, `appendRows`, `clearRange`, `createSpreadsheet`, `getSpreadsheetInfo`, `addSheet`, `deleteSheet`, `duplicateSheet`, `renameSheet`, `formatCells`, `readCellFormat`, `autoResizeColumns`, `freezeRowsAndColumns`, `setColumnWidths`, `addConditionalFormatting`, `copyFormatting`, `setDropdownValidation`, `createTable`, `deleteTable`, `getTable`, `listTables`, `appendTableRows`, `updateTableRange`, `insertChart`, `deleteChart`, `groupRows`, `ungroupAllRows`

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

### `maps` (6 tools)
Google Maps and Places tools for geocoding, reverse geocoding, nearby and text search, place details, and directions.

`mapsGeocode`, `mapsReverseGeocode`, `mapsSearchNearby`, `mapsSearchPlaces`, `mapsPlaceDetails`, `mapsDirections`

These tools require `GOOGLE_MAPS_API_KEY`, a Google Maps Platform API key, separate from the Google OAuth credentials used everywhere else and not covered by the setup wizard or by [Step 1](#step-1-create-google-oauth-credentials) above. To get one: enable the **Geocoding API**, **Places API (New)**, and **Routes API** for your Google Cloud project, then go to **Credentials** → **Create Credentials** → **API key**, and set it as `GOOGLE_MAPS_API_KEY`. Without it, the `maps` tools are still listed, but calling any of them fails with a clear error telling you to set the key.

## Local Working Copies

`readDocument` (markdown format) saves what it reads to a local working-copy file, keyed by document ID and tab, so you can edit that file directly and push it back with `replaceDocumentWithMarkdown` using `filePath` instead of pasting content inline. `replaceDocumentWithMarkdown` also mirrors any inline `markdown=` push into that same file, so it always reflects what's actually on the document.

If the document contains content markdown can't represent (images, footnotes, a generated table of contents, or other Docs elements with no markdown equivalent), `readDocument` appends a warning after the markdown listing exactly what a full `replaceDocumentWithMarkdown` push would permanently remove. Use `modifyText` or `appendMarkdown` instead for those documents.

These files live in a per-user directory under the OS temp dir (`google-tools-mcp-<user>`), created with restrictive permissions and checked on every write so a planted symlink is refused rather than followed. Set `GOOGLE_MCP_WORKSPACE_DIR` to use a different directory instead.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | No* | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | No* | OAuth 2.0 Client Secret |
| `GOOGLE_MCP_PROFILE` | No | Profile name for multi-account support (see above) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`, or `silent` |
| `GOOGLE_MCP_LOG_FILE` | No | Set to `1` to log to `~/.config/google-tools-mcp/server.log`, or set to a custom file path |
| `GOOGLE_MCP_ENABLE_LEGACY_ALIASES` | No | Set to `true` to register the deprecated snake_case tool aliases (off by default; see [Gmail tool migration](#gmail-tool-migration-snake_case--camelcase)) |
| `GOOGLE_MCP_WORKSPACE_DIR` | No | Overrides where local working copies of Google Docs are saved (see [Local working copies](#local-working-copies)). Defaults to a per-user directory under the OS temp dir |
| `SERVICE_ACCOUNT_PATH` | No | Path to service account JSON key (alternative to OAuth) |
| `GOOGLE_IMPERSONATE_USER` | No | Email to impersonate with service account |
| `GOOGLE_MAPS_API_KEY` | No | Google Maps Platform API key (separate from OAuth). Without it, `maps` tools remain listed but fail with a clear error when called |

\* Not required as env vars if you provide credentials via `.env` file or `credentials.json` (see [Step 2](#step-2-provide-your-credentials)).

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
