### #122

FIXED `1ee5847` (test-mock follow-up `9ff499d`). Replaced the 500 ms mtime heuristic with content fingerprints and applied the guarded writer to v2 editable handle files. Regression removes the artificial future mtime and proves immediate legacy edits plus v2-path edits are backed up to `.bak`.

### #14

FIXED `3308655` (compatibility refinement `45032c6`). Stock Docs that omit `NORMAL_TEXT.foregroundColor` now receive explicit black on markdown inserts; named theme colors remain inherited. `replaceDocumentWithMarkdown`, `appendMarkdown`, and `replaceRangeWithMarkdown` share this insertion path. The new regression used the real omitted-color response shape, which previously emitted zero color requests.

### #106

FIXED `1ff9b4b` (merge preservation `eea7725`). Differing-preset nested lists now create the parent before its child, so Docs consumes the child tab as nesting rather than making a top-level list. The round-trip test asserts the nested export and parent-first API request order.

### #108

FIXED `e7bf429`. `format: "text"` reads now retain a canonical body snapshot for the stale guard. The regression changes only `modifiedTime` to model a title rename and verifies the unchanged body is accepted; previously the text read stored no snapshot and the guard rejected it.

`Test Suites: 74 passed, 74 total`  
`Tests: 2 skipped, 1033 passed, 1035 total`

Worktree is clean. Nothing was pushed or posted to GitHub.

