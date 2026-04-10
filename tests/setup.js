// Jest global setup — polyfill globals that undici/googleapis expect.
// Node 20+ has File globally, but some CI environments or older
// patch versions may not expose it in the Jest VM context.
import { Blob } from 'node:buffer';
import { ReadableStream, WritableStream, TransformStream } from 'node:stream/web';

if (typeof globalThis.File === 'undefined') {
    // Minimal File polyfill (extends Blob with name + lastModified)
    globalThis.File = class File extends Blob {
        constructor(chunks, name, opts) {
            super(chunks, opts);
            this.name = name;
            this.lastModified = opts?.lastModified ?? Date.now();
        }
    };
}

if (typeof globalThis.ReadableStream === 'undefined') {
    globalThis.ReadableStream = ReadableStream;
}
if (typeof globalThis.WritableStream === 'undefined') {
    globalThis.WritableStream = WritableStream;
}
if (typeof globalThis.TransformStream === 'undefined') {
    globalThis.TransformStream = TransformStream;
}
