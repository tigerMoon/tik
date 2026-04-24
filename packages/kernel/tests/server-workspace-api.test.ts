import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceResolution } from '@tik/shared';
import { createServer } from '../src/server.js';
import { WorkspaceEventStore } from '../src/workspace-event-store.js';
import { WorkspaceOrchestrator } from '../src/workspace-orchestrator.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

async function createWorkspaceResolution(): Promise<WorkspaceResolution> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-server-workspace-api-'));
  tempDirs.push(rootPath);
  const servicePath = path.join(rootPath, 'service-a');
  await fs.mkdir(servicePath, { recursive: true });
  runGit(servicePath, ['init']);
  runGit(servicePath, ['config', 'user.name', 'Tik Test']);
  runGit(servicePath, ['config', 'user.email', 'tik@example.com']);
  await fs.writeFile(path.join(servicePath, 'README.md'), '# demo\n', 'utf-8');
  runGit(servicePath, ['add', 'README.md']);
  runGit(servicePath, ['commit', '-m', 'init']);
  const workspaceFile = path.join(rootPath, 'demo.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({
    folders: [{ path: 'service-a', name: 'service-a' }],
  }), 'utf-8');
  return {
    workspace: {
      name: 'demo',
      rootPath,
      workspaceFile,
      projects: [{ name: 'service-a', path: servicePath }],
      config: {},
    },
    projectPath: servicePath,
    isWorkspace: true,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('workspace API server routes', () => {
  it('serves workspace status, memory, and decisions endpoints for non-CLI consumers', async () => {
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

    const mockKernel = {
      taskManager: { create: () => ({ id: 'task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: resolution.workspace!.rootPath },
    );
    servers.push(server);

    const statusResponse = await server.inject({ method: 'GET', url: '/api/workspace/status' });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.headers['x-tik-workspace-api-version']).toBe('2026-04-07');
    expect(statusResponse.json().apiVersion).toBe('2026-04-07');
    expect(statusResponse.json().projection.totalEvents).toBe(1);

    const memoryResponse = await server.inject({ method: 'GET', url: '/api/workspace/memory' });
    expect(memoryResponse.statusCode).toBe(200);
    expect(memoryResponse.json().session.currentPhase).toBe('PARALLEL_CLARIFY');

    await orchestrator.markProjectBlocked(
      resolution.workspace!.rootPath,
      'service-a',
      'PARALLEL_SPECIFY',
      'Multiple feature specs found; unable to choose automatically: /tmp/specs/feature-a/spec.md, /tmp/specs/feature-b/spec.md',
      'task-spec-1',
    );

    const decisionsResponse = await server.inject({ method: 'GET', url: '/api/workspace/decisions' });
    expect(decisionsResponse.statusCode).toBe(200);
    expect(decisionsResponse.headers['x-tik-workspace-api-version']).toBe('2026-04-07');
    expect(decisionsResponse.json().pending).toHaveLength(1);
    expect(decisionsResponse.json().pending[0]).toMatchObject({
      status: 'pending',
      kind: 'approach_choice',
      phase: 'PARALLEL_SPECIFY',
      projectName: 'service-a',
    });

    const decisionId = decisionsResponse.json().pending[0].id;
    const resolveResponse = await server.inject({
      method: 'POST',
      url: `/api/workspace/decisions/${decisionId}/resolve`,
      payload: {
        optionId: 'artifact-2',
        message: 'Use feature-b.',
      },
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.headers['x-tik-workspace-api-version']).toBe('2026-04-07');
    expect(resolveResponse.json().decision).toMatchObject({
      id: decisionId,
      status: 'resolved',
    });
    expect(resolveResponse.json().state.workspaceFeedback.reason).toContain('Use feature-b.');
  });

  it('serves and mutates managed worktree lanes through workspace API routes', async () => {
    const resolution = await createWorkspaceResolution();
    const orchestrator = new WorkspaceOrchestrator();
    await orchestrator.bootstrap({
      resolution,
      demand: '给 service-a 生成 spec',
    });

    const mockKernel = {
      taskManager: { create: () => ({ id: 'task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: resolution.workspace!.rootPath },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workspace/worktrees/create',
      payload: {
        projectName: 'service-a',
        sourceProjectPath: resolution.workspace!.projects[0]!.path,
        laneId: 'feature-a',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().worktrees.entries.some((entry: any) => entry.laneId === 'feature-a')).toBe(true);
    expect(createResponse.json().state.projects[0].effectiveProjectPath).toBe(resolution.workspace!.projects[0]!.path);
    expect(createResponse.json().state.projects[0].worktree).toBeUndefined();

    const listResponse = await server.inject({ method: 'GET', url: '/api/workspace/worktrees' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.headers['x-tik-workspace-api-version']).toBe('2026-04-07');
    expect(listResponse.json().worktrees.entries.some((entry: any) => entry.laneId === 'feature-a')).toBe(true);

    const useResponse = await server.inject({
      method: 'POST',
      url: '/api/workspace/worktrees/use',
      payload: {
        projectName: 'service-a',
        sourceProjectPath: resolution.workspace!.projects[0]!.path,
        laneId: 'feature-a',
      },
    });
    expect(useResponse.statusCode).toBe(200);
    expect(useResponse.json().state.projects[0].worktree.laneId).toBe('feature-a');

    const removeResponse = await server.inject({
      method: 'POST',
      url: '/api/workspace/worktrees/remove',
      payload: {
        projectName: 'service-a',
        sourceProjectPath: resolution.workspace!.projects[0]!.path,
        laneId: 'feature-a',
        force: true,
      },
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removeResponse.json().state.projects[0].effectiveProjectPath).toBe(resolution.workspace!.projects[0]!.path);
    expect(removeResponse.json().state.projects[0].worktreeLanes.some((lane: any) => lane.laneId === 'feature-a' && lane.status === 'removed')).toBe(true);
  });
});
