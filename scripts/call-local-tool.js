#!/usr/bin/env node
import fs from 'node:fs/promises';
import { registerAllTools } from '../dist/tools/index.js';

function createLocalServer() {
    const tools = new Map();
    return {
        addTool(toolDef) {
            if (tools.has(toolDef.name)) {
                throw new Error(`Duplicate tool registered: ${toolDef.name}`);
            }
            tools.set(toolDef.name, toolDef);
        },
        tools,
    };
}

function createLog(toolName) {
    const write = (level, args) => {
        const message = args.map((arg) => {
            if (typeof arg === 'string')
                return arg;
            try {
                return JSON.stringify(arg);
            }
            catch {
                return String(arg);
            }
        }).join(' ');
        process.stderr.write(`[${toolName}:${level}] ${message}\n`);
    };
    return {
        debug: (...args) => write('debug', args),
        info: (...args) => write('info', args),
        warn: (...args) => write('warn', args),
        error: (...args) => write('error', args),
    };
}

async function readArgs(rawArgs) {
    if (!rawArgs || rawArgs.length === 0) {
        return {};
    }
    if (rawArgs.every((arg) => arg.includes('='))) {
        return Object.fromEntries(rawArgs.map((arg) => {
            const index = arg.indexOf('=');
            return [arg.slice(0, index), parseValue(arg.slice(index + 1))];
        }));
    }
    const joined = rawArgs.join(' ');
    if (joined.startsWith('@')) {
        return JSON.parse(await fs.readFile(joined.slice(1), 'utf8'));
    }
    return JSON.parse(joined);
}

function parseValue(value) {
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    if (value === 'null')
        return null;
    if (/^-?\d+(?:\.\d+)?$/.test(value))
        return Number(value);
    return value;
}

function printResult(result) {
    if (typeof result === 'string') {
        process.stdout.write(result);
        if (!result.endsWith('\n'))
            process.stdout.write('\n');
        return;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

const [, , toolName, ...rawArgs] = process.argv;
const server = createLocalServer();
await registerAllTools(server);

if (!toolName || toolName === 'list' || toolName === '--list') {
    for (const name of [...server.tools.keys()].sort()) {
        process.stdout.write(`${name}\n`);
    }
    process.exit(toolName ? 0 : 1);
}

const tool = server.tools.get(toolName);
if (!tool) {
    process.stderr.write(`Unknown tool: ${toolName}\n\nAvailable tools:\n`);
    for (const name of [...server.tools.keys()].sort()) {
        process.stderr.write(`  ${name}\n`);
    }
    process.exit(1);
}

try {
    const parsedArgs = await readArgs(rawArgs);
    const args = tool.parameters?.parse ? tool.parameters.parse(parsedArgs) : parsedArgs;
    const result = await tool.execute(args, { log: createLog(toolName) });
    printResult(result);
}
catch (error) {
    process.stderr.write((error?.stack || error?.message || String(error)) + '\n');
    process.exit(1);
}
