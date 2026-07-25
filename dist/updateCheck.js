// Best-effort check for a newer published version of google-tools-mcp.
//
// Why this exists: setup.js points MCP clients directly at a resolved
// dist/index.js instead of `npx -y google-tools-mcp` (see the fast-launch
// comment block in setup.js for why). That fixes the startup-timeout race
// against Claude Code's 30s connection timeout, but it also means nothing
// ever runs `npm install -g google-tools-mcp@latest` again on its own,
// unlike npx, which re-resolves to the latest published version on every
// launch. Left alone, a global-install user would keep running whatever
// version was installed at setup time forever, silently missing every
// release after that.
//
// This module is the read-only half of the fix: it looks up the latest
// version published to npm and reports whether the running copy is behind,
// so index.js can log a clear one-line nudge. It never modifies anything.
//
// This intentionally cannot reintroduce the npx timeout bug:
//   - index.js only calls checkForUpdate() AFTER `server.start()` has
//     already resolved, i.e. after the MCP stdio connection is established.
//     Nothing here runs before or during connection setup.
//   - index.js does not await that call. It is fire-and-forget, so even if
//     the network is completely unreachable, the server process itself is
//     never blocked or slowed by this.
//   - The registry fetch is also strictly time-boxed (default 2s, via
//     AbortSignal.timeout) so a hung connection can't leave anything dangling
//     for long, and any failure (timeout, offline, non-2xx, malformed body)
//     resolves to "couldn't check" rather than throwing.
//   - Results are cached to disk and reused for `intervalMs` (default 24h),
//     so most launches skip the network call entirely.
import * as path from 'path';

const REGISTRY_URL = 'https://registry.npmjs.org/google-tools-mcp/latest';
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2000;
const STATE_FILE_NAME = 'update-check.json';

// Exported for testing.
export function stateFilePath(configDir) {
    return path.join(configDir, STATE_FILE_NAME);
}

// Compares two `major.minor.patch`-style version strings. Anything after a
// `-` or `+` (pre-release/build metadata) is ignored, since the registry's
// `dist-tags.latest` for this package is always a plain release version.
// Missing/non-numeric segments are treated as 0. Returns 1 if a > b, -1 if
// a < b, 0 if equal or unparseable.
export function compareVersions(a, b) {
    const parse = (v) => String(v ?? '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10));
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = Number.isFinite(pa[i]) ? pa[i] : 0;
        const nb = Number.isFinite(pb[i]) ? pb[i] : 0;
        if (na !== nb) return na > nb ? 1 : -1;
    }
    return 0;
}

// Is `candidate` a real, strictly-newer version than `current`?
export function isNewerVersion(current, candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    return compareVersions(candidate, current) > 0;
}

// Pure throttle check: has enough time passed since `lastCheckedAt` (an ISO
// string or anything `new Date()` accepts) to justify another network call?
// Missing or unparseable timestamps always say "yes, check" so a corrupt
// cache file degrades to "check a bit more often" rather than "never check
// again".
export function shouldCheckNow(lastCheckedAt, now, intervalMs = DEFAULT_INTERVAL_MS) {
    if (!lastCheckedAt) return true;
    const last = new Date(lastCheckedAt).getTime();
    if (!Number.isFinite(last)) return true;
    return now - last >= intervalMs;
}

