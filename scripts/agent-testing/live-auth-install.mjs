import { register } from 'node:module';

// Register before any production client imports. Only this checkout's auth
// module is redirected; normal server processes retain their auth behavior.
export function installReadOnlyAuth() {
    register(new URL('./live-auth-loader.mjs', import.meta.url), {
        parentURL: import.meta.url,
        data: {
            target: new URL('../../dist/auth.js', import.meta.url).href,
            replacement: new URL('./live-auth.mjs', import.meta.url).href,
        },
    });
}
