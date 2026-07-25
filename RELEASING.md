# Releasing

Releases are deliberate, tag-triggered npm publishes. Pushing ordinary commits
or opening a pull request never publishes a package.

## One-time setup

1. In the npm settings for `google-tools-mcp`, add a GitHub Actions Trusted
   Publisher with these values:
   - Organization or user: `karthikcsq`
   - Repository: `google-tools-mcp`
   - Workflow filename: `publish.yml`
   - Environment name: `npm-publish`
   - Allowed actions: select `npm publish`. npm requires at least one allowed
     action to be selected for trusted publishers created after May 20, 2026
     (publishers created before that date default to `npm publish` only, but
     select it explicitly rather than relying on that default).
2. In the GitHub repository settings, create an environment named
   `npm-publish` (Settings > Environments) and add at least one required
   reviewer. The `publish` job in `.github/workflows/publish.yml` targets
   this environment, so a tag push waits for a reviewer to approve the run
   before `npm publish` executes, no matter who pushed the tag.
3. In the GitHub repository settings, add a tag protection rule for the `v*`
   pattern (Settings > Tags, or Settings > Rules > Rulesets) so only
   maintainers can create or push matching tags.
4. Keep the repository's GitHub Actions enabled and protect `main` so releases
   are intentional.

The workflow uses GitHub Actions OIDC (`id-token: write`) rather than a stored
npm token. npm verifies the trusted publisher and generates provenance for the
published package. Reference: https://docs.npmjs.com/trusted-publishers/

## Release a version

`main` is protected, so the version bump has to land through a normal pull
request instead of being pushed directly. `npm version` creates a commit and
tag together, and that commit cannot be pushed straight to a protected
branch, so this flow separates the version bump (reviewed via PR) from the
tag (created only after the bump is already on `main`):

1. On a branch, bump the version without creating a git commit or tag:

   ```powershell
   npm.cmd --no-git-tag-version version patch   # or minor / major
   ```

2. Run the same release checks locally:

   ```powershell
   npm.cmd run test:ci
   npm.cmd pack --dry-run
   ```

3. Commit the resulting `package.json` and `package-lock.json` changes, open
   a pull request, and get it reviewed and merged to `main` like any other
   change.
4. Update your local `main` and tag the exact commit that was merged:

   ```powershell
   git checkout main
   git pull origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The pushed `vX.Y.Z` tag starts `.github/workflows/publish.yml`. The workflow
refuses to publish unless the tagged commit is reachable from `main` and the
tag and `package.json` have the same version, then waits for a required
reviewer to approve the run on the `npm-publish` environment before it
installs dependencies, runs the test suite, verifies the package tarball, and
publishes to npm.

Tagging a commit that is not on `main` fails the run before anything is
published, so a `v*` tag pushed from a local or unmerged branch cannot reach
npm. Tag protection further limits who can push a matching tag at all, and
environment approval means an ancestry match alone is not enough to publish.

Publishes are serialized, not superseded: pushing a second tag while a
publish is already running queues the new run behind it instead of canceling
the first one, since npm versions are immutable and a canceled-but-already-
published run would leave git and npm inconsistent.

After it completes, verify the GitHub Actions run, the npm registry version,
and a clean `npx -y google-tools-mcp@X.Y.Z` invocation.
