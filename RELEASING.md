# Releasing

Releases are deliberate, tag-triggered npm publishes. Pushing ordinary commits
or opening a pull request never publishes a package.

## One-time setup

Two required steps, both for the repository owner. Do them in this order: the
GitHub environment has to exist before the npm trusted publisher that names it.

### 1. Create the `npm-publish` GitHub environment (required)

<https://github.com/karthikcsq/google-tools-mcp/settings/environments/new>

- Name it exactly `npm-publish`.
- Under **Deployment protection rules**, tick **Required reviewers** and add
  yourself.
- Save. Nothing else on the page needs changing.

**Do not skip this step, and do not rely on the workflow to create it.** The
`publish` job declares `environment: npm-publish`, but GitHub does not treat a
missing environment as an error: "Running a workflow that references an
environment that does not exist will create an environment with the referenced
name," and "the newly created environment will not have any protection rules or
secrets configured"
([GitHub docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
So a tag pushed before this step publishes to npm with no approval at all, and
the workflow still looks gated afterwards because the environment now exists.

Verify it took effect:

```bash
gh api repos/karthikcsq/google-tools-mcp/environments \
  --jq '.environments[] | {name, rules: [.protection_rules[].type]}'
```

You want `npm-publish` with `required_reviewers` in its rules. An empty list
means the environment exists but does not gate anything.

### 2. Add the npm trusted publisher (required)

<https://www.npmjs.com/package/google-tools-mcp/access>

Add a GitHub Actions trusted publisher with exactly these values:

| Field | Value |
| --- | --- |
| Organization or user | `karthikcsq` |
| Repository | `google-tools-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |
| Allowed actions | `npm publish` |

The environment name must match step 1 exactly, or the OIDC identity the job
presents will not be the one npm expects and the publish fails.

npm requires at least one allowed action for trusted publishers created after
2026-05-20. Publishers created before that date default to `npm publish` only,
but select it explicitly rather than relying on the default.

The workflow authenticates with GitHub Actions OIDC (`id-token: write`) rather
than a stored npm token, so there is no secret to add here or in the repository.
npm verifies the trusted publisher and generates provenance for the published
package. Reference: <https://docs.npmjs.com/trusted-publishers/>

### 3. Optional hardening

Neither of these is needed for a release to work; both narrow who can trigger
one.

- **Tag protection for `v*`**
  (<https://github.com/karthikcsq/google-tools-mcp/settings/rules>): a ruleset
  targeting the `v*` tag pattern that restricts creation to maintainers. The
  workflow already refuses to publish a commit that is not on `main`, so this
  guards against a maintainer tagging the wrong commit rather than against an
  outsider.
- **Branch protection on `main`**: `main` is currently unprotected. Protecting
  it does not change the release flow described below, which routes the version
  bump through a pull request either way.

## Release a version

The version bump lands through a pull request rather than a direct push. `npm
version` would create a commit and a tag together; this flow separates them so
the bump can be reviewed on its own and the tag is only created once the exact
commit is on `main`.

1. On a branch, bump the version without creating a git commit or tag:

   ```powershell
   npm.cmd --no-git-tag-version version patch   # or minor / major
   ```

2. Add an entry to `CHANGELOG.md` for the new version.

3. Run the same release checks the workflow will run:

   ```powershell
   npm.cmd run test:ci
   npm.cmd pack --dry-run
   ```

4. Commit `package.json`, `package-lock.json`, and `CHANGELOG.md`, open a pull
   request, and merge it to `main` like any other change.

5. Update your local `main` and tag the exact commit that was merged:

   ```powershell
   git checkout main
   git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

6. Approve the run at
   <https://github.com/karthikcsq/google-tools-mcp/actions>.

The tag push starts `.github/workflows/publish.yml`, which runs in two jobs:

- **`validate`** is not gated on any environment. It checks that the tagged
  commit is reachable from `main` and that the tag matches `package.json`. A bad
  tag fails here, in seconds, without asking anyone to approve anything.
- **`publish`** runs only if `validate` passed, and is gated on the
  `npm-publish` environment. This is where the approval request appears, so by
  the time you see it the tag is already known-good. After approval it installs
  dependencies, runs the test suite, verifies the package tarball, and
  publishes.

The split matters because `environment:` applies to an entire job. With the
checks inside the gated job, GitHub would request approval first and run them
afterwards, so a reviewer would be approving a tag without knowing whether it
even pointed at `main`.

`id-token: write` is granted to the `publish` job alone rather than to the
workflow, so the ungated `validate` job cannot mint the OIDC token npm accepts.

Tagging a commit that is not on `main` fails the run before anything is
published, so a `v*` tag pushed from a local or unmerged branch cannot reach
npm. Environment approval means an ancestry match alone is not enough to
publish.

Publishes are serialized, not superseded: pushing a second tag while a publish
is already running queues the new run behind it instead of canceling the first
one, since npm versions are immutable and a canceled-but-already-published run
would leave git and npm inconsistent.

## After a release

```bash
gh run list --workflow publish.yml --limit 1     # run succeeded
npm view google-tools-mcp version                 # registry updated
```

Then confirm the published tarball actually runs. There is no `--help` flag, so
install it into a scratch directory and start it with stdin held open long
enough to finish booting, then let the pipe close to shut it down:

```bash
mkdir verify && cd verify
npm install google-tools-mcp@X.Y.Z
(sleep 30) | node node_modules/google-tools-mcp/dist/index.js
```

Expect a line like `MCP Server running using stdio in 13970ms`, then
`stdin ended — MCP client disconnected. Shutting down.` and exit 0. A hang, a
module-resolution error, or a missing ready line means the tarball is broken
even though the publish succeeded.

The install and the run are separate commands on purpose, and the wait has to
outlast startup. Two ways to get this wrong, both of which report a broken build
for a package that is fine:

- **Closing stdin immediately.** With `echo "" |` the stream ends before
  `server.start()` logs, the shutdown handler wins, and you get
  `Loaded all 12 categories` followed straight by `stdin ended` with no ready
  line at all.
- **Combining the install and the run**, as in `(sleep 30) | npx -y
  google-tools-mcp@X.Y.Z`. Both sides of a pipe start at once, so the timer runs
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
