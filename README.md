# google-tools-mcp

A unified MCP server for Google Workspace — Drive, Docs, Sheets, Gmail, Calendar, and Forms — with **152 tools** across 9 categories.

All tools are loaded at startup so they're immediately available to your AI agent. No discovery step needed.

## Why This Exists

Most Google MCP servers split functionality across separate packages. This server combines everything into one — single auth token, single process, single config.

## Features

- **152 tools** across 9 categories, all available immediately
- **Single auth token** — one OAuth flow covers Drive, Docs, Sheets, Gmail, Calendar, and Forms
- **Lazy-loading auth** — no browser popup until your first tool call
- **No lazy tool loading** — all 150 tools are registered eagerly at startup since most MCP clients (including Claude Code) don't support `notifications/tools/list_changed`
- **Multi-profile support** — separate tokens per Google account
- **No telemetry**

## Getting Started

### Step 1: Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Docs API**, **Google Sheets API**, **Google Drive API**, **Gmail API**, **Google Calendar API**, and **Google Forms API**
4. Go to **Credentials** → **Create Credentials** → **OAuth Client ID**
5. Select **Desktop application** as the application type
6. Download the credentials or note your **Client ID** and **Client Secret**

### Step 2: Provide Your Credentials

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

### Step 3: Add to Your MCP Client

#### Claude Code (recommended)

If you used Option A or B above:

```bash
claude mcp add google -- npx -y google-tools-mcp
```

Or with env vars (Option C):

```bash
claude mcp add google \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y google-tools-mcp
```

#### Project-Local Installation (with profile)

Via the `claude` CLI:

```bash
claude mcp add google \
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

## Tool Categories

### `files` (17 tools)
Google Drive file management and content reading.

`listDriveFiles`, `searchDocuments`, `getFileInfo`, `createFolder`, `listFolderContents`, `getFolderInfo`, `moveFile`, `copyFile`, `renameFile`, `deleteFile`, `createDocument`, `createDocumentFromTemplate`, `listSharedDrives`, `listSharedWithMe`, `downloadFile`, `readFile`, `searchFileContents`

### `documents` (22 tools)
Google Docs read/write/format with markdown support.

`readDocument`, `appendText`, `deleteRange`, `modifyText`, `findAndReplace`, `insertTable`, `insertTableWithData`, `insertPageBreak`, `insertImage`, `listTabs`, `addTab`, `renameTab`, `applyParagraphStyle`, `getFormatting`, `addComment`, `deleteComment`, `getComment`, `listComments`, `replyToComment`, `resolveComment`, `appendMarkdown`, `replaceDocumentWithMarkdown`

### `spreadsheets` (29 tools)
Google Sheets operations.

`readSpreadsheet`, `writeSpreadsheet`, `batchWrite`, `appendRows`, `clearRange`, `createSpreadsheet`, `getSpreadsheetInfo`, `addSheet`, `deleteSheet`, `duplicateSheet`, `renameSheet`, `formatCells`, `readCellFormat`, `autoResizeColumns`, `freezeRowsAndColumns`, `setColumnWidths`, `addConditionalFormatting`, `copyFormatting`, `setDropdownValidation`, `createTable`, `deleteTable`, `getTable`, `listTables`, `appendTableRows`, `updateTableRange`, `insertChart`, `deleteChart`, `groupRows`, `ungroupAllRows`

### `email` (19 tools)
Gmail messages and drafts.

`send_message`, `reply_message`, `forward_message`, `get_message`, `list_messages`, `modify_message`, `delete_message`, `trash_message`, `untrash_message`, `batch_delete_messages`, `batch_modify_messages`, `batch_get_messages`, `get_attachment`, `create_draft`, `update_draft`, `delete_draft`, `get_draft`, `list_drafts`, `send_draft`

### `email_threads` (7 tools)
Gmail thread-level operations.

`get_thread`, `list_threads`, `batch_get_threads`, `modify_thread`, `delete_thread`, `trash_thread`, `untrash_thread`

### `email_labels` (6 tools)
Gmail label management.

`create_label`, `delete_label`, `get_label`, `list_labels`, `patch_label`, `update_label`

### `email_settings` (37 tools)
Gmail admin and configuration.

`get_auto_forwarding`, `update_auto_forwarding`, `get_imap`, `update_imap`, `get_language`, `update_language`, `get_pop`, `update_pop`, `get_vacation`, `update_vacation`, `add_delegate`, `remove_delegate`, `get_delegate`, `list_delegates`, `create_filter`, `delete_filter`, `get_filter`, `list_filters`, `create_forwarding_address`, `delete_forwarding_address`, `get_forwarding_address`, `list_forwarding_addresses`, `create_send_as`, `delete_send_as`, `get_send_as`, `list_send_as`, `patch_send_as`, `update_send_as`, `verify_send_as`, `delete_smime_info`, `get_smime_info`, `insert_smime_info`, `list_smime_info`, `set_default_smime_info`, `get_profile`, `watch_mailbox`, `stop_mail_watch`

### `calendar` (8 tools)
Google Calendar — events, availability, and calendar management.

`list_calendars`, `get_events`, `manage_event`, `get_busy`, `get_free`, `move_event`, `list_recurring_event_instances`, `manage_calendar`

### `forms` (6 tools)
Google Forms — create/read forms, manage responses, and publish settings.

`create_form`, `get_form`, `batch_update_form`, `get_form_response`, `list_form_responses`, `set_publish_settings`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | No* | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | No* | OAuth 2.0 Client Secret |
| `GOOGLE_MCP_PROFILE` | No | Profile name for multi-account support (see above) |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`, or `silent` |
| `SERVICE_ACCOUNT_PATH` | No | Path to service account JSON key (alternative to OAuth) |
| `GOOGLE_IMPERSONATE_USER` | No | Email to impersonate with service account |

\* Not required as env vars if you provide credentials via `.env` file or `credentials.json` (see [Step 2](#step-2-provide-your-credentials)).

## Migrating from gdrive-tools-mcp / gmail-tools-mcp

This package replaces both [`gdrive-tools-mcp`](https://www.npmjs.com/package/gdrive-tools-mcp) and [`gmail-tools-mcp`](https://www.npmjs.com/package/gmail-tools-mcp). To migrate:

1. Replace both MCP server entries with a single `google-tools-mcp` entry
2. Re-authenticate (the combined server uses its own config dir at `~/.config/google-tools-mcp/`)
3. All tools are available immediately — no discovery step needed

## License

MIT
