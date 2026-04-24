/**
 * Git Tools
 *
 * Git operation tools for Tik.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@tik/shared';

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024 * 5,
    signal,
  });
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  type: 'read',
  description: 'Show git working tree status',
  inputSchema: z.object({}),
  async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    try {
      const { stdout } = await runGit(['status', '--short'], context.cwd, context.signal);
      return { success: true, output: stdout, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  },
};

export const gitDiffTool: Tool = {
  name: 'git_diff',
  type: 'read',
  description: 'Show git diff (staged and unstaged)',
  inputSchema: z.object({
    args: z.string().optional().describe('Additional args (e.g. "--staged", "HEAD~1")'),
  }),
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const { args } = input as { args?: string };
    const gitArgs = ['diff', '--stat'];
    if (args) gitArgs.push(...args.split(' '));
    try {
      const { stdout } = await runGit(gitArgs, context.cwd, context.signal);
      return { success: true, output: stdout, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  },
};

export const gitLogTool: Tool = {
  name: 'git_log',
  type: 'read',
  description: 'Show recent git commits',
  inputSchema: z.object({
    count: z.number().optional().describe('Number of commits to show'),
  }),
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const { count = 10 } = input as { count?: number };
    try {
      const { stdout } = await runGit(
        ['log', `--oneline`, `-n`, String(count)],
        context.cwd,
        context.signal,
      );
      return { success: true, output: stdout, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  },
};

export const gitCommitTool: Tool = {
  name: 'git_commit',
  type: 'exec',
  description: 'Stage files and create a git commit',
  inputSchema: z.object({
    message: z.string().describe('Commit message'),
    files: z.array(z.string()).optional().describe('Files to stage (defaults to all)'),
  }),
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const start = Date.now();
    const { message, files } = input as { message: string; files?: string[] };
    try {
      // Stage files
      if (files && files.length > 0) {
        await runGit(['add', ...files], context.cwd, context.signal);
      } else {
        await runGit(['add', '-A'], context.cwd, context.signal);
      }
      // Commit
      const { stdout } = await runGit(['commit', '-m', message], context.cwd, context.signal);
      return { success: true, output: stdout, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  },
};

export const gitTools: Tool[] = [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
