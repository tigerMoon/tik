import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceWorktreeManager } from '../src/workspace-worktree-manager.js';

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

async function createGitProject(): Promise<{ workspaceRoot: string; projectPath: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-worktree-manager-'));
  tempDirs.push(workspaceRoot);
  const projectPath = path.join(workspaceRoot, 'service-a');
  await fs.mkdir(projectPath, { recursive: true });
  runGit(projectPath, ['init']);
  runGit(projectPath, ['config', 'user.name', 'Tik Test']);
  runGit(projectPath, ['config', 'user.email', 'tik@example.com']);
  await fs.writeFile(path.join(projectPath, 'README.md'), '# demo\n', 'utf-8');
  runGit(projectPath, ['add', 'README.md']);
  runGit(projectPath, ['commit', '-m', 'init']);
  return { workspaceRoot, projectPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceWorktreeManager', () => {
  it('derives deterministic branch and workspace-local worktree paths', async () => {
    const manager = new WorkspaceWorktreeManager();
    const primaryBranch = manager.buildManagedWorktreeBranch('Demo Workspace', 'service-a', '/repo/service-a');
    const secondaryBranch = manager.buildManagedWorktreeBranch('Demo Workspace', 'service-a', '/repo/other/service-a');
    expect(primaryBranch).toMatch(/^tik\/demo-workspace\/service-a-[a-f0-9]{8}$/);
    expect(secondaryBranch).toMatch(/^tik\/demo-workspace\/service-a-[a-f0-9]{8}$/);
    expect(primaryBranch).not.toBe(secondaryBranch);
    expect(manager.buildManagedWorktreePath('/workspace/root', 'service-a', '/repo/service-a')).toMatch(
      /\/\.workspace\/worktrees\/service-a-[a-f0-9]{8}$/,
    );
    expect(manager.buildManagedWorktreeBranch('Demo Workspace', 'service-a', '/repo/service-a', 'feature a')).toMatch(
      /^tik\/demo-workspace\/service-a-[a-f0-9]{8}--feature-a$/,
    );
    expect(manager.buildManagedWorktreePath('/workspace/root', 'service-a', '/repo/service-a', 'feature a')).toMatch(
      /\/\.workspace\/worktrees\/service-a-[a-f0-9]{8}--feature-a$/,
    );
  });

  it('creates and resolves a managed worktree execution target', async () => {
    const { workspaceRoot, projectPath } = await createGitProject();
    const manager = new WorkspaceWorktreeManager();

    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
    });

    expect(target.sourceProjectPath).toBe(projectPath);
    expect(target.effectiveProjectPath).toMatch(/\/\.workspace\/worktrees\/service-a-[a-f0-9]{8}$/);
    expect(target.worktree?.status).toBe('ready');
    expect(target.worktree?.worktreeBranch).toMatch(/^tik\/demo\/service-a-[a-f0-9]{8}$/);
    expect(runGit(target.effectiveProjectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(target.worktree?.worktreeBranch);
  });

  it('reports non-git project paths as invalid for managed worktrees', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-worktree-non-git-'));
    tempDirs.push(workspaceRoot);
    const projectPath = path.join(workspaceRoot, 'service-a');
    await fs.mkdir(projectPath, { recursive: true });
    const manager = new WorkspaceWorktreeManager();

    await expect(manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      policy: {
        mode: 'managed',
        nonGitStrategy: 'block',
      },
    })).rejects.toThrow(/not inside a git repository/i);
  });

  it('falls back to source execution for non-git projects when policy allows it', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-worktree-non-git-source-'));
    tempDirs.push(workspaceRoot);
    const projectPath = path.join(workspaceRoot, 'service-a');
    await fs.mkdir(projectPath, { recursive: true });
    const manager = new WorkspaceWorktreeManager();

    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      laneId: 'feature-a',
      policy: {
        mode: 'managed',
        nonGitStrategy: 'source',
      },
    });

    expect(target.sourceProjectPath).toBe(projectPath);
    expect(target.effectiveProjectPath).toBe(projectPath);
    expect(target.worktree).toMatchObject({
      enabled: false,
      status: 'source',
      kind: 'source',
      laneId: 'feature-a',
    });
  });

  it('creates an isolated copy lane for non-git projects when policy allows it', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-worktree-non-git-copy-'));
    tempDirs.push(workspaceRoot);
    const projectPath = path.join(workspaceRoot, 'service-a');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'README.md'), '# docs\n', 'utf-8');
    const manager = new WorkspaceWorktreeManager();

    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      laneId: 'review',
      policy: {
        mode: 'managed',
        nonGitStrategy: 'copy',
      },
    });

    expect(target.effectiveProjectPath).toMatch(/\/\.workspace\/worktrees\/service-a-[a-f0-9]{8}--review$/);
    expect(target.worktree).toMatchObject({
      enabled: true,
      status: 'ready',
      kind: 'copy',
      laneId: 'review',
    });
    await expect(fs.readFile(path.join(target.effectiveProjectPath, 'README.md'), 'utf-8')).resolves.toContain('# docs');
  });

  it('removes a managed worktree and returns source path as effective path', async () => {
    const { workspaceRoot, projectPath } = await createGitProject();
    const manager = new WorkspaceWorktreeManager();
    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
    });

    const removed = await manager.removeManagedWorktree({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      existingWorktree: target.worktree,
    });

    expect(removed.effectiveProjectPath).toBe(projectPath);
    expect(removed.worktree?.status).toBe('removed');
    await expect(fs.stat(target.effectiveProjectPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates multiple managed worktree lanes for the same project', async () => {
    const { workspaceRoot, projectPath } = await createGitProject();
    const manager = new WorkspaceWorktreeManager();

    const primary = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
    });
    const feature = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      laneId: 'feature-a',
    });

    expect(primary.worktree?.laneId).toBe('primary');
    expect(feature.worktree?.laneId).toBe('feature-a');
    expect(feature.effectiveProjectPath).toMatch(/\/\.workspace\/worktrees\/service-a-[a-f0-9]{8}--feature-a$/);
    expect(runGit(feature.effectiveProjectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(feature.worktree?.worktreeBranch);
  });

  it('reports dirty metadata for managed git worktree entries', async () => {
    const { workspaceRoot, projectPath } = await createGitProject();
    const manager = new WorkspaceWorktreeManager();
    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
    });

    await fs.writeFile(path.join(target.effectiveProjectPath, 'README.md'), '# changed\n', 'utf-8');
    const entries = await manager.listManagedWorktrees({
      workspaceName: 'demo',
      workspaceRoot,
      projects: [{
        projectName: 'service-a',
        sourceProjectPath: projectPath,
        effectiveProjectPath: target.effectiveProjectPath,
        worktree: target.worktree,
        worktreeLanes: [target.worktree!],
      }],
    });

    expect(entries[0]).toMatchObject({
      kind: 'git-worktree',
      dirtyFileCount: 1,
      safeToActivate: true,
      safeToRemove: false,
    });
    expect(entries[0]?.warnings.join(' ')).toContain('uncommitted');
  });

  it('reports dirty metadata for non-git copy lanes and blocks removal without force', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-worktree-copy-dirty-'));
    tempDirs.push(workspaceRoot);
    const projectPath = path.join(workspaceRoot, 'service-a');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'README.md'), '# docs\n', 'utf-8');
    const manager = new WorkspaceWorktreeManager();

    const target = await manager.getExecutionTarget({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      laneId: 'review',
      policy: { mode: 'managed', nonGitStrategy: 'copy' },
    });

    await fs.writeFile(path.join(target.effectiveProjectPath, 'README.md'), '# changed\n', 'utf-8');
    const entries = await manager.listManagedWorktrees({
      workspaceName: 'demo',
      workspaceRoot,
      projects: [{
        projectName: 'service-a',
        sourceProjectPath: projectPath,
        effectiveProjectPath: projectPath,
        worktree: undefined,
        worktreeLanes: [target.worktree!],
      }],
      policy: { mode: 'managed', nonGitStrategy: 'copy' },
    });

    expect(entries[0]).toMatchObject({
      kind: 'copy',
      safeToRemove: false,
    });
    expect((entries[0]?.dirtyFileCount || 0)).toBeGreaterThan(0);

    await expect(manager.removeManagedWorktree({
      workspaceName: 'demo',
      workspaceRoot,
      projectName: 'service-a',
      sourceProjectPath: projectPath,
      laneId: 'review',
      existingWorktree: target.worktree,
      existingWorktreeLanes: [target.worktree!],
      policy: { mode: 'managed', nonGitStrategy: 'copy' },
    })).rejects.toThrow(/cannot be removed safely/i);
  });
});
