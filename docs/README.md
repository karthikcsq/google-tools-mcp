# docs

Longer-form documentation that does not belong in the top-level [README](../README.md).

The main README is the user-facing guide: install, configure, tool reference, troubleshooting. Anything that needs more room than a troubleshooting entry, or is aimed at contributors rather than users, goes here and gets a line in the index below.

## Index

- [Production OAuth setup](production-oauth.md) — publish a personal OAuth app, choose homepage and privacy-policy URLs, and distinguish production publishing from Google verification.
- [Privacy policy](../PRIVACY.md) — basic Google data access, storage, sharing, revocation and deletion information for self-hosted deployments.
- [Contributing](../CONTRIBUTING.md) — the rules a change has to follow that no single file states: the read-before-write guard and which surfaces it covers, seeding read state after create/copy ("trustworthy or not at all"), working-copy lifecycle, the error boundary, reading the `Test Suites:` line, the inventory snapshot, and the one-entry-per-PR changelog and version bump.
- [How this repo works](architecture.md) — why `dist/` is the source and there is no build step, the entry point and its subcommands, transports, how the 12 tool categories load and what the `addTool` wrapper does for free, auth and config layout, tests, and how to add a tool.
- [Shared HTTP mode](http-mode.md) — running one long-lived server for many clients, the 3.0.0 stateless-HTTP breaking change (removed `/sse`, `/messages`, `/ping`, session routes, and `Mcp-Session-Id`), the `readHandle` contract for edits over HTTP, and exact Claude Code / Codex reconfiguration steps.
- [Remote OAuth tunnel](remote-oauth-tunnel.md) — completing the OAuth flow when the server runs on a machine with no browser.
- [Startup performance](startup-performance.md) — why the server has to boot inside Claude Code's fixed 30s MCP timeout, measured cost of each launch path, where the time actually goes, and how to measure it yourself before adding a dependency.
- [Live testing](../.agents/skills/live-testing/SKILL.md) — canonical instructions for regression smoke scenarios and goal-first interactive MCP sessions. The [live smoke](live-smoke.md) and [live agent loop](live-agent-loop.md) pages remain redirects for historical links.
- [Common workflows](workflows.md) — safe, minimal examples for email, Docs, Sheets, Slides, and Tasks.
- [Execution plans](plans/README.md) — one root-cause implementation plan per open issue, with suggested ordering and dependencies.

## Adding a page

Keep one topic per file, link it from the index above with a one-line description of what it answers, and cross-link the relevant issues. When a page overlaps a README section, link to the README rather than restating it, so there is one canonical copy of each fact.
