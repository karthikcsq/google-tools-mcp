// Shell-free process execution plus display-only command rendering.
//
// Every automatic invocation of an external CLI (gh, codex, claude) goes
// through `runArgv()`, which never hands a caller-influenced string to a shell
// interpreter. Only `formatShellCommand()` produces a shell string, and that
// string is exclusively for humans to read or copy-paste; nothing in this
// codebase executes its output.
//
// Windows needs care. `execFile()` refuses to spawn a `.cmd`/`.bat` file
// without a shell (Node throws EINVAL since the CVE-2024-27980 fix), and both
// `codex` and `claude` ship as npm `.cmd` shims there. So on win32 we build the
// command line ourselves and hand it to `cmd.exe /d /s /c` with
// `windowsVerbatimArguments`, caret-escaping every metacharacter first. That is
// the cross-spawn algorithm: cmd strips the outer quote pair because of `/s`,
// then the caret escapes make every metacharacter literal, so a value like
// `a;b&c$(x)` arrives at the target program as one argv element and no second
// command is ever parsed.
import { execFile } from 'node:child_process';

// Characters cmd.exe treats specially. A caret in front of each one makes it
// literal for the duration of one parse.
const WINDOWS_META = /([()\][%!^"`<>&|;, *?])/g;

// POSIX shells leave this set alone unquoted. `%` is deliberately absent so the
// rendered display string is also safe to paste into cmd.exe.
const POSIX_SAFE = /^[A-Za-z0-9_@+=:,./-]+$/;

/** Caret-escape a command path for `cmd.exe /d /s /c`. Not quoted: cmd strips the outer pair. */
function escapeWindowsCommand(value) {
    return String(value).replace(WINDOWS_META, '^$1');
}

/** Quote-then-caret-escape one argument for `cmd.exe /d /s /c`. */
export function escapeWindowsArgument(value) {
    let arg = String(value);
    // Double every backslash run that precedes a quote, then escape the quote:
    // the MSVC command-line parser in the target program undoes exactly this.
    arg = arg.replace(/(\\*)"/g, '$1$1\\"');
    arg = arg.replace(/(\\*)$/, '$1$1');
    return `"${arg}"`.replace(WINDOWS_META, '^$1');
}

/**
 * Render one argv element for display. Never used to build something executed.
 * @param {string} value
 * @param {string} [platform]
 */
export function shellQuote(value, platform = process.platform) {
    const text = String(value);
    if (text === '') return platform === 'win32' ? '""' : "''";
    if (POSIX_SAFE.test(text)) return text;
    if (platform === 'win32') return `"${text.replaceAll('"', '\\"')}"`;
    // POSIX single-quoting is total: nothing inside is special, and an embedded
    // quote is closed, escaped, and reopened.
    return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * Render a whole argv array as a copy-pasteable command line for a human.
 * @param {string[]} argv
 * @param {string} [platform]
 */
export function formatShellCommand(argv, platform = process.platform) {
    return argv.map((value) => shellQuote(value, platform)).join(' ');
}

/**
 * Run `argv` with no shell involved. Resolves with stdout, rejects with an
 * Error carrying the child's stderr.
 * @param {string[]} argv command followed by its arguments
 * @param {{maxBuffer?: number, platform?: string, execFileImpl?: Function}} [options]
 */
export function runArgv(argv, { maxBuffer, platform = process.platform, execFileImpl = execFile } = {}) {
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
        throw new TypeError('runArgv requires a non-empty argv array whose first element is the command.');
    }
    const [command, ...args] = argv.map(String);
    const childOptions = { windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) };
    return new Promise((resolve, reject) => {
        const done = (error, stdout, stderr) => {
            if (!error) return resolve(String(stdout ?? ''));
            const failure = new Error(String(stderr || error.message || 'Command failed.').trim() || 'Command failed.');
            failure.stderr = stderr;
            failure.code = error.code;
            return reject(failure);
        };
        // A named `.exe` needs no interpreter, so spawn it directly and skip
        // cmd.exe entirely. Extensionless names (`gh`, `codex`, `claude`) still
        // need cmd for PATHEXT resolution and for npm's `.cmd` shims.
        if (platform === 'win32' && !/\.exe$/i.test(command)) {
            const line = [escapeWindowsCommand(command), ...args.map(escapeWindowsArgument)].join(' ');
            execFileImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
                { ...childOptions, windowsVerbatimArguments: true }, done);
            return;
        }
        execFileImpl(command, args, childOptions, done);
    });
}

/**
 * Open a URL through the platform browser without building an executable shell
 * string. Returns false on purpose when no browser is available.
 * @param {string} url
 * @param {{run?: typeof runArgv, platform?: string}} [options]
 */
export function openBrowser(url, { run = runArgv, platform = process.platform } = {}) {
    const argv = platform === 'win32'
        ? ['cmd', '/c', 'start', '', String(url)]
        : [platform === 'darwin' ? 'open' : 'xdg-open', String(url)];
    return run(argv).then(() => true, () => false);
}
