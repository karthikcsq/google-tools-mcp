# Releasing

Releases are deliberate, tag-triggered npm publishes. Pushing ordinary commits
or opening a pull request never publishes a package. Once a `v*` tag lands on a
commit that is on `main`, CI takes it from there with no further clicks.

## The short version

From an up-to-date `main`, where `X.Y.Z` is the version already sitting in
`package.json` and at the top of `CHANGELOG.md`:

```bash
npm run release:check      # tag, package.json, and CHANGELOG must agree
git tag vX.Y.Z
git push origin vX.Y.Z
```

The rest of this file explains what that runs, who is allowed to run it, and how
to verify the result.

## One-time setup

One step, for the repository owner.

### Add the npm trusted publisher (required)

<https://www.npmjs.com/package/google-tools-mcp/access>

Add a GitHub Actions trusted publisher with exactly these values:

| Field                | Value              |
| -------------------- | ------------------ |
| Organization or user | `karthikcsq`       |
| Repository           | `google-tools-mcp` |
| Workflow filename    | `publish.yml`      |
| Environment name     | `npm-publish`      |
| Allowed actions      | `npm publish`      |

The environment name must match the `environment: npm-publish` line on the
`publish` job, or the OIDC identity the job presents will not be the one npm
expects and the publish fails. That is the only reason the workflow names an
environment; see "Why tag-triggered" below.

npm requires at least one allowed action for trusted publishers created after
2026-05-20. Publishers created before that date default to `npm publish` only,
but select it explicitly rather than relying on the default.

The workflow authenticates with GitHub Actions OIDC (`id-token: write`) rather
than a stored npm token, so there is no secret to add here or in the repository.
npm verifies the trusted publisher and generates provenance for the published
package. Reference: <https://docs.npmjs.com/trusted-publishers/>

### Optional hardening

Not needed for a release to work; it narrows who can trigger one.

