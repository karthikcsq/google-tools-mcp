# Plan mapping: correct Docs read/write state and isolate working copies (#87)

Issue: [#87](https://github.com/karthikcsq/google-tools-mcp/issues/87) (canonical for closed #94, #97). Superseded for implementation by the [MCP 2026-07-28 migration](mcp-2026-07-28-migration.md).

## Status and closure rule

#87 remains open until the migration implementation lands with the acceptance gates below. It is not a standalone PR: its former session-keyed tracker and disconnect cleanup would reintroduce a protocol model the new specification removes. Close #87 only from the merged migration PR after its opaque-handle, workspace, and connection-state tests pass.

## Verified root causes mapped to the migration

The original symptoms still require resolution:

1. `guardMutation` used Drive `modifiedTime`, so metadata-only activity falsely blocked content-safe writes.
2. Document creators did not seed read state, so create-then-write failed.
3. Workspace paths collided because they were keyed by document/tab while tracker state was keyed by HTTP session.
4. Seven Docs mutators bypassed `guardMutation`, including `insertImage` after it could upload a file.
5. Tab scope, working-copy freshness, and cleanup semantics were undocumented.

The migration resolves the common cause with a stateless model. A successful Docs read mints a high-entropy opaque `readHandle` whose server-side record is bound to authenticated `principal`, Google `profile`, `fileId`, `tabId`, `revisionId`, structural `fingerprint`, `issuedAt`, and `expiresAt`. The handle record, not a revision string, authorizes an HTTP Docs mutation. Revision-first checking, markdown plus structural-fingerprint comparison, and create seeding remain the guard mechanics behind that binding.

HTTP requires a valid, unexpired handle and rejects guessed, swapped, or stale bindings before a Google write. `expectedRevisionId` is only a caller-visible compare-and-write assertion: when supplied, it must agree with the validated handle record; the `WriteControl` value comes from that record. It never authorizes a write alone. Only a pinned stdio connection may use implicit current-read state, which is scoped to that live connection and destroyed at shutdown; it may also pass a handle explicitly.

## Required migration implementation mapping

1. `readTracker.js`: implement revision-first guarding, structural-fingerprint equality, scoped snapshots, and documented fetch-error behavior inside a process-local opaque-handle store. Do not key authorization globally by `(fileId, revisionId)`.
2. HTTP Docs mutations require and validate the handle's principal/profile/file/tab/revision/fingerprint bindings and expiry, then use the stored revision for `WriteControl`. Stdio implicit state is connection-local, not process-global.
3. Seed canonical post-create reads for `createDocument` (raw, markdown, and empty) and successful `createFromTemplate`; do not seed `copyFile` or partial template results. Seed Sheets creators within their existing model.
4. Guard all seven bypassing Docs tools before their side effects. `insertImage` must guard before Drive upload.
5. Give every handle a unique editable workspace. Build it from a shareable content-addressed immutable baseline keyed by profile/file/tab/revision/fingerprint, but never share editable files between handles, even when reads observe the same revision. TTL preserves dirty workspace files and removes only clean managed files under the migration's recovery contract.
6. Update architecture and tool descriptions to explain handle authorization, HTTP versus stdio behavior, scope, expiry, copy-then-edit rules, shared baselines, and dirty-file recovery.

## Required tests

- Metadata changed with revision unchanged proceeds; revision changes are checked through the handle record; equal markdown plus equal fingerprint may re-arm, while altered fingerprint or content blocks with an explanation.
- HTTP rejects missing, malformed, guessed, expired, principal/profile/file/tab/revision/fingerprint-swapped handles without a Google write. A revision string alone cannot authorize a mutation; a mismatched `expectedRevisionId` fails before write.
- A pinned stdio connection can use only its own implicit current-read state; a second connection cannot consume it, and shutdown clears it.
- `createDocument` (markdown, raw, empty), successful template creation, and Sheets creation can immediately write. Failed template creation and `copyFile` remain unseeded and are rejected.
- Every formerly bypassing Docs mutator rejects an unauthorized or never-read document, sends the validated stored revision as `WriteControl`, and rejects a genuine external conflict. A rejected `insertImage` makes no Drive upload.
- Real HTTP E2E proves separate valid handles cannot cross-contaminate workspace or guard state. Two reads of identical content get distinct editable workspaces but may share one immutable baseline. TTL preserves every dirty file.

## Acceptance criteria

- Metadata-only changes do not reject a content-identical Docs write.
- HTTP mutations require an unguessable server-minted handle bound to the correct principal, profile, document, tab, revision, and fingerprint; a revision string alone cannot authorize them.
- Stdio implicit state is connection-pinned and survives no connection boundary.
- Create-then-immediately-write succeeds for creators whose content is knowable; it is correctly refused for `copyFile` and failed template fills.
- All mutating Docs tools reject unauthorized or never-read documents; `insertImage` rejects before uploading.
- Concurrent reads never share editable workspaces, while immutable baselines can be shared; TTL preserves dirty files.
- Genuine external edits still reject with a useful conflict result and the failure rule is documented and tested.

## Dependencies

The migration is the sole implementation vehicle and must land before #71, #75, #88, and #105–#108. #56 verifies migration-owned create-then-write coverage. #106 owns post-migration editable-copy, baseline, divergence, and dirty-TTL details; #88 then consumes the validated handle contract; #108 later adds range overlap and re-resolution.
