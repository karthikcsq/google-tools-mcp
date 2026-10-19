// Node loader used by offline.mjs.  It redirects exactly this checkout's
// clients module, leaving every other import to Node's normal resolver.
let targetClientsUrl = null;
let offlineClientsUrl = null;

export function initialize(data) {
    targetClientsUrl = data?.targetClientsUrl ?? null;
    offlineClientsUrl = data?.offlineClientsUrl ?? null;
}

export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    if (targetClientsUrl && offlineClientsUrl && resolved.url === targetClientsUrl) {
        return { url: offlineClientsUrl, shortCircuit: true };
    }
    return resolved;
}
