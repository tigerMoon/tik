import { spawnSync } from 'node:child_process';

interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function parseGitStatusPaths(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function captureWorkspaceGitChangedFiles(projectPath: string): Promise<Set<string>> {
  const result = runGit(projectPath, ['status', '--porcelain']);
  if (result.status !== 0) return new Set<string>();
  return new Set(parseGitStatusPaths(result.stdout || ''));
}

export function isGitRepository(projectPath: string): boolean {
  const result = runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0 && result.stdout.trim() === 'true';
}

export function readGitBranch(projectPath: string): string | undefined {
  const result = runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = result.stdout.trim();
  return result.status === 0 && branch ? branch : undefined;
}

export function listGitWorktrees(projectPath: string): Array<{ path: string; branch?: string; bare?: boolean }> {
  const result = runGit(projectPath, ['worktree', 'list', '--porcelain']);
  if (result.status !== 0) return [];
  const entries: Array<{ path: string; branch?: string; bare?: boolean }> = [];
  let current: { path?: string; branch?: string; bare?: boolean } = {};
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (current.path) entries.push({ path: current.path, branch: current.branch, bare: current.bare });
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
      continue;
    }
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
      continue;
    }
    if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch, bare: current.bare });
  return entries;
}

export function runGit(projectPath: string, args: string[]): GitCommandResult {
  const result = spawnSync('git', ['-C', projectPath, ...args], {
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}
