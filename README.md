# mcp-google-extras

An MCP server for Google Docs, Sheets, and Drive — with added support for reading `.docx` and `.pdf` files directly from Google Drive.

Built on top of [@a-bonus/google-docs-mcp](https://www.npmjs.com/package/@a-bonus/google-docs-mcp) (ISC license), with additional tools for extracting text from Word documents and PDFs.

## Features

All 44 tools from `@a-bonus/google-docs-mcp`, plus:

- **readFile** — Read the full text content of a `.docx` or `.pdf` file from Google Drive by file ID
- **searchFileContents** — Search Google Drive and extract matching text snippets from inside `.docx` and `.pdf` files

## Getting Started

### Step 1: Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Docs API**, **Google Sheets API**, and **Google Drive API**
4. Go to **Credentials** → **Create Credentials** → **OAuth Client ID**
5. Select **Desktop application** as the application type
6. Download the credentials or note your **Client ID** and **Client Secret**

### Step 2: Provide Your Credentials

Choose **one** of the following methods (whichever you prefer):

#### Option A: Drop `credentials.json` into the config directory

Download the JSON file from Google Cloud Console and place it at:

```
~/.config/google-docs-mcp/credentials.json
```

That's it — no env vars needed. The server will find it automatically.

#### Option B: Create a `.env` file

Create `~/.config/google-docs-mcp/.env`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

#### Option C: Set env vars in your MCP config

Add the credentials directly to your MCP configuration:

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "npx",
      "args": ["-y", "mcp-google-extras"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

> **Credential lookup order:** env vars → `~/.config/google-docs-mcp/.env` → project root `.env` → `~/.config/google-docs-mcp/credentials.json` → project root `credentials.json`

### Step 3: Add to Your MCP Client

If you used Option A or B above, your MCP config can be minimal:

```json
{
  "mcpServers": {
    "google-docs": {
      "command": "npx",
      "args": ["-y", "mcp-google-extras"]
    }
  }
}
```

### Step 4: Authenticate

On your first tool call, the server will automatically open your browser for Google OAuth consent. Sign in and grant access — the token is saved to `~/.config/google-docs-mcp/token.json` for future use.

You can also run the auth flow manually anytime:

```bash
npx mcp-google-extras auth
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

This stores tokens in `~/.config/google-docs-mcp/work/` instead of the default directory.

## Tools

### Google Docs
`readDocument`, `appendText`, `appendMarkdown`, `insertText`, `deleteRange`, `modifyText`, `findAndReplace`, `insertTable`, `insertTableWithData`, `insertPageBreak`, `insertImage`, `listTabs`, `addTab`, `renameTab`, `applyTextStyle`, `applyParagraphStyle`, `addComment`, `deleteComment`, `getComment`, `listComments`, `replyToComment`, `resolveComment`, `replaceDocumentWithMarkdown`

### Google Sheets
`readSpreadsheet`, `writeSpreadsheet`, `batchWrite`, `appendRows`, `clearRange`, `createSpreadsheet`, `getSpreadsheetInfo`, `addSheet`, `deleteSheet`, `duplicateSheet`, `renameSheet`, `formatCells`, `readCellFormat`, `autoResizeColumns`, `freezeRowsAndColumns`, `setColumnWidths`, `addConditionalFormatting`, `copyFormatting`, `setDropdownValidation`, `createTable`, `deleteTable`, `getTable`, `listTables`, `appendTableRows`, `updateTableRange`, `insertChart`, `deleteChart`, `groupRows`, `ungroupAllRows`

### Google Drive
`listDocuments`, `searchDocuments`, `getDocumentInfo`, `createFolder`, `listFolderContents`, `getFolderInfo`, `moveFile`, `copyFile`, `renameFile`, `deleteFile`, `createDocument`, `createDocumentFromTemplate`, `listSpreadsheets`

### Extras (new)
`readFile`, `searchFileContents`

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

## License

ISC (based on [@a-bonus/google-docs-mcp](https://www.npmjs.com/package/@a-bonus/google-docs-mcp))
