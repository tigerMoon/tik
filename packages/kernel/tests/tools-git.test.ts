import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitCommitTool } from '../src/tools-git.js';
import type { ToolContext } from '@tik/shared';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-git-tool-'));
  tempDirs.push(root);
  await runGit(root, ['init']);
  await runGit(root, ['config', 'user.email', 'tik@example.com']);
  await runGit(root, ['config', 'user.name', 'Tik Test']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'initial\n', 'utf-8');
  await runGit(root, ['add', 'tracked.txt']);
  await runGit(root, ['commit', '-m', 'initial']);
  return root;
}

function createContext(root: string): ToolContext {
  return {
    cwd: root,
    taskId: 'task-git-test',
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('git_commit tool', () => {
  it('refuses to commit without explicit files and leaves the index untouched', async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf-8');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'new\n', 'utf-8');

    const result = await gitCommitTool.execute(
      { message: 'should not stage everything' },
      createContext(root),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/explicit files/i);
    await expect(runGit(root, ['diff', '--cached', '--name-only'])).resolves.toBe('');
  });

  it('stages and commits only the explicit files', async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf-8');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'new\n', 'utf-8');

    const result = await gitCommitTool.execute(
      { message: 'commit explicit file', files: ['tracked.txt'] },
      createContext(root),
    );

    expect(result.success).toBe(true);
    await expect(runGit(root, ['diff', '--name-only', 'HEAD~1..HEAD'])).resolves.toContain('tracked.txt');
    await expect(runGit(root, ['status', '--short'])).resolves.toBe('?? untracked.txt\n');
  });

  it('rejects git pathspec flags in explicit files', async () => {
    const root = await makeRepo();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n', 'utf-8');
    await fs.writeFile(path.join(root, 'untracked.txt'), 'new\n', 'utf-8');

    const result = await gitCommitTool.execute(
      { message: 'reject flags', files: ['-A'] },
      createContext(root),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file paths/i);
    await expect(runGit(root, ['diff', '--cached', '--name-only'])).resolves.toBe('');
  });
});
