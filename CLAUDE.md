# Project: gmail-mcp-tools

## npm Publishing

- Always bump version before publishing (`npm version patch --no-git-tag-version`).
- Use the NPM_ACCESS_TOKEN from `.env` to publish. This token bypasses 2FA and is reusable.
- Command: `npm publish --//registry.npmjs.org/:_authToken=$NPM_ACCESS_TOKEN` (after sourcing .env or reading the token).

## Project Structure

- No TypeScript source — code is edited directly in `dist/`.
- Entry point: `dist/index.js`
- Forked from @shinzolabs/gmail-mcp with lazy-loading auth and multi-profile support.
- Config dir at `~/.config/gmail-mcp-tools/` (with `GOOGLE_MCP_PROFILE` subdirs).
