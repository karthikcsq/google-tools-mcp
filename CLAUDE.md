# Project: google-tools-mcp

## Overview

Combined Google Workspace MCP server (Drive, Docs, Sheets, Gmail, Calendar) with lazy-loaded tool categories.
Only 2 tools are exposed at startup: `load_google_tools` (discovery) and `logout`.
Tool categories are dynamically registered when loaded via the discovery tool.

## npm Publishing

- Always bump version before publishing (`npm version patch --no-git-tag-version`).
- Use the NPM_ACCESS_TOKEN from `.env` to publish. This token bypasses 2FA and is reusable.
- Command: `npm publish --//registry.npmjs.org/:_authToken=$NPM_ACCESS_TOKEN` (after sourcing .env or reading the token).

## Project Structure

- No TypeScript source — code is edited directly in `dist/`.
- Entry point: `dist/index.js`
- Config dir at `~/.config/google-tools-mcp/` (with `GOOGLE_MCP_PROFILE` subdirs).
- Auth combines GDrive + Gmail + Calendar OAuth scopes into a single token.

## Tool Categories

| Category | Tools | What's included |
|---|---|---|
| files | 16 | Drive file management + file content reading (pdf, docx) |
| documents | 23 | Docs read/write/format/comments/tabs + markdown conversion |
| spreadsheets | 30 | Sheets read/write/format/charts/tables |
| email | 19 | Send/reply/forward messages + draft management |
| email_threads | 7 | Thread-level operations |
| email_labels | 6 | Label management |
| email_settings | 37 | Gmail admin/config (forwarding, filters, S/MIME, etc.) |
| calendar | 8 | Calendar events, busy/free times, recurring instances, calendar management |
