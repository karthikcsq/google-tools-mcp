# Project: google-tools-mcp

## Overview

Combined Google Workspace MCP server (Drive, Docs, Sheets, Gmail, Calendar, Forms, Slides, Tasks).
All 184 tools across 11 categories are loaded eagerly at startup. Only `logout` is a standalone utility tool.

## npm Publishing

- Always bump version before publishing (`npm version patch --no-git-tag-version`).
- Use the NPM_ACCESS_TOKEN from `.env` to publish. This token bypasses 2FA and is reusable.
- Command: `npm publish --//registry.npmjs.org/:_authToken=$NPM_ACCESS_TOKEN` (after sourcing .env or reading the token).

## Project Structure

- No TypeScript source — code is edited directly in `dist/`.
- Entry point: `dist/index.js`
- Config dir at `~/.config/google-tools-mcp/` (with `GOOGLE_MCP_PROFILE` subdirs).
- Auth combines GDrive + Gmail + Calendar + Forms + Slides OAuth scopes into a single token.

## Tool Categories

| Category | Tools | What's included |
|---|---|---|
| files | 24 | Drive file management + file content reading (pdf, docx) + sharing permissions + version history |
| documents | 22 | Docs read/write/format/comments/tabs + markdown conversion |
| spreadsheets | 29 | Sheets read/write/format/charts/tables |
| email | 19 | Send/reply/forward messages + draft management |
| email_threads | 7 | Thread-level operations |
| email_labels | 6 | Label management |
| email_settings | 37 | Gmail admin/config (forwarding, filters, S/MIME, etc.) |
| calendar | 8 | Calendar events, busy/free times, recurring instances, calendar management |
| forms | 6 | Create/read forms, manage responses, batch update items, publish settings |
| slides | 16 | Create/read/update presentations, format text/paragraphs, shapes, backgrounds, speaker notes, thumbnails |
| tasks | 8 | Task lists + tasks: list, create, update, complete, delete |
