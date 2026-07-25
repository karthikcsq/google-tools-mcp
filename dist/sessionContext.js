// Per-request session scoping.
//
// In stdio mode there is exactly one client per process, so module-global state
// (e.g. the read-before-edit tracker in readTracker.js) is implicitly
// per-client. In shared HTTP mode a single process serves many clients, so that
// same global state would leak across clients — one client's "I read this doc"
// would satisfy another client's mutation guard, and their content snapshots
// would clobber each other (see PR #36 review).
//
// This module carries the current request's session key ambiently via
// AsyncLocalStorage so stateful helpers can namespace their data per session
// without every tool having to thread a session id through its call sites.
// Outside a request (stdio, startup) the key is null, which maps to a single
// default namespace — preserving the original single-client behavior exactly.
import { AsyncLocalStorage } from 'node:async_hooks';

const sessionStore = new AsyncLocalStorage();

/**
 * Run `fn` with `sessionKey` bound as the ambient session for the duration of
 * the (possibly async) call. Returns whatever `fn` returns.
 * @param {string|null|undefined} sessionKey
 * @param {() => any} fn
 */
export function runWithSession(sessionKey, fn) {
    return sessionStore.run(sessionKey ?? null, fn);
}

/**
 * The current ambient session key, or null when running outside a request
 * (stdio transport, server startup). null is a valid namespace key.
 * @returns {string|null}
 */
export function currentSessionKey() {
    const key = sessionStore.getStore();
    return key === undefined ? null : key;
}
