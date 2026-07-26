# Changelog

## 2.0.0

First release since 1.2.12 (2026-06-01). Thirteen pull requests, one breaking change.

### Breaking

- **Gmail tool names are now camelCase, and the old `snake_case` names are opt-in** (#65).
  The Gmail surface was consolidated and renamed: `send_message` is now `sendMessage`,
  `get_thread` is now `getThread`, `create_draft` is now `createDraft`, and so on across
  the whole group. By default the server registers 156 tools, and the old Gmail names are
  not among them. (This rename covered Gmail only. The six `forms` tools still use
  snake_case and are unaffected.)

  If you have saved prompts, scripts, or client configs that call the old names, set:

  ```
  GOOGLE_MCP_ENABLE_LEGACY_ALIASES=true
  ```

  That registers the previous names as aliases alongside the new ones, for 228 tools
  total, and gives you time to migrate. The aliases are intended as a migration path
  rather than a permanent surface.

### Added

- **Google Maps and Places tools** (#66): `mapsDirections`, `mapsGeocode`,
  `mapsPlaceDetails`, `mapsReverseGeocode`, `mapsSearchNearby`, `mapsSearchPlaces`.
  Requires `GOOGLE_MAPS_API_KEY`, which is separate from OAuth. Without it the tools stay
  listed but fail with a clear error rather than disappearing.
- **Optional shared HTTP transport** (#59): set `GOOGLE_MCP_TRANSPORT=http` to run one
  long-lived server for many clients instead of spawning a process per client. Binds to
  `127.0.0.1` and requires a bearer token by default; refuses to start if you combine
  `GOOGLE_MCP_HTTP_NO_AUTH=1` with a non-loopback bind. Read-tracking state is isolated
  per session, but all clients share one process and one OAuth token.
- **Fidelity warnings when markdown is silently dropped** (#61, #69). Converting markdown
  to Docs previously discarded unsupported constructs without saying so. The markdown
  tools now report a warning count in their success line and list what was dropped.
  `readDocument` and `replaceDocumentWithMarkdown` also keep a local workspace copy so an
  edit-and-push cycle starts from current document state.
- **Optimistic concurrency on Docs writes** (#64). Replace, append, and modify now pass
  `WriteControl` with the revision they read, so a write fails instead of silently
  clobbering an edit someone else made in between.
- **Output size controls for Gmail threads and messages** (#63), so a large thread no
  longer blows past the response budget.
- **Trusted npm publishing** (#68). Releases publish from a tag via GitHub Actions OIDC
  with provenance, gated on environment approval. No npm token is stored in the repo.
  See `RELEASING.md`.
- **Startup timing on the server's ready line** (#70), plus a warning when startup exceeds
  5 seconds, to separate a slow server from a slow launcher.

### Fixed

- **Long email headers are folded per RFC 5322** (#60), resolving `Invalid Cc header` when
  sending to many recipients.
- **Ordered lists survive tab-scoped Docs reads** (#67); they previously came back
  flattened.
- **Emulated horizontal rules match Google's native line color** (#58).

### Changed

- `npx -y google-tools-mcp setup` now installs the package globally and points your MCP
  config at that install rather than at `npx` (#70). `npx` re-resolves the whole dependency
  tree on every launch, which on some machines takes long enough to lose the race against
  an MCP client's connection timeout. This widens the margin; it does not eliminate it.
  See #46, and #71 for the remaining dependency-size work.
- Documented that `dist/` is the hand-edited source for this repository, with no
  TypeScript, bundler, or build step (#62).
