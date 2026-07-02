/**
 * Git Tools
 *
 * Git operation tools for Tik.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
const execFileAsync = promisify(execFile);
async function runGit(args, cwd, signal) {
    return execFileAsync('git', args, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 5,
        signal,
    });
}
export const gitStatusTool = {
    name: 'git_status',
    type: 'read',
    description: 'Show git working tree status',
    inputSchema: z.object({}),
    async execute(_input, context) {
        const start = Date.now();
        try {
            const { stdout } = await runGit(['status', '--short'], context.cwd, context.signal);
            return { success: true, output: stdout, durationMs: Date.now() - start };
        }
        catch (err) {
            return { success: false, output: null, error: err.message, durationMs: Date.now() - start };
        }
    },
};
export const gitDiffTool = {
    name: 'git_diff',
    type: 'read',
    description: 'Show git diff (staged and unstaged)',
    inputSchema: z.object({
        args: z.string().optional().describe('Additional args (e.g. "--staged", "HEAD~1")'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { args } = input;
        const gitArgs = ['diff', '--stat'];
        if (args)
            gitArgs.push(...args.split(' '));
        try {
            const { stdout } = await runGit(gitArgs, context.cwd, context.signal);
            return { success: true, output: stdout, durationMs: Date.now() - start };
        }
        catch (err) {
            return { success: false, output: null, error: err.message, durationMs: Date.now() - start };
        }
    },
};
export const gitLogTool = {
    name: 'git_log',
    type: 'read',
    description: 'Show recent git commits',
    inputSchema: z.object({
        count: z.number().optional().describe('Number of commits to show'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { count = 10 } = input;
        try {
            const { stdout } = await runGit(['log', `--oneline`, `-n`, String(count)], context.cwd, context.signal);
            return { success: true, output: stdout, durationMs: Date.now() - start };
        }
        catch (err) {
            return { success: false, output: null, error: err.message, durationMs: Date.now() - start };
        }
    },
};
export const gitCommitTool = {
    name: 'git_commit',
    type: 'exec',
    description: 'Stage files and create a git commit',
    inputSchema: z.object({
        message: z.string().describe('Commit message'),
        files: z.array(z.string()).optional().describe('Explicit files to stage'),
    }),
    async execute(input, context) {
        const start = Date.now();
        const { message, files } = input;
        try {
            if (!files || files.length === 0) {
                return {
                    success: false,
                    output: null,
                    error: 'git_commit requires explicit files; refusing implicit git add -A.',
                    durationMs: Date.now() - start,
                };
            }
            const invalidFile = files.find((file) => !isSafeGitFilePath(file));
            if (invalidFile) {
                return {
                    success: false,
                    output: null,
                    error: `git_commit files must be relative file paths inside the repository: ${invalidFile}`,
                    durationMs: Date.now() - start,
                };
            }
            await runGit(['add', '--', ...files], context.cwd, context.signal);
            const { stdout } = await runGit(['commit', '-m', message], context.cwd, context.signal);
            return { success: true, output: stdout, durationMs: Date.now() - start };
        }
        catch (err) {
            return { success: false, output: null, error: err.message, durationMs: Date.now() - start };
        }
    },
};
export const gitTools = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
function isSafeGitFilePath(file) {
    if (!file || !file.trim()) {
        return false;
    }
    if (file.startsWith('-') || path.isAbsolute(file)) {
        return false;
    }
    return !file.replace(/\\/g, '/').split('/').includes('..');
}
//# sourceMappingURL=tools-git.js.map