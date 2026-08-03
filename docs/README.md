# docs

Longer-form documentation that does not belong in the top-level [README](../README.md).

The main README is the user-facing guide: install, configure, tool reference, troubleshooting. Anything that needs more room than a troubleshooting entry, or is aimed at contributors rather than users, goes here and gets a line in the index below.

## Index

- [How this repo works](architecture.md) — why `dist/` is the source and there is no build step, the entry point and its subcommands, transports, how the 12 tool categories load and what the `addTool` wrapper does for free, auth and config layout, tests, and how to add a tool.
- [Startup performance](startup-performance.md) — why the server has to boot inside Claude Code's fixed 30s MCP timeout, measured cost of each launch path, where the time actually goes, and how to measure it yourself before adding a dependency.
- [Common workflows](workflows.md) — safe, minimal examples for email, Docs, Sheets, Slides, and Tasks.
- [Execution plans](plans/README.md) — one root-cause implementation plan per open issue, with suggested ordering and dependencies.

## Adding a page

Keep one topic per file, link it from the index above with a one-line description of what it answers, and cross-link the relevant issues. When a page overlaps a README section, link to the README rather than restating it, so there is one canonical copy of each fact.
