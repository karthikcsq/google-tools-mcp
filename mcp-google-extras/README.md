# mcp-google-extras

An MCP server for Google Docs, Sheets, and Drive — with added support for reading `.docx` and `.pdf` files directly from Google Drive.

Built on top of [@a-bonus/google-docs-mcp](https://www.npmjs.com/package/@a-bonus/google-docs-mcp) (ISC license), with additional tools for extracting text from Word documents and PDFs.

## Features

All 44 tools from `@a-bonus/google-docs-mcp`, plus:

- **readFile** — Read the full text content of a `.docx` or `.pdf` file from Google Drive by file ID
- **searchFileContents** — Search Google Drive and extract matching text snippets from inside `.docx` and `.pdf` files

## Setup

### 1. Create Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the Google Docs API, Google Sheets API, and Google Drive API
4. Create OAuth 2.0 credentials (Desktop application type)
5. Note your Client ID and Client Secret

### 2. Configure your MCP client

Add this to your MCP configuration (e.g., `.mcp.json`):

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

### 3. Authenticate

On first run, the server will open your browser for Google OAuth consent. The token is saved to `~/.config/google-docs-mcp/token.json` for future use.

You can also run the auth flow manually:

```bash
npx mcp-google-extras auth
```

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
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret |
| `GOOGLE_MCP_PROFILE` | No | Profile name for multi-account support |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error`, or `silent` |
| `SERVICE_ACCOUNT_PATH` | No | Path to service account JSON key (alternative to OAuth) |
| `GOOGLE_IMPERSONATE_USER` | No | Email to impersonate with service account |

## License

ISC (based on [@a-bonus/google-docs-mcp](https://www.npmjs.com/package/@a-bonus/google-docs-mcp))
