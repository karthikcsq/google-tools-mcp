# gmail-mcp-tools

An MCP server for Gmail with lazy-loading auth and multi-profile support.

Forked from [@shinzolabs/gmail-mcp](https://www.npmjs.com/package/@shinzolabs/gmail-mcp) (MIT license), rebuilt with the same auth patterns as [mcp-google-extras](https://www.npmjs.com/package/mcp-google-extras).

## Features

- Complete Gmail API coverage: messages, threads, labels, drafts, and settings
- Lazy-loading auth — no browser popup until your first tool call
- Multi-profile support for multiple Google accounts
- No telemetry

## Getting Started

### Step 1: Create Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Gmail API**
4. Go to **Credentials** → **Create Credentials** → **OAuth Client ID**
5. Select **Desktop application** as the application type
6. Download the credentials or note your **Client ID** and **Client Secret**

### Step 2: Provide Your Credentials

Choose **one** of the following methods (whichever you prefer):

#### Option A: Use `credentials.json`

Download the JSON file from Google Cloud Console and place it in either location:

```
~/.config/gmail-mcp-tools/credentials.json   (recommended — shared across projects)
./credentials.json                             (local to your project)
```

That's it — no env vars needed. The server will find it automatically.

#### Option B: Create a `.env` file

Create a `.env` file in either location:

```
~/.config/gmail-mcp-tools/.env   (recommended — shared across projects)
./.env                            (local to your project)
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
    "gmail": {
      "command": "npx",
      "args": ["-y", "gmail-mcp-tools"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

> **Credential lookup order:** env vars → `~/.config/gmail-mcp-tools/.env` → project root `.env` → `~/.config/gmail-mcp-tools/credentials.json` → project root `credentials.json`

### Step 3: Add to Your MCP Client

#### Claude Code (recommended)

If you used Option A or B above:

```bash
claude mcp add gmail -- npx -y gmail-mcp-tools
```

Or with env vars (Option C):

```bash
claude mcp add gmail \
  -e GOOGLE_CLIENT_ID=your-client-id \
  -e GOOGLE_CLIENT_SECRET=your-client-secret \
  -- npx -y gmail-mcp-tools
```

#### Other MCP clients

Add this to your MCP configuration (e.g., `.mcp.json`, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "gmail-mcp-tools"]
    }
  }
}
```

If using Option C, add an `"env"` block with your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### Step 4: Authenticate

On your first tool call, the server will automatically open your browser for Google OAuth consent. Sign in and grant access — the token is saved to `~/.config/gmail-mcp-tools/token.json` for future use.

You can also run the auth flow manually anytime:

```bash
npx gmail-mcp-tools auth
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

This stores tokens in `~/.config/gmail-mcp-tools/work/` instead of the default directory.

## Tools

### Drafts
`create_draft`, `delete_draft`, `get_draft`, `list_drafts`, `send_draft`

### Messages
`send_message`, `get_message`, `list_messages`, `modify_message`, `delete_message`, `trash_message`, `untrash_message`, `batch_delete_messages`, `batch_modify_messages`, `get_attachment`

### Labels
`create_label`, `delete_label`, `get_label`, `list_labels`, `patch_label`, `update_label`

### Threads
`get_thread`, `list_threads`, `modify_thread`, `delete_thread`, `trash_thread`, `untrash_thread`

### Settings
`get_auto_forwarding`, `update_auto_forwarding`, `get_imap`, `update_imap`, `get_language`, `update_language`, `get_pop`, `update_pop`, `get_vacation`, `update_vacation`

### Delegates
`add_delegate`, `remove_delegate`, `get_delegate`, `list_delegates`

### Filters
`create_filter`, `delete_filter`, `get_filter`, `list_filters`

### Forwarding
`create_forwarding_address`, `delete_forwarding_address`, `get_forwarding_address`, `list_forwarding_addresses`

### Send-As Aliases
`create_send_as`, `delete_send_as`, `get_send_as`, `list_send_as`, `patch_send_as`, `update_send_as`, `verify_send_as`

### S/MIME
`delete_smime_info`, `get_smime_info`, `insert_smime_info`, `list_smime_info`, `set_default_smime_info`

### Profile & Watch
`get_profile`, `watch_mailbox`, `stop_mail_watch`

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

MIT (based on [@shinzolabs/gmail-mcp](https://www.npmjs.com/package/@shinzolabs/gmail-mcp))
