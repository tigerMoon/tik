import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { FileArtifactRegistry } from '../src/artifacts/artifact-registry.js';
import { FileAgentRunStore } from '../src/agent-runners/agent-run-store.js';
import { FileRunProofStore } from '../src/agent-runners/run-proof-store.js';
import { EventBus } from '../src/event-bus.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { EventType, type EnvironmentPackSnapshot, type RunProof } from '@tik/shared';
import type {
  AgentRunHandle,
  AgentRunInput,
  AgentRunStatusSnapshot,
  AgentRuntimeRunner,
  PreparedRun,
} from '../src/agent-runners/agent-runtime-runner.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

const TEST_ENVIRONMENT_SNAPSHOT: EnvironmentPackSnapshot = {
  id: 'test-engineering',
  name: 'Test Engineering',
  version: '1.0.0',
  taskLabels: [
    {
      value: 'backend',
      label: 'Backend',
      action: 'codex_dispatch',
      description: 'Backend implementation work.',
      aliases: [],
    },
    {
      value: 'worktree',
      label: 'Worktree',
      action: 'maintenance_manual',
      description: 'Manual workspace maintenance.',
      aliases: ['workspace-maintenance'],
    },
  ],
};

class CompletingRuntimeRunner implements AgentRuntimeRunner {
  readonly name = 'claude-code' as const;
  preparedInputs: AgentRunInput[] = [];
  startedInputs: PreparedRun[] = [];
  private statuses = new Map<string, AgentRunStatusSnapshot>();