// Should the update check be skipped entirely, without touching the network
// or disk? Three ways to opt out:
//   - NO_UPDATE_NOTIFIER: the npm-ecosystem-standard opt-out env var, used by
//     the widely-adopted `update-notifier` package (the library most CLIs,
//     including npm itself, build this exact "is a newer version out"
//     nudge on top of). Per its README: "Users can also opt-out by setting
//     the environment variable NO_UPDATE_NOTIFIER with any value" (see
//     https://github.com/yeoman/update-notifier#readme, fetched 2026-07-25).
//     That is a presence check, not a truthiness check, so it is honored
//     here the same way: any value, including an empty string, counts.
//   - GOOGLE_MCP_NO_UPDATE_CHECK: this repo's own opt-out, following the
//     existing GOOGLE_MCP_* naming already used for GOOGLE_MCP_PROFILE and
//     GOOGLE_MCP_LOG_FILE. Same presence-check semantics as above.
//   - CI: nearly every CI system sets this, and it is the de facto standard
//     generic "am I running in CI" signal in the npm ecosystem (see the
//     `ci-info` package, which is what `is-ci`/many CLIs use to detect it,
//     and which treats CI=false as an explicit escape hatch back to "not
//     CI"; see https://github.com/watson/ci-info#readme, fetched 2026-07-25).
//     Automated/CI runs should never make an unannounced outbound call.
//
// This check is intentionally the very first thing checkForUpdate() does,
// before reading the cache file or touching the network, and it is a handful
// of object-property lookups, so it costs nothing even when the check would
// otherwise run.
export function isUpdateCheckDisabled(env = process.env) {
    if (!env) return false;
    if ('NO_UPDATE_NOTIFIER' in env) return true;
    if ('GOOGLE_MCP_NO_UPDATE_CHECK' in env) return true;
    if (env.CI && env.CI !== 'false') return true;
    return false;
}

async function readState(configDir, { readFile }) {
    try {
        const raw = await readFile(stateFilePath(configDir), 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function writeState(configDir, state, { mkdir, writeFile }) {
    try {
        await mkdir(configDir, { recursive: true });
        await writeFile(stateFilePath(configDir), JSON.stringify(state));
    } catch {
        // Best-effort cache only. If we can't persist it, we just eat the
        // cost of checking again next launch instead of surfacing an error.
    }
}

// Fetches the latest published version from the npm registry. Never throws:
// any network error, timeout, non-2xx response, or malformed body resolves
// to null, so callers can treat "couldn't check" the same as "nothing to
// report" instead of as a startup failure. `fetchImpl` defaults to the
// global `fetch` (available on Node 18+; this repo's CI runs 20 and 22).
export async function fetchLatestVersion({
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    url = REGISTRY_URL,
} = {}) {
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const body = await res.json();
        return typeof body?.version === 'string' ? body.version : null;
    } catch {
        return null;
    }
}

// Orchestrates the full best-effort check: read the cached state, decide
// whether enough time has passed to justify a network call, fetch the
// latest version if so, persist the result, and report whether the running
// copy is behind. Every dependency is injectable so tests never touch a
// real filesystem or network.
//
// Never throws. Any failure anywhere in this pipeline (corrupt cache,
// unwritable config dir, unreachable registry) resolves to
// `{ checked: false, latestVersion: null, updateAvailable: false }`, the
// safest possible answer, since callers only use this to decide whether to
// print an informational log line, never to gate startup.
export async function checkForUpdate({
    currentVersion,
    configDir,
    now = Date.now(),
    intervalMs = DEFAULT_INTERVAL_MS,
    fetchLatest = fetchLatestVersion,
    fetchOptions = {},
    readFile,
    writeFile,
    mkdir,
    env = process.env,
} = {}) {
    // Opt-out check comes first, before any disk read or network call. See
    // isUpdateCheckDisabled() above for the three ways to trigger this.
    if (isUpdateCheckDisabled(env)) {
        return { checked: false, latestVersion: null, updateAvailable: false, skipped: true };
    }
    try {
        const cached = await readState(configDir, { readFile });
        if (cached && !shouldCheckNow(cached.lastCheckedAt, now, intervalMs)) {
            return {
                checked: false,
                latestVersion: cached.latestVersion ?? null,
                updateAvailable: isNewerVersion(currentVersion, cached.latestVersion),
            };
        }

        const latestVersion = await fetchLatest(fetchOptions);
        await writeState(
            configDir,
            { lastCheckedAt: new Date(now).toISOString(), latestVersion },
            { mkdir, writeFile },
        );

        return {
            checked: true,
            latestVersion,
            updateAvailable: isNewerVersion(currentVersion, latestVersion),
        };
    } catch {
        return { checked: false, latestVersion: null, updateAvailable: false };
    }
}
