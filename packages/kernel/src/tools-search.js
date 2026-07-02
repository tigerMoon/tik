/**
 * Search & Edit Tools
 *
 * Grep and edit tools for Tik.
 */
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { safeResolve, safeResolveWorkspacePath } from './path-safety.js';
const execFileAsync = promisify(execFile);
function getPrimaryTargetScope(context) {
    return context.likelyTargetPaths?.[0] || null;
}
async function resolveGrepTarget(target, context) {
    if (!target) {
        const scopedTarget = getPrimaryTargetScope(context);
        return scopedTarget
            ? safeResolve(context.cwd, scopedTarget, { allowAbsolute: true, allowDirectory: true })
            : context.cwd;
    }
    const normalized = target.trim();
    if (!normalized || normalized === '.' || normalized === './') {
        const scopedTarget = getPrimaryTargetScope(context);
        return scopedTarget
            ? safeResolve(context.cwd, scopedTarget, { allowAbsolute: true, allowDirectory: true })
            : context.cwd;
    }
    const resolved = await safeResolveWorkspacePath(context.cwd, normalized, { allowDirectory: true });
    return resolved === context.cwd
        ? (getPrimaryTargetScope(context)
            ? safeResolve(context.cwd, getPrimaryTargetScope(context), { allowAbsolute: true, allowDirectory: true })
            : resolved)
        : resolved;
}
export const grepTool = {
    name: 'grep',
    type: 'read',
    description: 'Search file contents using regex pattern',
    inputSchema: z.object({
        pattern: z.string().describe('Regex pattern to search'),
        path: z.string().optional().describe('File or directory to search in'),
        glob: z.string().optional().describe('Glob filter (e.g. "*.ts")'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { pattern, path: searchPath, glob: globFilter } = input;
        try {
            const target = await resolveGrepTarget(searchPath, context);
            const args = ['--color=never', '-rn', '--max-count=50'];
            if (globFilter)
                args.push('--include', globFilter);
            args.push(pattern, target);
            const { stdout } = await execFileAsync('grep', args, {
                cwd: context.cwd,
                timeout: 15_000,
                maxBuffer: 1024 * 1024 * 2,
                signal: context.signal,
            });
            return { success: true, output: stdout, durationMs: Date.now() - start };
        }
        catch (err) {
            const exitCode = err.code;
            // grep returns 1 when no matches found
            if (exitCode === 1) {
                return { success: true, output: 'No matches found', durationMs: Date.now() - start };
            }
            return { success: false, output: null, error: err.message, durationMs: Date.now() - start };
        }
    },
};
export const editFileTool = {
    name: 'edit_file',
    type: 'write',
    description: 'Edit a file by replacing a specific string',
    inputSchema: z.object({
        path: z.string().describe('File path'),
        old_string: z.string().describe('Exact string to find and replace'),
        new_string: z.string().describe('Replacement string'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { path: filePath, old_string, new_string } = input;
        try {
            const resolved = await safeResolve(context.cwd, filePath);
            const content = await fs.readFile(resolved, 'utf-8');
            if (!content.includes(old_string)) {
                return {
                    success: false,
                    output: null,
                    error: `String not found in ${filePath}`,
                    durationMs: Date.now() - start,
                };
            }
            const occurrences = content.split(old_string).length - 1;
            if (occurrences > 1) {
                return {
                    success: false,
                    output: null,
                    error: `Found ${occurrences} occurrences of the string. Provide more context to make it unique.`,
                    durationMs: Date.now() - start,
                };
            }
            const newContent = content.replace(old_string, new_string);
            await fs.writeFile(resolved, newContent, 'utf-8');
            return {
                success: true,
                output: `Edited ${filePath}: replaced 1 occurrence`,
                filesModified: [resolved],
                durationMs: Date.now() - start,
            };
        }
        catch (err) {
            return {
                success: false,
                output: null,
                error: `Failed to edit ${filePath}: ${err.message}`,
                durationMs: Date.now() - start,
            };
        }
    },
};
export const searchEditTools = [grepTool, editFileTool];
//# sourceMappingURL=tools-search.js.map