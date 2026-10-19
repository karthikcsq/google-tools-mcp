let target;
let replacement;
export function initialize(data) { ({ target, replacement } = data); }
export async function resolve(specifier, context, nextResolve) {
    const resolved = await nextResolve(specifier, context);
    // The query is the private escape used by the replacement for pure exports.
    if (resolved.url === target) return { url: replacement, shortCircuit: true };
    return resolved;
}
