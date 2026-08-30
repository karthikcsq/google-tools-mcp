## Issue #114: feedback issue title can execute shell commands through gh CLI

## Summary

The `feedback` tool passes its user-controlled issue title into a shell command built for `child_process.exec()`. `JSON.stringify()` is used as quoting, but JSON quoting is not shell quoting, so command substitution and shell metacharacters can execute locally when `gh` is installed and authenticated.

This defect exists independently of PR #112. The PR changes the confirmation/diagnostics flow around `feedback`, but the vulnerable `tryGhCli()` command construction predates those changes and does not need PR #112 to exist.

## Concrete failure mode

`dist/tools/index.js` currently does:

```js
await execAsync(
  `gh issue create --repo ${REPO} --title ${JSON.stringify(title)} --label ${JSON.stringify(label)} --body-file ${JSON.stringify(tmpFile)}`,
  { maxBuffer: 10 * 1024 * 1024 }
);
```

A title such as `$(touch /tmp/gtm-pwned)` becomes a double-quoted shell argument. On POSIX shells, command substitution still runs inside double quotes, so `touch /tmp/gtm-pwned` executes before `gh issue create` receives the resulting title. Windows command parsing has analogous metacharacter problems because JSON escaping is not `cmd.exe` or PowerShell escaping either.

The path is reachable whenever the `feedback` MCP tool is called with `confirmPublicPost: true`, `gh --version` succeeds, and `gh auth status` succeeds. The tool argument `args.title` flows directly into `tryGhCli(args.title, ...)`.

## Evidence

Found while reviewing PR #112's changes to the `feedback` flow:
- PR: https://github.com/karthikcsq/google-tools-mcp/pull/112
- Current file at the reviewed head: https://github.com/karthikcsq/google-tools-mcp/blob/220f97fb744289d5cc68943da28f6c2d88baa817/dist/tools/index.js

No matching open or recently closed issue was found before filing.

## Smallest fix / acceptance criteria

- Stop invoking `gh issue create` through a shell string.
- Use `execFile`/`spawn` with an argv array, for example `['issue','create','--repo',REPO,'--title',title,...]`.
- Keep the body-file approach for multiline content.
- Add a regression test with a title containing `$()`, backticks, `;`, `&`, quotes, and spaces. Verify the exact title is passed as one argv element and no secondary command runs.

Found by an automated Adversarial Review on behalf of Elliot.

