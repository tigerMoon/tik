import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceResolution } from '@tik/shared';
import { WorkspaceEventStore } from '../src/workspace-event-store.js';
import { WorkspaceOrchestrator } from '../src/workspace-orchestrator.js';
import { WorkspaceWorktreeManager } from '../src/workspace-worktree-manager.js';
import {
  WorkspaceReadModel,
  WORKSPACE_PUBLIC_API_VERSION,
  WORKSPACE_PUBLIC_SCHEMA_VERSION,
} from '../src/workspace-public-api.js';

const tempDirs: string[] = [];

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

async function createWorkspaceResolution(): Promise<WorkspaceResolution> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workspace-public-api-'));
  tempDirs.push(rootPath);
  const serviceAPath = path.join(rootPath, 'service-a');
  await fs.mkdir(serviceAPath, { recursive: true });
  runGit(serviceAPath, ['init']);
  runGit(serviceAPath, ['config', 'user.name', 'Tik Test']);
  runGit(serviceAPath, ['config', 'user.email', 'tik@example.com']);
  await fs.writeFile(path.join(serviceAPath, 'README.md'), '# demo\n', 'utf-8');
  runGit(serviceAPath, ['add', 'README.md']);
  runGit(serviceAPath, ['commit', '-m', 'init']);
  const workspaceFile = path.join(rootPath, 'demo.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [
      { path: 'service-a', name: 'service-a' },
    ],
  }), 'utf-8');
  return {
    workspace: {
      name: 'demo',
      rootPath,
      workspaceFile,
      projects: [{ name: 'service-a', path: serviceAPath }],
      config: {},
    },
    projectPath: serviceAPath,
    isWorkspace: true,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('WorkspaceReadModel', () => {
  it('loads status, projection, and memory through a stable public API', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成 spec',
    });
    const store = new WorkspaceEventStore({
      persistPath: path.join(resolution.workspace!.rootPath, '.workspace', 'events.jsonl'),
    });
    store.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_SPECIFY',
      message: 'Specify phase started.',
    });
    store.record({
      level: 'project',
      kind: 'subtask.started',
      phase: 'PARALLEL_SPECIFY',
      projectName: 'service-a',
      taskId: 'task-1',
      message: 'Specify delegated subtask started.',
    });

    const readModel = new WorkspaceReadModel(resolution.workspace!.rootPath);
    const status = await readModel.readStatusView();
    const board = await readModel.readBoardView();
    const report = await readModel.readReportView();

    expect(status.apiVersion).toBe(WORKSPACE_PUBLIC_API_VERSION);
    expect(status.schemaVersion).toBe(WORKSPACE_PUBLIC_SCHEMA_VERSION);
    expect(status.projection.totalEvents).toBe(2);
    expect(status.memory.session.currentPhase).toBe('PARALLEL_CLARIFY');
    expect(status.worktrees.mode).toBe('managed');
    expect(board.healthy).toHaveLength(1);
    expect(board.apiVersion).toBe(WORKSPACE_PUBLIC_API_VERSION);
    expect(report.eventCount).toBe(2);
  });

  it('surfaces pending human decisions through board and status views', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成 spec',
    });

    await orchestrator.markProjectBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      'PARALLEL_SPECIFY',
      'Multiple feature specs found; unable to choose automatically: /tmp/specs/feature-a/spec.md, /tmp/specs/feature-b/spec.md',
      'task-spec-1',
    );

    const readModel = new WorkspaceReadModel(resolution.workspace!.rootPath);
    const status = await readModel.readStatusView();
    const board = await readModel.readBoardView();

    expect(status.state?.decisions).toHaveLength(1);
    expect(status.state?.decisions?.[0]).toMatchObject({
      status: 'pending',
      kind: 'approach_choice',
      phase: 'PARALLEL_SPECIFY',
      projectName: 'service-a',
      confidence: 'high',
    });
    expect(board.pendingDecisions).toHaveLength(1);
    expect(board.pendingDecisions[0]?.recommendedOptionId).toBeTruthy();
    expect(board.pendingDecisions[0]?.rationale).toContain('safest recovery path');
    expect(board.feedbackRequired).toBe(true);
  });

  it('surfaces managed worktree metadata through the public status view', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    const manager = new WorkspaceWorktreeManager();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成 spec',
    });
    const target = await manager.getExecutionTarget({
      workspaceName: resolution.workspace!.name,
      workspaceRoot: resolution.workspace!.rootPath,
      projectName: 'service-a',
      sourceProjectPath: resolution.workspace!.projects[0]!.path,
    });

    await orchestrator.markProjectWorktreeReady(
      resolution.workspace!.rootPath,
      'service-a',
      {
        effectiveProjectPath: target.effectiveProjectPath,
        worktree: target.worktree!,
      },
    );

    const readModel = new WorkspaceReadModel(resolution.workspace!.rootPath);
    const status = await readModel.readStatusView();

    expect(status.settings?.worktreePolicy).toMatchObject({
      mode: 'managed',
    });
    expect(status.state?.projects[0]).toMatchObject({
      sourceProjectPath: resolution.workspace!.projects[0]?.path,
      effectiveProjectPath: resolution.workspace!.projects[0]?.path,
    });
    expect(status.worktrees.entries[0]).toMatchObject({
      projectName: 'service-a',
      active: false,
      kind: 'git-worktree',
      projectStatus: 'pending',
    });
    expect(status.worktrees.entries[0]?.worktree?.worktreeBranch).toMatch(/^tik\/demo\/service-a-[a-f0-9]{8}$/);
  });

  it('does not materialize workspace memory for roots without workspace state', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workspace-public-api-empty-'));
    tempDirs.push(rootPath);

    const readModel = new WorkspaceReadModel(rootPath);
    const status = await readModel.readStatusView();

    expect(status.state).toBeNull();
    await expect(fs.access(path.join(rootPath, '.workspace', 'memory', 'session.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(status.memory.projects).toEqual([]);
  });
});
