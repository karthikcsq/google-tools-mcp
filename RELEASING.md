# Releasing

Releases are deliberate, tag-triggered npm publishes. Pushing ordinary commits
or opening a pull request never publishes a package.

## One-time setup

1. In the npm settings for `google-tools-mcp`, add a GitHub Actions Trusted
   Publisher with these values:
   - Organization or user: `karthikcsq`
   - Repository: `google-tools-mcp`
   - Workflow filename: `publish.yml`
2. Keep the repository's GitHub Actions enabled and protect `main` so releases
   are intentional.

The workflow uses GitHub Actions OIDC (`id-token: write`) rather than a stored
npm token. npm verifies the trusted publisher and generates provenance for the
published package.

## Release a version

1. Merge the release-ready changes to `main`.
2. Update `package.json` and `package-lock.json` with `npm version patch`,
   `npm version minor`, or `npm version major`.
3. Run the same release checks locally:

   ```powershell
   npm.cmd run test:ci
   npm.cmd pack --dry-run
   ```

4. Push the version commit and its tag:

   ```powershell
   git push origin main --follow-tags
   ```

The pushed `vX.Y.Z` tag starts `.github/workflows/publish.yml`. The workflow
refuses to publish unless the tagged commit is reachable from `main` and the
tag and `package.json` have the same version, then installs dependencies, runs
the test suite, verifies the package tarball, and publishes to npm.

Tagging a commit that is not on `main` fails the run before anything is
published, so a `v*` tag pushed from a local or unmerged branch cannot reach
npm.

After it completes, verify the GitHub Actions run, the npm registry version,
and a clean `npx -y google-tools-mcp@X.Y.Z` invocation.