  async prepare(input: AgentRunInput): Promise<PreparedRun> {
    this.preparedInputs.push(input);
    return {
      runId: input.runId,
      runner: this.name,
      mode: input.runnerMode,
      cwd: input.projectPath,
      prompt: input.renderedPrompt,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.startedInputs.push(input);
    this.statuses.set(input.runId, 'running');
    const completion = Promise.resolve({ status: 'completed' as const }).then((result) => {
      this.statuses.set(input.runId, result.status);
      return result;
    });
    return {
      runId: input.runId,
      startedAt: new Date().toISOString(),
      completion,
      stop: async () => {
        this.statuses.set(input.runId, 'cancelled');
      },
    };
  }

  async stop(runId: string): Promise<void> {
    this.statuses.set(runId, 'cancelled');
  }

  async getStatus(runId: string): Promise<AgentRunStatusSnapshot> {
    return this.statuses.get(runId) || 'unknown';
  }

  async collectTranscript() {
    return [];
  }

  async collectDiff() {
    return { changedFiles: [] };
  }

  async collectArtifacts() {
    return [];
  }

  async cleanup(runId: string): Promise<void> {
    await this.stop(runId);
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('workbench API routes', () => {
  it('requires bearer auth for mutating routes when an API token is configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root, apiToken: 'test-token' },
    );
    servers.push(server);

    const unauthenticated = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: { title: 'Auth check', goal: 'Require auth for mutation' },
    });
    const invalid = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { title: 'Auth check', goal: 'Require auth for mutation' },
    });
    const authenticated = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { authorization: 'Bearer test-token' },
      payload: { title: 'Auth check', goal: 'Require auth for mutation' },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().task.title).toBe('Auth check');
  });

  it('refuses non-localhost binds without an API token', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    await expect(createServer(
      mockKernel as any,
      { port: 0, host: '0.0.0.0' },
      { workspaceRoot: root },
    )).rejects.toThrow('API token is required');
  });

  it('requires bearer auth for artifact previews when an API token is configured', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
      artifacts: new FileArtifactRegistry({ rootPath: root }),
    });
    await workbench.createTask({
      title: 'Secure preview',
      goal: 'Require token for preview',
    }, 'task-preview-auth');
    const artifact = await workbench.createArtifact({
      taskId: 'task-preview-auth',
      title: 'Preview me',
      kind: 'markdown',
      content: '# Preview',
      contentType: 'text/markdown',
      extension: 'md',
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root, apiToken: 'test-token' },
    );
    servers.push(server);

    const unauthenticated = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/${artifact.id}/versions/${artifact.latestVersionId}/preview`,
    });
    const authenticated = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/${artifact.id}/versions/${artifact.latestVersionId}/preview`,
      headers: { authorization: 'Bearer test-token' },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.body).toContain('Preview');
  });

  it('defaults CORS to the dashboard origin instead of wildcard', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({ method: 'OPTIONS', url: '/api/health' });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('publishes a current worktree review round with workspace binding', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    spawnSync('git', ['init'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Tik Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), '# Tik\n', 'utf-8');
    spawnSync('git', ['add', 'README.md'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf-8' }).stdout.trim();

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/agent-loop/worktree-review-rounds',
      payload: {
        rootTaskId: 'local-review',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik-test',
          projectName: 'tik-test',
          sourceProjectPath: root,
          effectiveProjectPath: root,
          laneId: 'local',
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task).toMatchObject({
      status: 'todo',
      labels: ['agent-loop', 'claude-review', 'needs-claude-review'],
      workspaceBinding: {
        effectiveProjectPath: root,
        laneId: 'local',
      },
      agentLoop: {
        kind: 'claude_review',
        rootTaskId: 'local-review',
        headSha,
        changeRequest: {
          scm: 'internal',
          repo: 'tik-test',
          type: 'internal_review',
          headSha,
        },
      },
    });
  });

  it('binds the active environment pack to worktree review rounds so tracker can route them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    spawnSync('git', ['init'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Tik Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), '# Tik\n', 'utf-8');
    spawnSync('git', ['add', 'README.md'], { cwd: root });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  rules:',
      '    - labels_any: [needs-claude-review]',
      '      runner: claude-code',
      '      mode: claude_print',
      '---',
      'Review {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => ({
          kind: 'EnvironmentPack',
          id: 'review-loop',
          name: 'Review Loop',
          version: '1.0.0',
          description: 'Agent review loop pack',
          tools: [],
          skills: [],
          knowledge: [],
          policies: [],
          workflowBindings: [],
          taskLabels: [
            {
              value: 'needs-claude-review',
              label: 'Claude review',
              action: 'claude_code_review',
              description: 'Ask Claude Code to review the task.',
              aliases: ['claude-review'],
            },
          ],
          evaluators: [],
        }),
        listPacks: async () => [],
      },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/agent-loop/worktree-review-rounds',
      payload: {
        rootTaskId: 'local-review',
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const task = createResponse.json().task;
    expect(task.environmentPackSnapshot).toMatchObject({
      id: 'review-loop',
      taskLabels: [
        expect.objectContaining({
          value: 'needs-claude-review',
          action: 'claude_code_review',
        }),
      ],
    });

    const preview = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/routing-preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      runnable: true,
      routing: {
        runner: 'claude-code',
        mode: 'claude_print',
        matchedLabels: ['needs-claude-review'],
      },
    });
  });

  it('updates task workspace binding through the v1 task patch endpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    const sourceProjectPath = path.join(root, 'repo');
    const originalProjectPath = path.join(root, 'old-worktree');
    const effectiveProjectPath = path.join(root, 'repo');
    await fs.mkdir(sourceProjectPath, { recursive: true });

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const task = await workbench.createTask({
      title: 'Review workspace changes',
      goal: 'Review current worktree',
      status: 'todo',
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik-test',
        projectName: 'tik-test',
        sourceProjectPath,
        effectiveProjectPath: originalProjectPath,
        laneId: 'old',
        worktreeKind: 'git-worktree',
      },
    }, 'task-rebind');
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      payload: {
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik-test',
          projectName: 'tik-test',
          sourceProjectPath,
          effectiveProjectPath,
          laneId: 'root',
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.workspaceBinding).toMatchObject({
      sourceProjectPath,
      effectiveProjectPath,
      laneId: 'root',
      worktreeKind: 'root',
    });
  });

  it('rejects workspace binding updates outside the workspace root or while running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    const sourceProjectPath = path.join(root, 'repo');
    await fs.mkdir(sourceProjectPath, { recursive: true });

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const task = await workbench.createTask({
      title: 'Review workspace changes',
      goal: 'Review current worktree',
      status: 'todo',
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik-test',
        projectName: 'tik-test',
        sourceProjectPath,
        effectiveProjectPath: sourceProjectPath,
        laneId: 'root',
        worktreeKind: 'root',
      },
    }, 'task-rebind-guarded');
    const runningTask = await workbench.createTask({
      title: 'Running task',
      goal: 'Cannot rebind while running',
      status: 'in_progress',
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelTaskId: 'kernel-running',
      }],
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik-test',
        projectName: 'tik-test',
        sourceProjectPath,
        effectiveProjectPath: sourceProjectPath,
        laneId: 'root',
        worktreeKind: 'root',
      },
    }, 'task-rebind-running');
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const outsideResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${task.id}`,
      payload: {
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik-test',
          projectName: 'tik-test',
          sourceProjectPath: root,
          effectiveProjectPath: os.tmpdir(),
          laneId: 'outside',
          worktreeKind: 'root',
        },
      },
    });
    const runningResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${runningTask.id}`,
      payload: {
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik-test',
          projectName: 'tik-test',
          sourceProjectPath,
          effectiveProjectPath: sourceProjectPath,
          laneId: 'root',
          worktreeKind: 'root',
        },
      },
    });

    expect(outsideResponse.statusCode).toBe(409);
    expect(outsideResponse.json().error).toMatchObject({
      code: 'invalid_workspace_binding',
    });
    expect(runningResponse.statusCode).toBe(409);
    expect(runningResponse.json().error).toMatchObject({
      code: 'task_running',
    });
  });

  it('exposes Tik-native agent-loop review round and review-result endpoints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const payload = {
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      idempotencyKey: 'claude_review:gitlab:group/project:456:abc123:r1',
      changeRequest: {
        scm: 'gitlab',
        repo: 'group/project',
        id: '456',
        type: 'merge_request',
        url: 'https://gitlab.example.com/group/project/-/merge_requests/456',
        baseRef: 'main',
        headRef: 'agent/TASK-123-codex',
        headSha: 'abc123',
      },
    };

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/agent-loop/review-rounds',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/agent-loop/review-rounds',
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().task.id).toBe(first.json().task.id);
    expect(first.json().task.agentLoop).toMatchObject({
      kind: 'claude_review',
      rootTaskId: 'TASK-123',
      headSha: 'abc123',
      idempotencyKey: payload.idempotencyKey,
    });

    const reviewResult = await server.inject({
      method: 'POST',
      url: `/api/v1/agent-loop/tasks/${first.json().task.id}/review-result`,
      payload: {
        verdict: 'request_changes',
        headShaReviewed: 'abc123',
        blockingIssues: [{
          title: 'Missing backwards compatibility',
          file: 'src/api/message.ts',
          reason: 'The new required field breaks old callers.',
          suggestedFix: 'Keep it optional.',
        }],
        markdown: '## Blocking Issues',
      },
    });

    expect(reviewResult.statusCode).toBe(200);
    expect(reviewResult.json().task.id).toBe(first.json().task.id);
    expect(reviewResult.json().reviewTask.status).toBe('todo');
    expect(reviewResult.json().task.agentLoop).toMatchObject({
      kind: 'codex_fix',
      phase: 'needs_codex_fix',
      previousHeadSha: 'abc123',
      nextReviewRound: 2,
    });
    expect(reviewResult.json().task.labels).toEqual(['agent-loop', 'codex-fix', 'needs-codex-fix']);
    expect((await workbench.listTasks())).toHaveLength(1);
  });

  it('returns typed v1 errors for invalid agent-loop review results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const reviewTask = await workbench.createReviewRound({
      rootTaskId: 'TASK-123',
      round: 1,
      maxRounds: 3,
      idempotencyKey: 'review-result-mismatch',
      changeRequest: {
        scm: 'gitlab',
        repo: 'group/project',
        id: '456',
        type: 'merge_request',
        baseRef: 'main',
        headRef: 'agent/TASK-123-codex',
        headSha: 'abc123',
      },
    });
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/agent-loop/tasks/${reviewTask.id}/review-result`,
      payload: {
        verdict: 'approve',
        headShaReviewed: 'def456',
        blockingIssues: [],
        markdown: 'Reviewed another sha.',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'head_sha_mismatch',
        message: expect.stringContaining('does not match'),
      },
    });
  });

  it('creates tasks and serves timeline and decision data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    let runTaskCalls = 0;
    let createdTaskInput: Record<string, unknown> | null = null;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => ({
          kind: 'EnvironmentPack',
          id: 'commerce-ops',
          name: 'Commerce Ops',
          version: '0.2.0',
          description: 'Service delivery pack',
          tools: [],
          skills: ['release-review', 'delivery-qa'],
          knowledge: [
            { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
            { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }),
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdTaskInput = input;
          return { id: 'legacy-task-1' };
        },
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks',
      payload: { title: 'Inspect auth', goal: 'Review auth flow and patch issues' },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().task.id).toBe('legacy-task-1');
    expect(createResponse.json().task.environmentPackSnapshot.id).toBe('commerce-ops');
    expect(createResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['release-review', 'delivery-qa'],
      selectedKnowledgeIds: ['operations-runbook', 'operations-wiki'],
    });
    expect(createdTaskInput?.environmentPackSnapshot).toEqual({
      id: 'commerce-ops',
      name: 'Commerce Ops',
      version: '0.2.0',
    });
    expect(createdTaskInput?.environmentPackSelection).toEqual({
      selectedSkills: ['release-review', 'delivery-qa'],
      selectedKnowledgeIds: ['operations-runbook', 'operations-wiki'],
    });
    expect(runTaskCalls).toBe(1);

    const taskId = createResponse.json().task.id;

    const listResponse = await server.inject({ method: 'GET', url: '/api/workbench/tasks' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().tasks[0].id).toBe(taskId);

    const timelineResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${taskId}/timeline`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(Array.isArray(timelineResponse.json().timeline)).toBe(true);

    const decisionsResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${taskId}/decisions`,
    });
    expect(decisionsResponse.statusCode).toBe(200);
    expect(decisionsResponse.json().decisions).toEqual([]);
  });

  it('exposes tracker task CRUD and mutation endpoints under /api/v1', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [],
      },
      taskManager: {
        create: () => ({ id: 'unused-kernel-task' }),
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        title: 'Tracker task',
        goal: 'Use tik as the tracker',
        status: 'backlog',
        priority: 1,
        labels: ['Backend', 'Tracker'],
        humanAssignee: 'huyuehui',
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().task).toMatchObject({
      title: 'Tracker task',
      status: 'backlog',
      priority: 1,
      labels: ['backend', 'tracker'],
      humanAssignee: 'huyuehui',
    });
    expect(createResponse.json().task.identifier).toMatch(/^TIK-/);

    const taskId = createResponse.json().task.id;

    const transitionResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/transitions`,
      payload: { to: 'todo', reason: 'Ready' },
    });
    expect(transitionResponse.statusCode).toBe(200);
    expect(transitionResponse.json().task.status).toBe('todo');

    const labelsResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/labels`,
      payload: { add: ['P0'], remove: ['tracker'] },
    });
    expect(labelsResponse.statusCode).toBe(200);
    expect(labelsResponse.json().task.labels).toEqual(['backend', 'p0']);

    const commentResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      payload: { body: 'Looks ready to run.' },
    });
    expect(commentResponse.statusCode).toBe(200);
    expect(commentResponse.json().task.comments[0].body).toBe('Looks ready to run.');

    const dependency = await workbench.createTask({
      title: 'Dependency',
      goal: 'Finish first',
      status: 'todo',
    }, 'task-dependency');
    const dependenciesResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/dependencies`,
      payload: { add: [dependency.id] },
    });
    expect(dependenciesResponse.statusCode).toBe(200);
    expect(dependenciesResponse.json().task.blockedByTaskIds).toEqual([dependency.id]);

    const listResponse = await server.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().tasks.map((task: { id: string }) => task.id)).toContain(taskId);
  });

  it('injects human comments into active tracker tasks as runtime constraints', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });
    const controlCalls: Array<Record<string, unknown>> = [];
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [],
      },
      taskManager: {
        create: () => ({ id: 'unused-kernel-task' }),
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: (taskId: string, command: Record<string, unknown>) => {
        controlCalls.push({ taskId, ...command });
      },
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const activeTask = await workbench.createTask({
      title: 'Active task',
      goal: 'Keep working',
      status: 'running',
    }, 'task-active-comment');
    const backlogTask = await workbench.createTask({
      title: 'Backlog task',
      goal: 'Wait for launch',
      status: 'backlog',
    }, 'task-backlog-comment');

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const activeResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${activeTask.id}/comments`,
      payload: { body: '创建mr 并合并到 master' },
    });
    expect(activeResponse.statusCode).toBe(200);

    const backlogResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${backlogTask.id}/comments`,
      payload: { body: 'Keep this note for later.' },
    });
    expect(backlogResponse.statusCode).toBe(200);

    const agentResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${activeTask.id}/comments`,
      payload: { authorKind: 'agent', body: 'Agent progress note.' },
    });
    expect(agentResponse.statusCode).toBe(200);

    const slashCommandResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${activeTask.id}/comments`,
      payload: { body: '/done' },
    });
    expect(slashCommandResponse.statusCode).toBe(200);

    expect(controlCalls).toEqual([
      {
        taskId: activeTask.id,
        type: 'inject_constraint',
        constraint: '创建mr 并合并到 master',
      },
    ]);
  });

  it('returns typed /api/v1 error envelopes for invalid task transitions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [],
      },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Invalid',
      goal: 'Cannot jump',
      status: 'backlog',
    }, 'task-invalid-api');
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/transitions`,
      payload: { to: 'completed' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'transition_not_allowed',
        message: expect.stringContaining('Cannot transition'),
      },
    });
  });

  it('runs a workbench-backed tracker tick from /api/v1/tracker/refresh', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    let createdKernelTaskId = 0;
    let runTaskCalls = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [],
      },
      taskManager: {
        create: () => {
          createdKernelTaskId += 1;
          return { id: `kernel-refresh-${createdKernelTaskId}` };
        },
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Dispatch me',
      goal: 'Refresh should run tracker tick',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-refresh-dispatch');
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tracker/refresh',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.dispatched).toEqual([task.identifier]);
    expect(runTaskCalls).toBe(1);
    const updatedTask = await workbench.readTask(task.id);
    expect(updatedTask?.status).toBe('in_progress');
    expect(updatedTask?.attempts).toEqual([
      expect.objectContaining({
        attemptNumber: 1,
        kernelTaskId: 'kernel-refresh-1',
      }),
    ]);
  });

  it('routes and manually runs a workflow v2 task through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    const sourceProjectPath = path.join(root, 'source');
    const effectiveProjectPath = path.join(root, 'worktree');
    await fs.mkdir(sourceProjectPath, { recursive: true });
    await fs.mkdir(effectiveProjectPath, { recursive: true });
    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'selector:',
      '  include_labels: [ready]',
      'routing:',
      '  rules:',
      '    - labels_any: [runner:claude]',
      '      runner: claude-code',
      '      mode: claude_print',
      '  default_runner: codex',
      '  default_mode: codex_app_server',
      'concurrency:',
      '  lock: repository_branch',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const runtimeRunner = new CompletingRuntimeRunner();
    let createdKernelTaskId = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: {
        create: () => {
          createdKernelTaskId += 1;
          return { id: `kernel-v2-${createdKernelTaskId}` };
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const task = await workbench.createTask({
      title: 'Workflow v2 task',
      goal: 'Manual run should use workflow v2 routing',
      status: 'todo',
      labels: ['ready', 'runner:claude'],
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik-test',
        projectName: 'tik-test',
        sourceProjectPath,
        effectiveProjectPath,
        worktreeKind: 'git-worktree',
      },
    }, 'task-workflow-v2-run');
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root, runtimeRunners: { 'claude-code': runtimeRunner } },
    );
    servers.push(server);

    const preview = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/routing-preview`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      runnable: true,
      routing: {
        runner: 'claude-code',
        mode: 'claude_print',
        matchedSource: 'explicit-label',
      },
    });
    const run = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/run`,
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().result.dispatched).toEqual([task.shortIdentifier]);
    expect(run.json().result.failed).toEqual([]);

    expect(runtimeRunner.preparedInputs[0]).toMatchObject({
      projectPath: effectiveProjectPath,
      runnerMode: 'claude_print',
      renderedPrompt: 'Implement TIK-1.',
    });
    expect(runtimeRunner.startedInputs[0]).toMatchObject({
      cwd: effectiveProjectPath,
      mode: 'claude_print',
    });
    const runsIndex = await fs.readFile(path.join(root, '.tik', 'runs', 'agent-runs.jsonl'), 'utf-8');
    expect(runsIndex).toContain(task.id);
    const runId = JSON.parse(runsIndex.trim().split(/\r?\n/)[0]).id;
    await waitFor(async () => {
      const metadata = await readJsonIfReady(path.join(root, '.tik', 'runs', runId, 'metadata.json'));
      return metadata.status === 'completed_by_agent';
    });
    await waitFor(async () => (await workbench.readTask(task.id))?.status === 'in_review');
  });

  it('reports blocked workflow v2 tasks as not runnable in routing preview', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  rules:',
      '    - labels_any: [backend]',
      '      runner: codex',
      '      mode: codex_app_server',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Blocked task',
      goal: 'Do not route blocked tasks',
      status: 'blocked',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-blocked-routing-preview');
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/routing-preview`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runnable: false,
      reason: 'blocked',
    });
  });

  it('dispatches workflow v2 tasks from /api/v1/tracker/refresh only when environment labels map to actions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'WORKFLOW.md'), [
      '---',
      'version: 2',
      'routing:',
      '  rules:',
      '    - labels_any: [backend]',
      '      runner: codex',
      '      mode: codex_app_server',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'kernel-v2-refresh-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const task = await workbench.createTask({
      title: 'Workflow v2 refresh task',
      goal: 'Refresh should use workflow v2 environment label routing',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-workflow-v2-refresh');
    await workbench.createTask({
      title: 'Fallback should not dispatch',
      goal: 'Refresh should not use workflow v2 default routing without an environment action label',
      status: 'todo',
      labels: ['ready'],
    }, 'task-workflow-v2-no-fallback');
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({ method: 'POST', url: '/api/v1/tracker/refresh' });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.dispatched).toEqual([task.shortIdentifier]);
  });

  it('returns persisted tracker watching and recent state from /api/v1/tracker/state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    await fs.mkdir(path.join(root, '.tik', 'tracker-daemon'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.tik', 'tracker-daemon', 'state.json'),
      JSON.stringify({
        watching: true,
        retries: {},
        recent: [
          {
            type: 'dispatched',
            shortIdentifier: 'TIK-1',
            message: 'TIK-1 dispatched',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      title: 'Runnable task',
      goal: 'Ready for tracker',
      status: 'todo',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-runnable');
    await workbench.createTask({
      title: 'Workspace cleanup',
      goal: 'Clean stale worktrees',
      status: 'todo',
      labels: ['worktree'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-maintenance');
    await workbench.createTask({
      title: 'Stale running task',
      goal: 'Lost its kernel session',
      status: 'running',
      labels: ['backend'],
      environmentPackSnapshot: TEST_ENVIRONMENT_SNAPSHOT,
    }, 'task-stale-running');
    await workbench.createTask({
      title: 'Real running task',
      goal: 'Has an open attempt',
      status: 'in_progress',
      attempts: [{
        attemptNumber: 1,
        startedAt: '2026-01-01T00:00:00.000Z',
        kernelTaskId: 'kernel-live',
      }],
    }, 'task-live-running');
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/v1/tracker/state' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      watching: true,
      retries: {},
      summary: {
        activeCandidates: 1,
        activeRuns: 1,
        maintenance: 1,
        staleRunning: 1,
      },
      recent: [
        {
          type: 'dispatched',
          shortIdentifier: 'TIK-1',
          message: 'TIK-1 dispatched',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(body.listeners).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tracker-watch',
        label: 'Tracker watch',
      }),
      expect.objectContaining({
        id: 'api-server',
        label: 'API server',
        port: 0,
      }),
      expect.objectContaining({
        id: 'dashboard',
        label: 'Dashboard dev server',
      }),
    ]));
    expect(body.listeners.find((listener: { id: string }) => listener.id === 'tracker-watch')?.status)
      .toMatch(/^(running|expected)$/);
    const dashboard = body.listeners.find((listener: { id: string }) => listener.id === 'dashboard');
    expect(dashboard).toMatchObject({
      id: 'dashboard',
      port: 5173,
    });
  });

  it('does not mark tracker watch mode as active after a manual refresh tick', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    await workbench.createTask({
      title: 'Manual tick only',
      goal: 'Refresh should not imply watch mode',
      status: 'todo',
    }, 'task-manual-watch');
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'kernel-manual-watch-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const refresh = await server.inject({ method: 'POST', url: '/api/v1/tracker/refresh' });
    expect(refresh.statusCode).toBe(200);

    const state = await server.inject({ method: 'GET', url: '/api/v1/tracker/state' });
    expect(state.statusCode).toBe(200);
    expect(state.json().watching).toBe(false);
  });

  it('reads and writes the workspace WORKFLOW.md through /api/v1/workflow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const workflowPath = path.join(root, '.tik', 'WORKFLOW.md');
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(workflowPath, [
      '---',
      'polling:',
      '  interval_ms: 3000',
      '---',
      'Implement {{ task.shortIdentifier }}.',
    ].join('\n'), 'utf-8');

    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [],
      },
      taskManager: { create: () => ({ id: 'unused' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const readResponse = await server.inject({ method: 'GET', url: '/api/v1/workflow' });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.json()).toMatchObject({
      exists: true,
      path: workflowPath,
    });
    expect(readResponse.json().content).toContain('interval_ms: 3000');

    const nextContent = [
      '---',
      'polling:',
      '  interval_ms: 4500',
      '---',
      'Implement {{ task.title }}.',
    ].join('\n');
    const writeResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/workflow',
      payload: { content: nextContent },
    });

    expect(writeResponse.statusCode).toBe(200);
    expect(writeResponse.json()).toMatchObject({
      saved: true,
      path: workflowPath,
    });
    await expect(fs.readFile(workflowPath, 'utf-8')).resolves.toBe(`${nextContent}\n`);
  });

  it('creates legacy and v1 tasks with an explicit environment binding instead of relying on the active pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    let createdTaskInput: Record<string, unknown> | null = null;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => ({
          kind: 'EnvironmentPack',
          id: 'commerce-ops',
          name: 'Commerce Ops',
          version: '0.2.0',
          description: 'Service delivery pack',
          tools: [],
          skills: ['release-review', 'delivery-qa'],
          knowledge: [
            { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
            { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }),
        listPacks: async () => [
          {
            kind: 'EnvironmentPack',
            id: 'commerce-ops',
            name: 'Commerce Ops',
            version: '0.2.0',
            description: 'Service delivery pack',
            tools: [],
            skills: ['release-review', 'delivery-qa'],
            knowledge: [
              { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
              { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
          {
            kind: 'EnvironmentPack',
            id: 'base-engineering',
            name: 'Base Engineering',
            version: '0.1.0',
            description: 'Base pack',
            tools: ['shell'],
            skills: ['coder', 'pr-review', 'test-runner'],
            knowledge: [
              { id: 'repo-index', kind: 'repo-index', label: 'Repository Index' },
              { id: 'runbooks', kind: 'runbook', label: 'Runbooks' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
        ],
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdTaskInput = input;
          return { id: 'legacy-task-explicit-pack' };
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks',
      payload: {
        title: 'Ship preview build',
        goal: 'Prepare a reviewable preview before launch',
        environmentPackId: 'base-engineering',
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
    });
    expect(createResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['coder', 'test-runner'],
      selectedKnowledgeIds: ['repo-index'],
    });
    expect(createdTaskInput?.environmentPackSnapshot).toEqual({
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
    });
    expect(createdTaskInput?.environmentPackSelection).toEqual({
      selectedSkills: ['coder', 'test-runner'],
      selectedKnowledgeIds: ['repo-index'],
    });

    const v1Response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        title: 'Plan preview validation',
        goal: 'Queue a manual preview validation pass',
        environmentPackId: 'base-engineering',
        selectedSkills: ['coder'],
        selectedKnowledgeIds: ['runbooks'],
      },
    });

    expect(v1Response.statusCode).toBe(200);
    expect(v1Response.json().task.environmentPackSnapshot).toEqual({
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
    });
    expect(v1Response.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['coder'],
      selectedKnowledgeIds: ['runbooks'],
    });
  });

  it('retries an inactive task by cloning it into a new running task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const createdInputs: Record<string, unknown>[] = [];
    let nextTaskId = 0;
    let runTaskCalls = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdInputs.push(input);
          nextTaskId += 1;
          return { id: `legacy-task-${nextTaskId}` };
        },
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const original = await workbench.createTask({
      title: 'Snake game',
      goal: 'Build an H5 playable snake game',
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react'],
        selectedKnowledgeIds: ['design-system'],
      },
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        effectiveProjectPath: path.join(root, 'apps', 'snake'),
        projectName: 'snake',
        sourceProjectPath: path.join(root, 'apps', 'snake'),
        worktreeKind: 'source',
      },
    }, 'legacy-task-original');
    await store.upsertTask({
      ...original,
      status: 'failed',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Supervisor observed event task.failed.',
      lastAdjustment: {
        previousTitle: 'Snake game',
        previousGoal: 'Build an H5 playable snake game',
        nextTitle: 'Snake game',
        nextGoal: 'Build an H5 playable snake game',
        note: 'Add more playful motion.',
        appliedAt: '2026-04-09T00:00:02.000Z',
      },
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${original.id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json().task.id).toBe('legacy-task-1');
    expect(retryResponse.json().task.title).toBe('Snake game');
    expect(retryResponse.json().task.goal).toBe('Build an H5 playable snake game');
    expect(retryResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
    expect(retryResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['figma-to-react'],
      selectedKnowledgeIds: ['design-system'],
    });
    expect(retryResponse.json().task.lastAdjustment.note).toBe('Add more playful motion.');
    expect(retryResponse.json().task.workspaceBinding).toEqual({
      workspaceRoot: root,
      workspaceName: 'tik',
      effectiveProjectPath: path.join(root, 'apps', 'snake'),
      projectName: 'snake',
      sourceProjectPath: path.join(root, 'apps', 'snake'),
      worktreeKind: 'source',
    });
    expect(createdInputs[0]).toMatchObject({
      description: [
        'Snake game: Build an H5 playable snake game',
        'Adjustment note: Add more playful motion.',
      ].join('\n\n'),
      projectPath: path.join(root, 'apps', 'snake'),
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        effectiveProjectPath: path.join(root, 'apps', 'snake'),
        projectName: 'snake',
        sourceProjectPath: path.join(root, 'apps', 'snake'),
        worktreeKind: 'source',
      },
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react'],
        selectedKnowledgeIds: ['design-system'],
      },
    });
    expect(runTaskCalls).toBe(1);
  });

  it('updates task-level skill and knowledge configuration through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [{
          kind: 'EnvironmentPack',
          id: 'design-to-code',
          name: 'Design To Code',
          version: '0.1.0',
          description: 'Design delivery pack',
          tools: ['frontend-preview'],
          skills: ['figma-to-react', 'ui-review'],
          knowledge: [
            { id: 'design-system', kind: 'design-system', label: 'Design System' },
            { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }],
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateEnvironmentPackSelection: (
          taskId: string,
          selection: Record<string, unknown>,
          snapshot?: Record<string, unknown>,
        ) => {
          const task = taskState.get(taskId);
          if (task) {
            task.environmentPackSelection = selection;
            if (snapshot) {
              task.environmentPackSnapshot = snapshot;
            }
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Configure task',
      goal: 'Narrow runtime capabilities',
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react', 'ui-review'],
        selectedKnowledgeIds: ['design-system', 'ui-guidelines'],
      },
    }, 'task-config');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
      environmentPackSnapshot: task.environmentPackSnapshot,
      environmentPackSelection: task.environmentPackSelection,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const updateResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/configuration`,
      payload: {
        selectedSkills: ['ui-review'],
        selectedKnowledgeIds: ['ui-guidelines'],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });
    expect(taskState.get(task.id)?.environmentPackSelection).toEqual({
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });
  });

  it('rebinds the task to another environment pack through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [
          {
            kind: 'EnvironmentPack',
            id: 'base-engineering',
            name: 'Base Engineering',
            version: '0.1.0',
            description: 'Base pack',
            tools: ['shell'],
            skills: ['coder', 'pr-review'],
            knowledge: [
              { id: 'repo-index', kind: 'repo-index', label: 'Repository Index' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
          {
            kind: 'EnvironmentPack',
            id: 'design-to-code',
            name: 'Design To Code',
            version: '0.1.0',
            description: 'Design delivery pack',
            tools: ['frontend-preview'],
            skills: ['figma-to-react', 'ui-review'],
            knowledge: [
              { id: 'design-system', kind: 'design-system', label: 'Design System' },
              { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
        ],
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateEnvironmentPackSelection: (
          taskId: string,
          selection: Record<string, unknown>,
          snapshot?: Record<string, unknown>,
        ) => {
          const task = taskState.get(taskId);
          if (task) {
            task.environmentPackSelection = selection;
            if (snapshot) {
              task.environmentPackSnapshot = snapshot;
            }
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Retarget task',
      goal: 'Move this task into the design flow',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'pr-review'],
        selectedKnowledgeIds: ['repo-index'],
      },
    }, 'task-rebind');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
      environmentPackSnapshot: task.environmentPackSnapshot,
      environmentPackSelection: task.environmentPackSelection,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const updateResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/configuration`,
      payload: {
        environmentPackId: 'design-to-code',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
    expect(updateResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['figma-to-react', 'ui-review'],
      selectedKnowledgeIds: ['design-system', 'ui-guidelines'],
    });
    expect(taskState.get(task.id)?.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
  });

  it('updates the task brief through the workbench API and syncs the kernel task description', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Console polish',
      goal: 'Ship the control-console shell',
    }, 'task-brief');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Console control shell',
        goal: 'Ship the control-console shell with explicit task steering',
        adjustment: 'Make the center panel behave like task adjustment, not chat.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.title).toBe('Console control shell');
    expect(response.json().task.goal).toContain('explicit task steering');
    expect(taskState.get(task.id)?.description).toContain('Adjustment note: Make the center panel behave like task adjustment, not chat.');

    const timelineResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${task.id}/timeline`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(
      timelineResponse.json().timeline.some((item: { actor: string; body: string }) => (
        item.actor === 'user' && item.body.includes('Adjusted task brief')
      )),
    ).toBe(true);
  });

  it('uses an operator note to resume a waiting task instead of leaving it stuck in review', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const controlCalls: Array<Record<string, unknown>> = [];
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: (taskId: string, command: Record<string, unknown>) => {
        controlCalls.push({ taskId, ...command });
      },
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Preview release validation',
      goal: 'Validate the console preview before approval',
    }, 'task-note-resume');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });
    await workbench.requestToolApproval(task.id, 'bash');

    const waitingTask = await workbench.readTask(task.id);
    expect(waitingTask?.status).toBe('waiting_for_user');
    expect(waitingTask?.waitingDecisionId).toBeTruthy();
    await store.upsertTask({
      ...(await store.readTaskBundle(task.id)).task!,
      status: 'running',
      updatedAt: '2026-04-13T12:44:30.000Z',
      latestSummary: 'Supervisor resumed task execution.',
      waitingReason: undefined,
      waitingDecisionId: undefined,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Preview release validation',
        goal: 'Validate the console preview before approval',
        adjustment: 'Avoid the risky shell path and continue with a safer review pass.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.status).toBe('running');
    expect(response.json().task.waitingDecisionId).toBeUndefined();
    expect(response.json().task.lastAdjustment.note).toBe('Avoid the risky shell path and continue with a safer review pass.');
    expect(response.json().task.latestSummary).toContain('Operator rejected');
    expect(controlCalls).toContainEqual({
      taskId: task.id,
      type: 'inject_constraint',
      constraint: 'Avoid the risky shell path and continue with a safer review pass.',
    });

    const decisionsResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${task.id}/decisions`,
    });
    expect(decisionsResponse.statusCode).toBe(200);
    expect(decisionsResponse.json().decisions).toEqual([]);
  });

  it('launches a follow-up pass when a brief update requests the next run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const createdInputs: Record<string, unknown>[] = [];
    let runTaskCalls = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdInputs.push(input);
          return { id: `legacy-follow-up-${createdInputs.length}` };
        },
        get: () => null,
        updateDescription: () => undefined,
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const workspaceBinding = {
      workspaceRoot: root,
      workspaceName: 'tik',
      effectiveProjectPath: path.join(root, 'apps', 'console'),
      projectName: 'console',
      sourceProjectPath: path.join(root, 'apps', 'console'),
      worktreeKind: 'source' as const,
    };
    const task = await workbench.createTask({
      title: 'Snake polish',
      goal: 'Ship a more expressive snake game pass',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
      workspaceBinding,
    }, 'task-follow-up-source');
    await store.upsertTask({
      ...task,
      status: 'completed',
      workspaceBinding,
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Task completed and the latest outputs are ready for review.',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Snake polish',
        goal: 'Ship a more expressive snake game pass',
        adjustment: 'Add more cartoon motion and acceptance evidence.',
        launchFollowUp: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.lastAdjustment.note).toBe('Add more cartoon motion and acceptance evidence.');
    expect(response.json().followUpTask.id).toBe('legacy-follow-up-1');
    expect(response.json().followUpTask.lastAdjustment.note).toBe('Add more cartoon motion and acceptance evidence.');
    expect(response.json().followUpTask.workspaceBinding).toEqual(workspaceBinding);
    expect(createdInputs[0]).toMatchObject({
      description: [
        'Snake polish: Ship a more expressive snake game pass',
        'Adjustment note: Add more cartoon motion and acceptance evidence.',
      ].join('\n\n'),
      projectPath: workspaceBinding.effectiveProjectPath,
      workspaceBinding,
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
    });
    expect(runTaskCalls).toBe(1);
  });

  it('reverts the latest task brief adjustment through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Original brief',
      goal: 'Ship the original scope',
    }, 'task-revert');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });
    await workbench.updateTaskBrief(task.id, {
      title: 'Adjusted brief',
      goal: 'Ship the adjusted scope',
      adjustment: 'Prioritize previewable output.',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief/revert`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.title).toBe('Original brief');
    expect(response.json().task.goal).toBe('Ship the original scope');
    expect(response.json().task.lastAdjustment).toBeUndefined();
    expect(taskState.get(task.id)?.description).toBe('Original brief: Ship the original scope');
  });

  it('rejects retry while a task is still active', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'legacy-task-1' }),
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const original = await workbench.createTask({
      title: 'Still running',
      goal: 'Do active work',
    }, 'legacy-task-original');
    await store.upsertTask({
      ...original,
      status: 'running',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${original.id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(409);
    expect(retryResponse.json().error).toContain('cannot be retried');
  });

  it('archives inactive tasks and hides them from active workflows without deleting history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Archive me',
      goal: 'Keep the list clean',
    }, 'task-archive');
    await store.upsertTask({
      ...task,
      status: 'failed',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
    });

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/archive`,
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().task.status).toBe('archived');

    const taskListResponse = await server.inject({ method: 'GET', url: '/api/workbench/tasks' });
    expect(taskListResponse.statusCode).toBe(200);
    expect(taskListResponse.json().tasks.find((item: { id: string }) => item.id === task.id)?.status).toBe('archived');
  });

  it('serves run proofs and review decision routes for workbench tasks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const artifactRegistry = new FileArtifactRegistry({ rootPath: root });
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus,
      store,
      artifacts: artifactRegistry,
    });
    const runStore = new FileAgentRunStore(root);
    const proofStore = new FileRunProofStore(root);

    await workbench.createTask({
      title: 'Review proof',
      goal: 'Expose run proof review routes',
      status: 'needs_review',
    }, 'task-proof');
    const reviewArtifact = await artifactRegistry.create({
      taskId: 'task-proof',
      title: 'Run Review: TIK-1 attempt 1',
      kind: 'run_review',
      content: '# Run Review',
      contentType: 'text/markdown',
      extension: 'md',
      tags: ['run-review', 'run-1'],
    });
    await runStore.createRun({
      id: 'run-1',
      taskId: 'task-proof',
      shortIdentifier: 'TIK-1',
      attempt: 1,
      runner: 'codex',
      runnerMode: 'codex_exec',
      workflowPath: path.join(root, '.tik', 'WORKFLOW.md'),
      workflowConfigHash: 'config-hash',
      workflowPromptHash: 'prompt-hash',
      status: 'needs_review',
      workspaceRoot: root,
      projectPath: root,
      transcriptRefs: [],
      eventRefs: [],
      artifactIds: [reviewArtifact.id],
    });
    const proof: RunProof = {
      id: 'proof-1',
      taskId: 'task-proof',
      runId: 'run-1',
      attempt: 1,
      status: 'ready_for_review',
      risk: 'low',
      summary: 'Runner completed with review evidence.',
      transcriptArtifactIds: [],
      diff: { filesChanged: 1, changedFiles: ['README.md'] },
      validationRefs: [],
      producedArtifactIds: [reviewArtifact.id],
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    };
    await proofStore.saveProof(proof);

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const runsResponse = await server.inject({
      method: 'GET',
      url: '/api/workbench/tasks/task-proof/runs',
    });
    const proofResponse = await server.inject({
      method: 'GET',
      url: '/api/workbench/tasks/task-proof/runs/run-1/proof',
    });
    const rejectResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks/task-proof/review/reject',
      payload: {
        runId: 'run-1',
        artifactId: reviewArtifact.id,
        reason: 'Needs stronger validation',
        reviewer: 'api-test',
      },
    });

    expect(runsResponse.statusCode).toBe(200);
    expect(runsResponse.json().runs).toHaveLength(1);
    expect(proofResponse.statusCode).toBe(200);
    expect(proofResponse.json().proof).toMatchObject({
      id: 'proof-1',
      runId: 'run-1',
      status: 'ready_for_review',
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json().artifact.status).toBe('rejected');
    expect(rejectResponse.json().task.status).toBe('retry');
  });

  it('archives stale running tasks when the workbench record exists but the kernel task is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Orphaned runtime',
      goal: 'Keep the queue clean even when runtime state is missing',
    }, 'task-stale-archive');
    await store.upsertTask({
      ...task,
      status: 'running',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Supervisor observed event iteration.completed.',
    });

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/archive`,
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().task.status).toBe('archived');
    expect(archiveResponse.json().task.latestSummary).toContain('runtime record went missing');
  });

  it('resolves a workbench decision through the API and clears the waiting state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => ({ id: 'task-decision' }),
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Publish dry-run',
      goal: 'Validate decision resolution',
    }, 'task-decision');
    const decision = await workbench.requestToolApproval(task.id, 'bash');

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/decisions/${decision!.id}/resolve`,
      payload: {
        optionId: 'reject',
        message: 'Use a safer publish path.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision.status).toBe('dismissed');
    expect(response.json().task.waitingDecisionId).toBeUndefined();
    expect(response.json().task.waitingReason).toBeUndefined();
    expect(response.json().task.latestSummary).toContain('rejected');
  });

  it('disables legacy path-based artifact preview by default', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);
    const previewPath = path.join(root, 'src', 'mock-app.html');
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, '<!doctype html><title>Preview</title><h1>Snake</h1>', 'utf-8');
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus: new EventBus(),
      store: new WorkbenchStore(root),
    });
    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };
    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent(previewPath)}`,
    });

    expect(previewResponse.statusCode).toBe(410);
  });

  it('serves legacy previewable artifact files only when explicitly enabled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const previewPath = path.join(root, 'src', 'mock-app.html');
    const unsafePath = path.join(root, 'src', 'run.sh');
    const symlinkPath = path.join(root, 'src', 'hosts-link.html');
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, '<!doctype html><title>Preview</title><h1>Snake</h1>', 'utf-8');
    await fs.writeFile(unsafePath, 'echo nope', 'utf-8');
    await fs.symlink('/etc/hosts', symlinkPath);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, {
      workspaceRoot: root,
      enableLegacyPathArtifactPreview: true,
    });
    servers.push(server);

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent(previewPath)}`,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers['content-type']).toContain('text/html');
    expect(previewResponse.body).toContain('<h1>Snake</h1>');

    const blockedResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent('/etc/hosts')}`,
    });
    expect(blockedResponse.statusCode).toBe(403);

    const unsafeExtensionResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent(unsafePath)}`,
    });
    expect(unsafeExtensionResponse.statusCode).toBe(415);

    const symlinkEscapeResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent(symlinkPath)}`,
    });
    expect(symlinkEscapeResponse.statusCode).toBe(403);
  });

  it('exposes first-class artifact registry routes and artifact-id preview', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus,
      store,
      artifacts: new FileArtifactRegistry({ rootPath: root }),
    });
    await workbench.createTask({
      title: 'Review artifact API',
      goal: 'Publish a task review artifact',
    }, 'task-artifacts');

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/artifacts',
      payload: {
        taskId: 'task-artifacts',
        title: 'Task Review: artifact API',
        kind: 'report',
        content: '<h1>Artifact API</h1>',
        contentType: 'text/html',
        extension: 'html',
        sourceEventIds: ['evt-create'],
        sourceEvidenceIds: ['ev-create'],
        validationRefs: ['pnpm --filter @tik/kernel test'],
        producedBy: { provider: 'codex', template: 'task-review' },
        tags: ['review'],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const artifact = createResponse.json().artifact;
    expect(artifact).toMatchObject({
      taskId: 'task-artifacts',
      title: 'Task Review: artifact API',
      status: 'needs_review',
      version: 1,
      latestVersionId: expect.any(String),
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/workbench/artifacts?status=needs_review&tag=review',
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().artifacts.map((item: { id: string }) => item.id)).toEqual([artifact.id]);

    const taskArtifactsResponse = await server.inject({
      method: 'GET',
      url: '/api/workbench/tasks/task-artifacts/artifacts',
    });
    expect(taskArtifactsResponse.statusCode).toBe(200);
    expect(taskArtifactsResponse.json().artifacts[0].id).toBe(artifact.id);

    const appendResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/artifacts/${artifact.id}/versions`,
      payload: {
        content: '<h1>Artifact API v2</h1>',
        contentType: 'text/html',
        extension: 'html',
        sourceEventIds: ['evt-update'],
        sourceEvidenceIds: ['ev-update'],
      },
    });
    expect(appendResponse.statusCode).toBe(200);
    expect(appendResponse.json().artifact.version).toBe(2);

    const versionsResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/${artifact.id}/versions`,
    });
    expect(versionsResponse.statusCode).toBe(200);
    expect(versionsResponse.json().versions.map((version: { version: number }) => version.version)).toEqual([1, 2]);

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/${artifact.id}/versions/${appendResponse.json().artifact.latestVersionId}/preview`,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers['content-type']).toContain('text/html');
    expect(previewResponse.body).toContain('Artifact API v2');

    const acceptResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/artifacts/${artifact.id}/accept`,
      payload: { actor: 'reviewer' },
    });
    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json().artifact.status).toBe('accepted');

    const rejectResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/artifacts/${artifact.id}/reject`,
      payload: { reason: 'Need one more screenshot', actor: 'reviewer' },
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json().artifact).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Need one more screenshot',
    });

    const timeline = await workbench.readTimeline('task-artifacts');
    expect(timeline.map((item) => item.body)).toContain('Artifact rejected: Task Review: artifact API (v2, rejected).');
  });

  it('generates task-review artifacts as versions with provenance and renders markdown previews as HTML', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({
      rootPath: root,
      eventBus,
      store,
      artifacts: new FileArtifactRegistry({ rootPath: root }),
    });
    await workbench.createTask({
      title: 'Review artifact generation',
      goal: 'Produce a task review artifact with provenance',
    }, 'task-generate-artifact');

    const changedFile = path.join(root, 'src', 'review.html');
    await fs.mkdir(path.dirname(changedFile), { recursive: true });
    await fs.writeFile(changedFile, '<h1>Review</h1>', 'utf-8');
    eventBus.emit({
      id: 'evt-write-preview',
      type: EventType.TOOL_RESULT,
      taskId: 'task-generate-artifact',
      payload: {
        toolName: 'write_file',
        output: 'Wrote preview',
        durationMs: 12,
        success: true,
        filesModified: [changedFile],
      },
      timestamp: Date.now(),
    });
    eventBus.emit({
      id: 'evt-test-run',
      type: EventType.TOOL_RESULT,
      taskId: 'task-generate-artifact',
      payload: {
        toolName: 'bash',
        output: 'pnpm test\nTests passed',
        durationMs: 33,
        success: true,
      },
      timestamp: Date.now(),
    });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const firstGenerateResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks/task-generate-artifact/artifacts/generate',
      payload: { template: 'task-review' },
    });
    expect(firstGenerateResponse.statusCode).toBe(200);
    const firstArtifact = firstGenerateResponse.json().artifact;
    expect(firstArtifact).toMatchObject({
      taskId: 'task-generate-artifact',
      version: 1,
      sourceEventIds: ['evt-write-preview', 'evt-test-run'],
      changedFiles: [changedFile],
    });
    expect(firstArtifact.sourceEvidenceIds.length).toBeGreaterThan(0);
    expect(firstArtifact.validationRefs).toEqual(expect.arrayContaining(['bash: pnpm test']));

    const secondGenerateResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks/task-generate-artifact/artifacts/generate',
      payload: { template: 'task-review' },
    });
    expect(secondGenerateResponse.statusCode).toBe(200);
    const secondArtifact = secondGenerateResponse.json().artifact;
    expect(secondArtifact.id).toBe(firstArtifact.id);
    expect(secondArtifact.version).toBe(2);

    const taskArtifactsResponse = await server.inject({
      method: 'GET',
      url: '/api/workbench/tasks/task-generate-artifact/artifacts',
    });
    expect(taskArtifactsResponse.json().artifacts
      .filter((artifact: { producedBy?: { template?: string } }) => artifact.producedBy?.template === 'task-review')
      .map((artifact: { id: string }) => artifact.id)).toEqual([firstArtifact.id]);

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/${secondArtifact.id}/versions/${secondArtifact.latestVersionId}/preview`,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers['content-type']).toContain('text/html');
    expect(previewResponse.body).toContain('<h1>Task Review: Review artifact generation</h1>');
    expect(previewResponse.body).toContain('<li>');
  });
});

async function waitForFile(filePath: string, timeoutMs = 200): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for file: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 300): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for predicate.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function readJsonIfReady(filePath: string): Promise<any> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