- **Tag protection for `v*`**
  (<https://github.com/karthikcsq/google-tools-mcp/settings/rules>): a ruleset
  targeting the `v*` tag pattern that restricts creation to maintainers. On a
  repository where more than one person has push access, this is what makes the
  security argument below hold, since that argument rests on tag creation being
  restricted.
- **Branch protection on `main`**: `main` is currently unprotected. Protecting
  it does not change the release flow described below, which routes the version
  bump through a pull request either way.

## Release a version

`CHANGELOG.md` records one entry per merged pull request (or standalone direct
commit), each with its own semantic version; the bump rules are at the top of
that file. Every pull request adds its own entry and moves `package.json` to
that version in the same change, so the version at the top of the changelog,
the version in `package.json`, and the next tag are always the same Semantic
Version.
`scripts/check-release.mjs` enforces exactly that, locally and in CI. Not every
version gets tagged: patch versions accumulate on `main` and the tag goes on
whichever commit is being published.

The version bump lands through a pull request rather than a direct push. `npm
version` would create a commit and a tag together; this flow separates them so
the bump can be reviewed on its own and the tag is only created once the exact
commit is on `main`.

1. On a branch, add this pull request's `CHANGELOG.md` entry with the version
   its bump rule gives it, then set `package.json` to that version without
   creating a git commit or tag:

   ```powershell
   npm.cmd --no-git-tag-version version X.Y.Z
   ```

2. Check that every pull request merged since the last tag has an entry above
   the previous release's section. A missing one gets its entry now, with the
   version it should have had, so the chain stays one bump per PR.

3. Run the same release checks the workflow will run:

   ```powershell
   npm.cmd run release:check
   npm.cmd run test:ci
   npm.cmd pack --dry-run
   ```

4. Commit `package.json`, `package-lock.json`, and `CHANGELOG.md`, open a pull
   request, and merge it to `main` like any other change.

5. Update your local `main` and tag the exact commit that was merged:

   ```powershell
   git checkout main
   git pull origin main
   npm.cmd run release:check
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   A prerelease uses the same flow with a standard SemVer prerelease version,
   for example `X.Y.Z-rc.1`. The publish workflow sends versions containing a
   prerelease identifier to npm's `next` dist-tag; stable versions go to
   `latest`.

That is the whole release. Watch it at
<https://github.com/karthikcsq/google-tools-mcp/actions>; there is nothing to
approve.

The tag push starts `.github/workflows/publish.yml`, which runs in two jobs:

- **`validate`** holds no privileges. It checks that the tagged commit is
  reachable from `main`, and runs `scripts/check-release.mjs --tag` to confirm
  the tag, `package.json`, and the newest `CHANGELOG.md` entry are the same
  version. A bad tag fails here, in seconds, before anything that can reach npm
  has started.
- **`publish`** runs only if `validate` passed. It installs dependencies, runs
  the test suite, verifies the package tarball with `npm pack --dry-run`, and
  publishes.

`id-token: write` is granted to the `publish` job alone rather than to the
workflow, so the ungated `validate` job cannot mint the OIDC token npm accepts.

Publishes are serialized, not superseded: pushing a second tag while a publish
is already running queues the new run behind it instead of canceling the first
one, since npm versions are immutable and a canceled-but-already-published run
would leave git and npm inconsistent.

## Why tag-triggered

The barrier to publishing is who can create a `v*` tag on this repository, not a
click inside a running workflow.

- The workflow has **no write access** to the repository (`contents: read`), so
  it cannot push anything back.
- Both checkouts use `persist-credentials: false`, so even the read-only token
  is not left in `.git/config` during the job.
- Both actions are pinned to a **commit SHA** rather than a moving tag, so a
  compromised upstream release cannot change what runs here.
- The tagged commit must be **reachable from `main`**. A `v*` tag pushed from a
  local or unmerged branch fails validation and cannot reach npm, so a release
  can only contain code that already went through the normal review path.
- Publishing requires a **deliberate second action** after the merge. It cannot
  be smuggled into a pull request, because merging one does not create a tag.

### The approval gate that used to be here

Until 3.4.5 the `publish` job's `environment: npm-publish` was described as a
human approval gate, and `validate` failed the release unless that environment
had a required reviewer configured. It never had one, so the guard did what it
was written to do and blocked every release: `v3.4.4` was tagged on 2026-09-04
and the run failed ten seconds in, leaving npm on 2.0.0 while `main` sat at
3.4.4. Issue [#50](https://github.com/karthikcsq/google-tools-mcp/issues/50)
tracked that; the fix chosen was to drop the gate rather than to configure it.

For a repository where tag creation is already restricted to maintainers, the
approval adds a second click by the same person who pushed the tag, which is not
a second pair of eyes. The `environment: npm-publish` line stays because npm's
trusted publisher for this package names that environment and the OIDC claim has
to match; it is not doing access control, and the workflow comment says so. If a
real approval gate is ever wanted, adding a required reviewer to the environment
turns it back on with no code change.

## Re-running a failed release

Re-enabling or fixing something does not replay a tag event that already
happened, and a tag that already exists will not re-trigger the workflow on a
second `git push`. Delete the tag and push it again:

```bash
git push origin :refs/tags/vX.Y.Z
git push origin refs/tags/vX.Y.Z
```

If the tag needs to move to a different commit, delete it remotely first as
above, then `git tag -f vX.Y.Z <sha>` locally before re-pushing. Only do this
for a version that has not been published: npm versions are immutable, so once
`npm publish` has succeeded the only way forward is a new version.

## After a release

```bash
gh run list --workflow publish.yml --limit 1     # run succeeded
npm view google-tools-mcp version                 # registry updated
```

Before publishing, verify the exact tarball that `npm pack` creates. Each
recipe creates an independent temporary consumer, installs with `--omit=dev`,
and uses `scripts/probe-candidate.mjs` to keep stdio open while it sends modern
`server/discover` followed by `tools/list`. A successful probe prints a JSON
object with a nonzero `toolCount`. This checks the installed executable's
actual MCP surface; `--help` and a ready log line are useful diagnostics but
are not a protocol check.

### Native PowerShell 5.1

Run this from the repository root in **Windows PowerShell 5.1** (not PowerShell
7). It uses no Bash operators or Unix paths.

```powershell
$repoRoot = (Get-Location).Path
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('gtm-verify-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $scratch | Out-Null
$env:npm_config_cache = Join-Path $scratch 'npm-cache'
$packed = npm.cmd pack --json --ignore-scripts | ConvertFrom-Json
$manifest = if ($packed -is [array]) { $packed[0] } else { $packed.PSObject.Properties.Value | Select-Object -First 1 }
$tarball = $manifest.filename
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
$tarballPath = Join-Path $repoRoot $tarball
$expectedVersion = node -p "require('./package.json').version"

try {
    Push-Location $scratch
    npm.cmd init -y
    if ($LASTEXITCODE -ne 0) { throw 'npm init failed.' }
    npm.cmd install --omit=dev $tarballPath
    if ($LASTEXITCODE -ne 0) { throw 'tarball install failed.' }
    $installedVersion = node -p "require(process.argv[1]).version" (Join-Path $scratch 'node_modules\google-tools-mcp\package.json')
    if ($installedVersion -ne $expectedVersion) { throw 'installed package version does not match the packed version.' }
    node (Join-Path $repoRoot 'scripts\probe-candidate.mjs') --entry (Join-Path $scratch 'node_modules\google-tools-mcp\dist\index.js') --expected-version $installedVersion
    if ($LASTEXITCODE -ne 0) { throw 'installed MCP protocol probe failed.' }
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $scratch -Recurse -Force
    Remove-Item -LiteralPath $tarballPath -Force
}
```

### Bash

Run this from the repository root in Bash. It uses the same independently
packed package, rather than `npx` or the repository's `node_modules`.

```bash
set -euo pipefail
repo_root="$(pwd)"
# Node chooses a path valid for the running platform, including Git Bash on
# Windows where passing a literal /tmp path to npm would be wrong.
scratch="$(node -e "const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-verify-')))")"
# Invoke npm's JavaScript entrypoint on Windows to avoid .cmd quoting problems
# when Node is installed under Program Files. Use normal npm on Unix.
if command -v npm.cmd >/dev/null 2>&1; then
    npm_cli="$(node -e "const p=require('node:path'); process.stdout.write(p.join(p.dirname(process.argv[1]), 'node_modules/npm/bin/npm-cli.js'))" "$(command -v npm.cmd)")"
    npm_run() { node "$npm_cli" "$@"; }
else
    npm_run() { command npm "$@"; }
fi
export npm_config_cache="$scratch/npm-cache"
tarball="$(npm_run pack --json --ignore-scripts | node -e 'let output = ""; process.stdin.on("data", (chunk) => { output += chunk; }); process.stdin.on("end", () => process.stdout.write((Array.isArray(JSON.parse(output)) ? JSON.parse(output)[0] : Object.values(JSON.parse(output))[0]).filename));')"
expected_version="$(node -p "require('./package.json').version")"
cleanup() {
    node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "$scratch"
    node -e "require('node:fs').rmSync(process.argv[1], { force: true })" "$repo_root/$tarball"
}
trap cleanup EXIT

(
    cd "$scratch"
    npm_run init -y >/dev/null
    npm_run install --omit=dev "$repo_root/$tarball"
    installed_version="$(node -p "require(process.argv[1]).version" "$scratch/node_modules/google-tools-mcp/package.json")"
    test "$installed_version" = "$expected_version"
    node "$repo_root/scripts/probe-candidate.mjs" --entry "$scratch/node_modules/google-tools-mcp/dist/index.js" --expected-version "$installed_version"
)
```

The probe owns only the direct candidate child process and cleans it up after
both responses. It gives the candidate a fresh absolute config directory,
forces stdio, and removes inherited HTTP token/no-auth settings so no local
service state can make the tarball look healthy.

## Verify the published registry artifact

After the publish workflow succeeds and npm has propagated the exact version,
repeat the same protocol check with the registry artifact. A local tarball is a
candidate check only; it cannot prove that npm serves the published bytes.

### Native PowerShell 5.1

Set `$version` to the exact version that was published, then run from the
repository root:

```powershell
$version = 'X.Y.Z'
$repoRoot = (Get-Location).Path
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('gtm-registry-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $scratch | Out-Null
$env:npm_config_cache = Join-Path $scratch 'npm-cache'
$registryVersion = npm.cmd view "google-tools-mcp@$version" version --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $registryVersion -ne $version) { throw 'npm registry does not yet report the expected version.' }

try {
    Push-Location $scratch
    npm.cmd init -y
    if ($LASTEXITCODE -ne 0) { throw 'npm init failed.' }
    npm.cmd install --omit=dev "google-tools-mcp@$version"
    if ($LASTEXITCODE -ne 0) { throw 'registry install failed.' }
    $installedVersion = node -p "require(process.argv[1]).version" (Join-Path $scratch 'node_modules\google-tools-mcp\package.json')
    if ($installedVersion -ne $version) { throw 'installed package version does not match the published version.' }
    node (Join-Path $repoRoot 'scripts\probe-candidate.mjs') --entry (Join-Path $scratch 'node_modules\google-tools-mcp\dist\index.js') --expected-version $installedVersion
    if ($LASTEXITCODE -ne 0) { throw 'published MCP protocol probe failed.' }
}
finally {
    Pop-Location
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
```

### Bash

Set `version` to the exact version that was published, then run from the
repository root:

```bash
set -euo pipefail
version='X.Y.Z'
repo_root="$(pwd)"
# See the candidate recipe above for why Node creates this portable scratch path.
scratch="$(node -e "const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); process.stdout.write(fs.mkdtempSync(path.join(os.tmpdir(), 'gtm-registry-')))")"
# Invoke npm's JavaScript entrypoint on Windows to avoid .cmd quoting problems
# when Node is installed under Program Files. Use normal npm on Unix.
if command -v npm.cmd >/dev/null 2>&1; then
    npm_cli="$(node -e "const p=require('node:path'); process.stdout.write(p.join(p.dirname(process.argv[1]), 'node_modules/npm/bin/npm-cli.js'))" "$(command -v npm.cmd)")"
    npm_run() { node "$npm_cli" "$@"; }
else
    npm_run() { command npm "$@"; }
fi
export npm_config_cache="$scratch/npm-cache"
test "$(npm_run view "google-tools-mcp@$version" version)" = "$version"
cleanup() {
    node -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true })" "$scratch"
}
trap cleanup EXIT

(
    cd "$scratch"
    npm_run init -y >/dev/null
    npm_run install --omit=dev "google-tools-mcp@$version"
    test "$(node -p "require(process.argv[1]).version" "$scratch/node_modules/google-tools-mcp/package.json")" = "$version"
    node "$repo_root/scripts/probe-candidate.mjs" --entry "$scratch/node_modules/google-tools-mcp/dist/index.js" --expected-version "$version"
)
```

Both registry recipes assert the requested version before the protocol probe;
repeat the `npm view` step if propagation has not completed. Run `git status`
after candidate verification to confirm the release worktree stayed clean.
