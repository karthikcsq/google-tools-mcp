// Regression coverage for issue #114 and the same class of defect elsewhere:
// caller-controlled text must never reach a shell interpreter.
import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatShellCommand, runArgv, shellQuote } from '../dist/shellSafe.js';
import { openBrowser, tryGhCli } from '../dist/tools/index.js';

jest.setTimeout(60_000);

// Every metacharacter class the issue named: command substitution in both
// syntaxes, a statement separator, a background/AND operator, quotes, spaces,
// a cmd.exe variable expansion, and a redirect.
const HOSTILE = `$(touch /tmp/gtm-pwned) \`touch /tmp/gtm-pwned\`; touch /tmp/gtm-pwned & "quoted" 'single' %PATH% > out.txt`;

describe('shell-free external command execution', () => {
    it('passes a hostile feedback issue title to gh as one literal argv element', async () => {
        const calls = [];
        const result = await tryGhCli(HOSTILE, 'body\nwith\nnewlines', 'bug', {
            run: async (argv) => { calls.push(argv); return 'https://github.com/karthikcsq/google-tools-mcp/issues/1\n'; },
        });

        expect(result).toMatchObject({ ok: true, issueUrl: 'https://github.com/karthikcsq/google-tools-mcp/issues/1' });
        expect(calls.map(([command]) => command)).toEqual(['gh', 'gh', 'gh']);
        // Nothing is ever a single joined string: every call is an argv array.
        expect(calls.every((argv) => Array.isArray(argv) && argv.every((value) => typeof value === 'string'))).toBe(true);

        const create = calls.at(-1);
        expect(create.slice(0, 5)).toEqual(['gh', 'issue', 'create', '--repo', 'karthikcsq/google-tools-mcp']);
        // One element, byte-for-byte, immediately after --title.
        expect(create[create.indexOf('--title') + 1]).toBe(HOSTILE);
        expect(create.filter((value) => value === HOSTILE)).toHaveLength(1);
        expect(create[create.indexOf('--label') + 1]).toBe('bug');
        const bodyFile = create[create.indexOf('--body-file') + 1];
        expect(path.isAbsolute(bodyFile)).toBe(true);
        // The temp body file is cleaned up, and the body never becomes an argument.
        await expect(fs.access(bodyFile)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(create).not.toContain('body\nwith\nnewlines');
    });

    it('reports a gh failure without executing anything else', async () => {
        const notInstalled = await tryGhCli(HOSTILE, 'body', 'bug', { run: async () => { throw new Error('nope'); } });
        expect(notInstalled).toMatchObject({ ok: false, reason: 'gh CLI not installed' });

        let seen = 0;
        const unauthenticated = await tryGhCli(HOSTILE, 'body', 'bug', {
            run: async () => { seen += 1; if (seen > 1) throw new Error('gh auth login required'); return ''; },
        });
        expect(unauthenticated).toMatchObject({ ok: false, reason: expect.stringContaining('not authenticated') });
        expect(seen).toBe(2);
    });

    it('opens the browser fallback through argv rather than a shell string', async () => {
        const url = 'https://github.com/karthikcsq/google-tools-mcp/issues/new?title=a%3Bb%26c';
        for (const [platform, expected] of [
            ['win32', ['rundll32.exe', 'url.dll,FileProtocolHandler', url]],
            ['darwin', ['open', url]],
            ['linux', ['xdg-open', url]],
        ]) {
            const calls = [];
            await expect(openBrowser(url, { platform, run: async (argv) => { calls.push(argv); } })).resolves.toBe(true);
            expect(calls).toEqual([expected]);
        }
        await expect(openBrowser(url, { platform: 'linux', run: async () => { throw new Error('no display'); } })).resolves.toBe(false);
    });

    it('delivers metacharacters verbatim to a real child process and runs no second command', async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'google-tools-mcp-shell-safe-'));
        try {
            const sentinel = path.join(root, 'pwned.txt');
            const recorder = path.join(root, 'recorder.mjs');
            const captured = path.join(root, 'argv.json');
            await fs.writeFile(recorder,
                `import { writeFileSync } from 'node:fs';\n` +
                `writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`, 'utf8');
            // A payload that would create the sentinel if any shell interpreted it.
            const payload = `x$(echo p > ${sentinel})\`echo p > ${sentinel}\`; echo p > ${sentinel} & echo p > ${sentinel} | %PATH% "q" 'q'`;

            // `node` is deliberately extensionless: on Windows that is the
            // cmd.exe-wrapped branch of runArgv, which is the branch that has to
            // neutralize metacharacters.
            await runArgv(['node', recorder, captured, payload, 'two words']);

            expect(JSON.parse(await fs.readFile(captured, 'utf8'))).toEqual([payload, 'two words']);
            await expect(fs.access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it('surfaces a child failure as a rejection carrying stderr', async () => {
        await expect(runArgv(['node', '-e', 'process.stderr.write("child said no"); process.exit(3);']))
            .rejects.toThrow(/child said no/);
        expect(() => runArgv([])).toThrow(/non-empty argv/);
    });

    it('renders display-only commands with platform-correct quoting', () => {
        // Values that need no quoting stay bare, which is what keeps generated
        // client-registration instructions readable.
        expect(formatShellCommand(['codex', 'mcp', 'add', 'google', '--url', 'http://127.0.0.1:3939/mcp'], 'linux'))
            .toBe('codex mcp add google --url http://127.0.0.1:3939/mcp');
        expect(shellQuote('/mcp;id;:', 'linux')).toBe("'/mcp;id;:'");
        expect(shellQuote('a$b`c', 'linux')).toBe("'a$b`c'");
        expect(shellQuote("it's", 'linux')).toBe("'it'\\''s'");
        expect(shellQuote('a b', 'win32')).toBe('"a b"');
        expect(shellQuote('', 'linux')).toBe("''");
        // `%` is never left bare, so a POSIX-rendered line is also paste-safe in cmd.exe.
        expect(shellQuote('%PATH%', 'linux')).toBe("'%PATH%'");
    });
});
