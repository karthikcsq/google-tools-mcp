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

| Field | Value |
| --- | --- |
| Organization or user | `karthikcsq` |
| Repository | `google-tools-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |
| Allowed actions | `npm publish` |

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
the version in `package.json`, and the next tag are always the same number.
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

Then confirm the published tarball actually runs. There is no `--help` flag, so
install it into a scratch directory and start it with stdin held open long
enough to finish booting, then let the pipe close to shut it down.

Run this from **outside** the repository, and create the manifest before
installing anything:

```bash
mkdir -p ../gtm-verify && cd ../gtm-verify
npm init -y > /dev/null        # load-bearing: see the warning below
npm install google-tools-mcp@X.Y.Z
node -e "setTimeout(() => {}, 40000)" | node node_modules/google-tools-mcp/dist/index.js
```

> **Do not skip `npm init -y`, and do not put the scratch directory inside the
> repository.** `npm install <pkg>` in a directory with no `package.json` does
> not fail. npm walks up the tree looking for one, finds the repository's, and
> installs there instead: `"google-tools-mcp": "^X.Y.Z"` is added to this
> project's own `package.json` and `package-lock.json` as a dependency on
> itself, and the tarball you meant to test lands in the repo's `node_modules`.
> The install prints a perfectly normal `added 1 package` and says nothing about
> which directory it chose. This is easy to commit by accident, since it happens
> during the after-the-fact verification step when the release already looks
> done. It bit the 3.4.5 release. If you hit it, `git checkout -- package.json
> package-lock.json` and re-run `npm ci`.

The timer is a `node` one-liner rather than `sleep` so the same block works from
PowerShell, which is what the rest of this file uses. 40 seconds comfortably
outlasts the 8-14 second startup measured on affected machines.

Expect a line like `MCP Server running using stdio in 13970ms`, then a clean
exit 0 once the pipe closes. A hang, a module-resolution error, or a missing
ready line means the tarball is broken even though the publish succeeded.

The install and the run are separate commands on purpose, and the wait has to
outlast startup. Two ways to get this wrong, both of which report a broken build
for a package that is fine:

- **Closing stdin immediately.** With `echo "" |` the stream ends before
  `server.start()` logs, the shutdown handler wins, and you get
  `Loaded all 12 categories` followed straight by `stdin ended` with no ready
  line at all.
- **Combining the install and the run**, as in `node -e "setTimeout(() => {},
  40000)" | npx -y google-tools-mcp@X.Y.Z`. Both sides of a pipe start at once,
  so the timer runs
  during `npx`'s resolve and unpack rather than during startup. `npx` is measured
  at 23-34 seconds on affected machines (see the troubleshooting section in
  `README.md`) and startup at 8-14 seconds, so the server can be handed an
  already-closed stdin before it prints anything. Installing first takes the
  resolve time out of the timed window entirely.

If you do want to exercise the `npx` path specifically, run it once to warm the
cache and then time a second run, so only the second one is racing the timer.

**Do not pipe any of this into `head`.** `head` exits after its line quota and
the resulting SIGPIPE can kill `npx` partway through unpacking, leaving a
half-written directory under `npm-cache/_npx/<hash>`. Every later `npx` run for
that package then fails with `ENOENT ... could not read package.json` and keeps
failing until you delete that directory. The failure message says nothing about
the cache, so it reads as a bad publish when it is purely local.

When the check passes, delete `../gtm-verify`. Then run `git status` in the
repository before you walk away: it should be clean. If `package.json` or
`package-lock.json` come back modified, the install went to the wrong directory
and the warning above tells you how to undo it.
