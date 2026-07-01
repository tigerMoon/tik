import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTikGeneratedReviewContext, hasTikReviewableChanges } from '../src/tracker-daemon/review-context.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Tik review context scope filtering', () => {
  it('treats glob-style allowed scopes as path prefixes for generated review context', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-review-context-'));
    tempDirs.push(repo);
    await fs.mkdir(path.join(repo, 'packages/kernel/src'), { recursive: true });
    await fs.mkdir(path.join(repo, 'packages/dashboard/src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'packages/kernel/src/index.ts'), 'export const before = 1;\n', 'utf-8');
    await fs.writeFile(path.join(repo, 'packages/dashboard/src/index.ts'), 'export const before = 1;\n', 'utf-8');
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Tik Test']);
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'init']);

    await fs.writeFile(path.join(repo, 'packages/kernel/src/index.ts'), 'export const after = 2;\n', 'utf-8');
    await fs.writeFile(path.join(repo, 'packages/dashboard/src/index.ts'), 'export const after = 2;\n', 'utf-8');

    expect(hasTikReviewableChanges(repo, { allowedScope: ['packages/kernel/src/**'] })).toBe(true);
    const context = await buildTikGeneratedReviewContext(repo, {
      allowedScope: ['packages/kernel/src/**'],
    });

    expect(context).toContain('packages/kernel/src/index.ts');
    expect(context).not.toContain('packages/dashboard/src/index.ts');
  });
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}
