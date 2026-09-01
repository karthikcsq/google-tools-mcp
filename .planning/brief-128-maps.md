# Brief: #128 — make Maps PERMISSION_DENIED actionable

Worktree: `C:/Users/2supe/All Coding/Google-Tools-MCP/gtm-128`
Branch: `fix/maps-128`, off `main` @ `a95bf30`
`node_modules` is already present and correct. Do NOT run `npm install` or touch `package.json` / `package-lock.json`. Another agent is changing the lockfile on a different branch right now and a conflict here would be pure waste.

Read `.planning/constraints.md` in the main worktree first. Overrides for this run: you have network access, but you should not need it. Do not touch GitHub (no `gh` commands, no comments, no PRs). Do not commit to `main`.

## The bug

GitHub issue #128. `mapsSearchPlaces` returned:

```
Google Maps API error (PERMISSION_DENIED): The caller does not have permission
```

Every other tool in the session worked. The reporter's OAuth was fine. The real cause is almost certainly that the Places API is not enabled on the Google Cloud project behind `GOOGLE_MAPS_API_KEY`, or the key is restricted so it cannot call that API. The message gives the user no path forward, and the issue notes that `troubleshoot` will not help because it reports overall auth as healthy and never probes a single API's authorization.

## Where it lives

`dist/tools/maps/mapsClient.js:55`, inside `mapsFetch`:

```js
const status = data?.error?.status || data?.status || response.status;
const message = data?.error?.message || data?.error_message || response.statusText || 'Unknown error';
throw new UserError(redactSecrets(`Google Maps API error (${status}): ${message}`));
```

`mapsFetch` is the single choke point. Every Maps call routes through it, either directly or via `placesRequest`. So one change here fixes all seven call sites.

## The mapping you need

`mapsFetch` already receives the request `url`, so the endpoint is known at the point of failure. There are exactly three host/path families in the repo, verified with `grep -rn "googleapis.com" dist/tools/maps/*.js`:

| URL | Google Cloud API to name | Call sites |
| --- | --- | --- |
| `https://places.googleapis.com/v1/...` | **Places API (New)** | `searchPlaces.js:20`, `searchNearby.js:41,48`, `placeDetails.js:12` |
| `https://maps.googleapis.com/maps/api/geocode/json?...` | **Geocoding API** | `geocode.js:11`, `reverseGeocode.js:14` |
| `https://routes.googleapis.com/directions/v2:computeRoutes` | **Routes API** | `directions.js:55` |

Derive the API name from the URL. Do not thread a new argument down from all seven call sites; that is more surface for no benefit. A small pure exported helper (name it something like `mapsApiNameForUrl`) that takes the URL and returns the display name, defaulting to a generic "the Google Maps Platform API" for anything unrecognized, is the right shape and is trivially unit-testable on its own.

## What the new message should say

When, and only when, the failure looks like an authorization problem, append guidance. Treat these as the authorization signals:

- `data.error.status === 'PERMISSION_DENIED'`
- `data.status === 'REQUEST_DENIED'` (the legacy Geocoding endpoint uses this shape)
- `response.status === 403`

The guidance must name the specific API and the specific fix. Something along the lines of:

> This usually means the **Places API (New)** is not enabled on the Google Cloud project for your `GOOGLE_MAPS_API_KEY`, or the key has API restrictions that exclude it. Enable it at https://console.cloud.google.com/apis/library and check the key's restrictions at https://console.cloud.google.com/apis/credentials. This key is separate from your Google OAuth credentials, so the other tools in this server working does not mean this key is configured.

Write the final wording yourself; match the voice of the existing `getMapsApiKey` error at `mapsClient.js:15`, which is short, concrete, and already makes the "separate from OAuth" point. Keep the original `status` and `message` in the output so the raw API signal is not lost.

Non-authorization failures must be completely unchanged. `ZERO_RESULTS`, `OVER_QUERY_LIMIT`, `INVALID_ARGUMENT`, an unparsable body, a 500, a transport error: all keep their current text and their current class.

## Hard constraints

- Everything you emit still goes through `redactSecrets(...)`. The guidance text you add contains no secrets, but do not restructure the call so that any part of the message bypasses that boundary. The comment above `redactSecrets` at `mapsClient.js:24` explains why it is the single boundary; respect it.
- Never interpolate a caught transport error's message into caller-visible text. The existing `wrapOperationError('Google Maps request', error, ...)` path at line 43 is correct as-is. Leave it alone.
- Do not change `formatPlace`, `haversineMeters`, `withinRadius`, `dedupePlaces`, or any tool schema.
- No new dependencies.

## Tests

`tests/maps.test.js` exists. Extend it. Required coverage:

1. The URL-to-API-name helper, directly, for all three families plus the unknown fallback.
2. A `PERMISSION_DENIED` response from a `places.googleapis.com` URL produces a message naming Places API (New) and still containing `PERMISSION_DENIED`.
3. A `REQUEST_DENIED` response from the legacy geocode URL produces a message naming the Geocoding API.
4. A bare HTTP 403 with no parseable body from `routes.googleapis.com` names the Routes API.
5. A non-authorization error (pick `OVER_QUERY_LIMIT` and a 500) produces byte-identical text to what `main` produces today. Assert the exact string, so a future change to the guidance cannot silently bleed into unrelated errors.
6. The key is still redacted when a `PERMISSION_DENIED` message happens to contain a `key=` query parameter.

## Gates, all of which must pass before you report done

1. `npm test` from the worktree root. Report the **`Test Suites:`** line verbatim, not just the `Tests:` line. A suite that fails to link reports zero failed tests while being completely broken, so `Tests:` alone is not evidence of anything.
2. The suite count must be at least 91 and the failed count must be 0.
3. `git diff --stat` against `main`, so the blast radius is visible.
4. Commit on `fix/maps-128` with a message that says what changed and why. Do not push, do not open a PR.

## Report back

- The exact new message text for each of the three APIs.
- The `Test Suites:` and `Tests:` lines verbatim.
- The `git diff --stat`.
- Anything you found that contradicts this brief. If a stated precondition here is false, stop and say so rather than working around it.
