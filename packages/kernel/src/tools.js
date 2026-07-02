/**
 * Built-in Tools
 *
 * Standard file/shell tools for Tik.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { safeResolve, safeResolveWorkspacePath } from './path-safety.js';
const execFileAsync = promisify(execFile);
function getPrimaryTargetScope(context) {
    const first = context.likelyTargetPaths?.[0];
    if (!first)
        return null;
    return first;
}
function isImplementationReady(context) {
    return Boolean(context.implementationReady);
}
async function isBroadSearchRoot(target, context) {
    if (!target)
        return true;
    const normalized = target.trim();
    if (!normalized || normalized === '.' || normalized === './')
        return true;
    const resolved = await safeResolveWorkspacePath(context.cwd, normalized, { allowDirectory: true });
    return resolved === await fs.realpath(context.cwd);
}
function normalizeGlobPattern(pattern) {
    if (pattern === '**/*' || pattern === './**/*')
        return '*';
    return pattern;
}
function normalizePathForMatch(value) {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}
function patternAlreadyTargetsScope(pattern, scopedTarget) {
    if (!scopedTarget)
        return false;
    const basename = normalizePathForMatch(path.basename(scopedTarget)).toLowerCase();
    const normalizedPattern = normalizePathForMatch(pattern).toLowerCase();
    return normalizedPattern.startsWith(`${basename}/`) || normalizedPattern === basename || normalizedPattern.startsWith(`${basename}**`);
}
async function resolveGlobBaseDir(pattern, cwd, context) {
    const scopedTarget = getPrimaryTargetScope(context);
    if (!(await isBroadSearchRoot(cwd, context))) {
        return cwd
            ? safeResolveWorkspacePath(context.cwd, cwd, { allowDirectory: true })
            : context.cwd;
    }
    if (patternAlreadyTargetsScope(pattern, scopedTarget)) {
        return context.cwd;
    }
    return scopedTarget
        ? safeResolve(context.cwd, scopedTarget, { allowAbsolute: true, allowDirectory: true })
        : context.cwd;
}
function isBroadShellSearchRoot(target, context) {
    if (!target)
        return true;
    const normalized = target.trim();
    if (!normalized || normalized === '.' || normalized === './')
        return true;
    const resolved = path.resolve(context.cwd, normalized);
    return resolved === context.cwd;
}
function guardBashCommand(command, context) {
    const normalized = command.trim();
    if (/^find\s+.+\s-name\s+/.test(normalized)) {
        return {
            error: 'Refusing `bash find -name` when structured search is available. Use glob for filename discovery instead.',
        };
    }
    if ((isImplementationReady(context) || !!getPrimaryTargetScope(context)) && /^(grep|rg)\b/.test(normalized)) {
        return {
            error: 'Refusing shell grep/rg when structured search is available. Use the grep tool instead.',
        };
    }
    if (isImplementationReady(context)) {
        if (/^cat(?:\s+-[A-Za-z]+)+\s+/.test(normalized)) {
            return {
                error: 'Refusing low-value `bash cat` probe after implementation-ready state. Use read_file instead.',
            };
        }
        if (/^(wc\s+-l|tail(?:\s+-\d+)?|head(?:\s+-\d+)?)(\s+.+)+$/.test(normalized)) {
            return {
                error: 'Refusing low-value shell file probe after implementation-ready state. Use read_file or proceed with implementation/verification.',
            };
        }
    }
    const match = command.match(/\bfind\s+([^\s]+)/);
    if (!match)
        return { command };
    const searchRoot = match[1];
    if (!isBroadShellSearchRoot(searchRoot, context)) {
        return { command };
    }
    const scopedTarget = getPrimaryTargetScope(context);
    if (!scopedTarget) {
        return {
            error: 'Refusing broad repo-wide `find` without a scoped target. Use glob/grep first or provide a narrower path.',
        };
    }
    const quotedTarget = scopedTarget.includes(' ') ? `"${scopedTarget}"` : scopedTarget;
    return {
        command: command.replace(match[0], `find ${quotedTarget}`),
    };
}
// ─── Read File Tool ──────────────────────────────────────────
export const readFileTool = {
    name: 'read_file',
    type: 'read',
    description: 'Read the contents of a file',
    inputSchema: z.object({
        path: z.string().describe('File path to read'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { path: filePath } = input;
        try {
            const resolved = await safeResolve(context.cwd, filePath, { allowDirectory: true });
            const stat = await fs.stat(resolved);
            if (stat.isDirectory()) {
                return {
                    success: false,
                    output: null,
                    error: `Refusing to read directory ${resolved}. Use glob or grep inside that path first.`,
                    durationMs: Date.now() - start,
                };
            }
            const content = await fs.readFile(resolved, 'utf-8');
            return { success: true, output: content, durationMs: Date.now() - start };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `Failed to read ${filePath}: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    },
};
// ─── Write File Tool ─────────────────────────────────────────
export const writeFileTool = {
    name: 'write_file',
    type: 'write',
    description: 'Write content to a file (creates parent directories)',
    inputSchema: z.object({
        path: z.string().describe('File path to write'),
        content: z.string().describe('Content to write'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { path: filePath, content } = input;
        try {
            const resolved = await safeResolve(context.cwd, filePath);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, content, 'utf-8');
            return {
                success: true,
                output: `Written ${content.length} bytes`,
                filesModified: [resolved],
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `Failed to write ${filePath}: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    },
};
// ─── Glob Tool ───────────────────────────────────────────────
export const globTool = {
    name: 'glob',
    type: 'read',
    description: 'Find files matching a glob pattern',
    inputSchema: z.object({
        pattern: z.string().describe('Glob pattern'),
        cwd: z.string().optional().describe('Working directory'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { pattern, cwd } = input;
        const normalizedPattern = normalizeGlobPattern(pattern);
        try {
            const dir = await resolveGlobBaseDir(pattern, cwd, context);
            const files = await findFiles(dir, normalizedPattern);
            return { success: true, output: files, durationMs: Date.now() - start };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `Glob failed: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    },
};
// ─── Bash Tool ───────────────────────────────────────────────
export const bashTool = {
    name: 'bash',
    type: 'exec',
    description: 'Execute a shell command',
    inputSchema: z.object({
        command: z.string().describe('Command to execute'),
        timeout: z.number().optional().describe('Timeout in ms'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { command, timeout = 30_000 } = input;
        const guarded = guardBashCommand(command, context);
        if (guarded.error) {
            return {
                success: false,
                output: null,
                error: guarded.error,
                durationMs: Date.now() - start,
            };
        }
        try {
            const { stdout, stderr } = await execFileAsync('bash', ['-c', guarded.command || command], {
                cwd: context.cwd,
                timeout,
                maxBuffer: 1024 * 1024 * 10,
                env: { ...process.env, ...context.env },
                signal: context.signal,
            });
            return {
                success: true,
                output: { stdout, stderr },
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            const execErr = err;
            return {
                success: false,
                output: { stdout: execErr.stdout, stderr: execErr.stderr },
                error: execErr.message,
                durationMs: Date.now() - start,
            };
        }
    },
};
// ─── Helper: Path-aware glob finder ──────────────────────────
async function findFiles(dir, pattern) {
    const allFiles = await collectFiles(dir);
    const normalizedPattern = normalizePathForMatch(pattern);
    const regex = globToRegExp(normalizedPattern);
    const matches = allFiles
        .filter((file) => {
        const relative = normalizePathForMatch(path.relative(dir, file));
        const basename = normalizePathForMatch(path.basename(file));
        return regex.test(relative) || (!normalizedPattern.includes('/') && regex.test(basename));
    });
    const withStats = await Promise.all(matches.map(async (file) => {
        try {
            const stat = await fs.stat(file);
            return { file, modified: stat.mtimeMs };
        }
        catch {
            return { file, modified: 0 };
        }
    }));
    return withStats
        .sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file))
        .slice(0, 100)
        .map((entry) => entry.file);
}
async function collectFiles(dir) {
    const results = [];
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules')
                    continue;
                results.push(...(await collectFiles(fullPath)));
            }
            else if (entry.isFile()) {
                results.push(fullPath);
            }
        }
    }
    catch {
        // Directory not readable, skip
    }
    return results;
}
function globToRegExp(pattern) {
    const normalized = normalizePathForMatch(pattern);
    let regex = '';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        const next = normalized[i + 1];
        if (char === '*' && next === '*') {
            const after = normalized[i + 2];
            if (after === '/') {
                regex += '(?:.*/)?';
                i += 2;
            }
            else {
                regex += '.*';
                i += 1;
            }
            continue;
        }
        if (char === '*') {
            regex += '[^/]*';
            continue;
        }
        if (char === '?') {
            regex += '[^/]';
            continue;
        }
        regex += escapeRegExp(char);
    }
    return new RegExp(`^${regex}$`);
}
function escapeRegExp(char) {
    return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}
// ─── Register All Built-in Tools ─────────────────────────────
export const builtinTools = [
    readFileTool,
    writeFileTool,
    globTool,
    bashTool,
];
//# sourceMappingURL=tools.js.map