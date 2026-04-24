import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  isGitRepository,
  listGitWorktrees,
  parseGitStatusPaths,
  readGitBranch,
} from '../src/workspace-git.js';

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

describe('workspace git helpers', () => {
  it('preserves leading path characters when parsing porcelain output', () => {
    const files = parseGitStatusPaths([
      ' M catalog-suite-application/src/main/java/com/example/catalog/service/config/CatalogConfigServiceImpl.java',
      ' M catalog-suite-infrastructure/catalog-suite-dal/src/main/java/com/example/catalog/infra/dal/dal/redis/RedisKeyHelper.java',
      '?? catalog-suite-application/src/test/java/com/example/catalog/service/config/',
    ].join('\n'));

    expect(files).toEqual([
      'catalog-suite-application/src/main/java/com/example/catalog/service/config/CatalogConfigServiceImpl.java',
      'catalog-suite-infrastructure/catalog-suite-dal/src/main/java/com/example/catalog/infra/dal/dal/redis/RedisKeyHelper.java',
      'catalog-suite-application/src/test/java/com/example/catalog/service/config/',
    ]);
  });

  it('detects git repositories, branches, and worktree entries', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-cli-workspace-git-'));
    const worktreePath = path.join(rootPath, 'service-a-worktree');
    try {
      runGit(rootPath, ['init']);
      runGit(rootPath, ['config', 'user.name', 'Tik Test']);
      runGit(rootPath, ['config', 'user.email', 'tik@example.com']);
      await fs.writeFile(path.join(rootPath, 'README.md'), '# demo\n', 'utf-8');
      runGit(rootPath, ['add', 'README.md']);
      runGit(rootPath, ['commit', '-m', 'init']);
      runGit(rootPath, ['worktree', 'add', '-b', 'tik/demo/service-a', worktreePath]);

      const normalizedRoot = await fs.realpath(rootPath);
      const normalizedWorktree = await fs.realpath(worktreePath);
      expect(isGitRepository(rootPath)).toBe(true);
      expect(readGitBranch(rootPath)).toBeTruthy();
      expect(listGitWorktrees(rootPath)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: normalizedRoot }),
        expect.objectContaining({ path: normalizedWorktree, branch: 'tik/demo/service-a' }),
      ]));
    } finally {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
