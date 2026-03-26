# Project: gdrive-suite-mcp

## npm Publishing

- Always bump version before publishing (`npm version patch --no-git-tag-version`).
- Use the NPM_ACCESS_TOKEN from `.env` to publish. This token bypasses 2FA and is reusable.
- Command: `npm publish --//registry.npmjs.org/:_authToken=$NPM_ACCESS_TOKEN` (after sourcing .env or reading the token).
- DO NOT use recovery codes from `npm_recovery_codes.txt` — those are one-time use and should only be used for account recovery.

## Project Structure

- No TypeScript source — code is edited directly in `dist/`.
- Entry point: `dist/index.js`
