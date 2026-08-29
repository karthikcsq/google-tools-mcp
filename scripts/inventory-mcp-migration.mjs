#!/usr/bin/env node
/**
 * Deterministic baseline for the fastmcp-to-SDK migration.
 *
 * This deliberately inventories tracked and non-ignored untracked source files
 * rather than walking the filesystem, so a snapshot generated before staging
 * still covers new runtime/tests while node_modules, build artifacts, editor
 * files, and ignored local output cannot change the report. The default tool
 * count is loaded through the production registerAllTools path with legacy
 * aliases disabled.
 *
 * Usage:
 *   node scripts/inventory-mcp-migration.mjs          # readable report
 *   node scripts/inventory-mcp-migration.mjs --json   # stable JSON on stdout
 *   node scripts/inventory-mcp-migration.mjs --write-snapshot tests/fixtures/mcp-migration-inventory.json
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs']);

function asRepositoryPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function lineNumberAt(source, offset) {
    return source.slice(0, offset).split('\n').length;
}

function findMatches(source, expression) {
    const matches = [];
    for (const match of source.matchAll(expression)) {
        matches.push({ line: lineNumberAt(source, match.index), match: match[0].replace(/\s+/g, ' ').trim() });
    }
    return matches;
}

function repositorySourceFiles(repositoryRoot) {
    const gitRoot = asRepositoryPath(repositoryRoot);
    const output = execFileSync(
        'git',
        // Include intentional, non-ignored additions so a snapshot can be
        // regenerated before its accompanying tests are committed. Filter
        // deleted index entries below for the same reason.
        ['-c', `safe.directory=${gitRoot}`, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'dist/**', 'tests/**'],
        { cwd: repositoryRoot, encoding: 'utf8' },
    );
    const deleted = new Set(execFileSync(
        'git',
        ['-c', `safe.directory=${gitRoot}`, 'ls-files', '--deleted', '--', 'dist/**', 'tests/**'],
        { cwd: repositoryRoot, encoding: 'utf8' },
    ).split(/\r?\n/).filter(Boolean));

    const files = output
        .split(/\r?\n/)
        .filter(Boolean)
        .filter((file) => !deleted.has(file))
        .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
        .sort();

    return {
        runtime: files.filter((file) => file.startsWith('dist/')),
        tests: files.filter((file) => file.startsWith('tests/')),
    };
}

async function inspectFiles(repositoryRoot, files) {
    const inspected = [];
    for (const file of files) {
        const source = await readFile(path.join(repositoryRoot, file), 'utf8');
        inspected.push({ file, source });
    }
    return inspected;
}

function reportImportLocations(inspectedFiles, modulePattern) {
    const expression = new RegExp(
        String.raw`^\s*(?:import|export)\s+(?:[^;\r\n]*?\s+from\s+)?['"](${modulePattern})['"]`,
        'gm',
    );
    return inspectedFiles.flatMap(({ file, source }) =>
        findMatches(source, expression).map((location) => ({ file, ...location })),
    );
}

function reportUserErrorImports(inspectedFiles) {
    const expression = /\bimport\s+(?:type\s+)?\{[^}]*\bUserError\b[^}]*\}\s+from\s+['"]fastmcp['"]/g;
    return inspectedFiles.flatMap(({ file, source }) =>
        findMatches(source, expression).map((location) => ({ file, ...location })),
    );
}

function reportAddToolRegistrations(inspectedFiles) {
    // The object-literal form is the current tool registration seam. Restrict
    // this to runtime files so test mocks do not inflate the migration count.
    const expression = /\.addTool\s*\(\s*\{/g;
    return inspectedFiles.flatMap(({ file, source }) =>
        findMatches(source, expression).map((location) => ({ file, ...location })),
    );
}

function reportContextLogCallSites(inspectedFiles) {
    const expression = /\bcontext\s*\.\s*log\s*\(/g;
    return inspectedFiles.flatMap(({ file, source }) =>
        findMatches(source, expression).map((location) => ({ file, ...location })),
    );
}

function withTemporaryEnvironment(name, value) {
    const hadValue = Object.prototype.hasOwnProperty.call(process.env, name);
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;

    return () => {
        if (hadValue) process.env[name] = previous;
        else delete process.env[name];
    };
}

async function loadDefaultToolCount(repositoryRoot) {
    const restoreAliases = withTemporaryEnvironment('GOOGLE_MCP_ENABLE_LEGACY_ALIASES', undefined);
    const restoreLogLevel = withTemporaryEnvironment('LOG_LEVEL', 'silent');
    const restoreLogFile = withTemporaryEnvironment('GOOGLE_MCP_LOG_FILE', undefined);

    try {
        const { registerAllTools } = await import(pathToFileURL(path.join(repositoryRoot, 'dist/tools/index.js')).href);
        const tools = new Map();
        const server = {
            addTool(tool) {
                if (tools.has(tool.name)) {
                    throw new Error(`Duplicate default tool registration: ${tool.name}`);
                }
                tools.set(tool.name, tool);
            },
        };
        await registerAllTools(server);
        return tools.size;
    } finally {
        restoreLogFile();
        restoreLogLevel();
        restoreAliases();
    }
}

function inventoryFileEntries(files) {
    return files.map((file) => ({ file }));
}

export async function collectMigrationInventory({ repositoryRoot = REPOSITORY_ROOT } = {}) {
    const files = repositorySourceFiles(repositoryRoot);
    const runtime = await inspectFiles(repositoryRoot, files.runtime);
    const tests = await inspectFiles(repositoryRoot, files.tests);
    const allSource = [...runtime, ...tests];

    return {
        schemaVersion: 1,
        inventoryScope: {
            runtime: 'Tracked and non-ignored untracked dist/**/*.js and dist/**/*.mjs files',
            tests: 'Tracked and non-ignored untracked tests/**/*.js and tests/**/*.mjs files',
        },
        files: {
            runtime: inventoryFileEntries(files.runtime),
            tests: inventoryFileEntries(files.tests),
        },
        findings: {
            fastMcpImports: reportImportLocations(allSource, 'fastmcp'),
            rawMcpSdkImports: reportImportLocations(allSource, '@modelcontextprotocol/sdk(?:/[^\'"\\r\\n]+)?'),
            addToolRegistrations: reportAddToolRegistrations(runtime),
            userErrorImports: reportUserErrorImports(allSource),
            contextLogCallSites: reportContextLogCallSites(runtime),
            loadedDefaultToolCount: await loadDefaultToolCount(repositoryRoot),
        },
    };
}

