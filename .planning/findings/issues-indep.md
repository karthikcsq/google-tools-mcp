## Issue #115: Re-auth can finish without replacing the refresh token

## Summary

The interactive OAuth re-authentication flow requests `access_type: 'offline'` but does not request re-consent. Google documents that a refresh token is returned on the **first** authorization; when a new refresh token is needed after a prior grant, `prompt=consent` is the mechanism for prompting re-authorization.

This can make the server report a successful re-authentication while failing to persist any usable replacement refresh token.

## Concrete failure mode

1. The user has previously authorized this OAuth client, so Google already has a consent grant for the client/user pair.
2. The local `token.json` is deleted, becomes scope-stale, or the saved refresh token reaches the `invalid_grant` recovery path.
3. `authenticate()` generates a new authorization URL with only:

```js
{
  access_type: 'offline',
  scope: SCOPES.join(' '),
}
```

4. Because this is not the first authorization and the flow does not force re-consent, Google can exchange the code without returning `tokens.refresh_token`.
5. The implementation logs `Did not receive refresh token. Token might expire.`, skips `saveCredentials()`, then still logs `Authentication successful!` and returns the access-token-only client.
6. The current process works until that access token expires, but no replacement `token.json` was saved. The next process/tool authorization therefore starts the browser flow again instead of recovering persistent offline access.

The `invalid_grant` branch is especially direct: it deletes the old token and immediately calls this same `authenticate()` path, so a recovery intended to replace a revoked refresh token can complete without persisting its replacement.

## Evidence

Current implementation (also present before PR #112):
https://github.com/karthikcsq/google-tools-mcp/blob/220f97fb744289d5cc68943da28f6c2d88baa817/dist/auth.js

The same authorization URL behavior is present at PR #112's base, confirming this exists independently of the PR:
https://github.com/karthikcsq/google-tools-mcp/blob/45fc243e80a8555c9e5e828289ca60a9dab840e3/dist/auth.js

Google's current OAuth documentation says `access_type=offline` causes a refresh token to be returned the first time the code is exchanged, and documents `prompt=consent` for prompting re-consent when needed:
https://developers.google.com/identity/protocols/oauth2/web-server

Review context where this was found:
https://github.com/karthikcsq/google-tools-mcp/pull/112

## Smallest fix / acceptance criteria

- When the flow is specifically re-authenticating because persistent credentials are absent/stale/revoked, request re-consent so the exchange is expected to produce a refresh token. A targeted `prompt: 'consent'` on recovery/explicit `--reauth` is preferable to forcing consent on every first-time login.
- Do not report persistent authentication success when the flow required a replacement refresh token but Google returned none.
- Add a regression test where the token exchange returns only an access token during a recovery flow. The flow must either obtain/retry with explicit consent or fail clearly without claiming durable authentication.

Found by an automated Adversarial Review on behalf of Elliot while tracing the authentication paths touched by PR #112.


## Issue #124: copyFile silently ignores the name parameter

## Description

**What happened:** `copyFile` accepted a `name` argument and returned a file named `"Copy of <original>"` instead. No error, no warning that the parameter was dropped.

**Repro:** `copyFile(fileId='1lgUTj4ETTeuYFNB4u5WqifDXxvneVRCtDab_gTpruN0', name='TEMP - markdown push test - DELETE ME')` → returns `{"name": "Copy of Kickoff Email Drafts - Partner, Guest, Net-New"}`.

**Expected:** the copy is created with the requested name, since Drive's `files.copy` supports `name` in the request body. Failing that, reject the unsupported parameter instead of dropping it.

**Why it matters:** naming a throwaway copy is how you keep a temporary artifact from being mistaken for real content in a shared Drive folder.

**Evidence:** 2026-08-28, google-tools-mcp.

<details>
<summary>Diagnostic Info</summary>

- **Server version:** 2.0.0
- **Node version:** v22.22.3
- **OS:** win32 10.0.26200 (x64)
- **Auth status:** valid
- **Scopes:** documents, drive, spreadsheets, script.external_request, gmail.modify, gmail.compose, gmail.send, gmail.settings.basic, gmail.settings.sharing, calendar, forms.body, forms.body.readonly, forms.responses.readonly, presentations, tasks, service.management

</details>