export function formatHumanReport(inventory) {
    const { files, findings } = inventory;
    const sections = [
        ['FastMCP imports', findings.fastMcpImports],
        ['Raw @modelcontextprotocol/sdk imports', findings.rawMcpSdkImports],
        ['Runtime addTool registrations', findings.addToolRegistrations],
        ['UserError imports', findings.userErrorImports],
        ['Runtime context.log call sites', findings.contextLogCallSites],
    ];
    const lines = [
        'MCP migration inventory',
        `Tracked runtime source files: ${files.runtime.length}`,
        `Tracked test source files: ${files.tests.length}`,
        `Loaded default tool count: ${findings.loadedDefaultToolCount}`,
    ];

    for (const [label, locations] of sections) {
        lines.push('', `${label}: ${locations.length}`);
        for (const { file, line, match } of locations) {
            lines.push(`  ${file}:${line}  ${match}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

async function main(argv) {
    const inventory = await collectMigrationInventory();
    const writeIndex = argv.indexOf('--write-snapshot');
    if (writeIndex !== -1) {
        const destination = argv[writeIndex + 1];
        if (!destination || destination.startsWith('--')) {
            throw new Error('--write-snapshot requires a destination path');
        }
        const target = path.resolve(process.cwd(), destination);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
    }

    if (argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    } else {
        process.stdout.write(formatHumanReport(inventory));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`MCP migration inventory failed: ${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}
