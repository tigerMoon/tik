import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus.js';
import { createServer } from '../src/server.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('multi-agent coordination API', () => {
  it('persists workflow state, task graph, decisions, evidence, and timeline without choosing policy actions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    await fs.mkdir(path.join(root, 'repo'), { recursive: true });
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-auth',
        goal: 'Implement auth flow',
        rootTaskId: 'root-auth',
        repo: 'repo',
        baseRef: 'main',
        headRef: 'codex/auth',
        headSha: 'abc123',
        maxRounds: 2,
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: path.join(root, 'repo'),
          sourceProjectPath: path.join(root, 'repo'),
          worktreeKind: 'root',
        },
      },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().workflow).toMatchObject({
      id: 'wf-auth',
      driver: 'codex-workflow',
      status: 'active',
      goal: 'Implement auth flow',
      rootTaskId: 'root-auth',
      currentHeadSha: 'abc123',
      maxRounds: 2,
    });

    const taskGraph = {
      workflowId: 'wf-auth',
      version: 1,
      createdBy: 'claude-code',
      risks: ['Auth touches shared middleware.'],
      globalAcceptanceCriteria: ['All auth tests pass.'],
      finalValidationCommands: ['pnpm --filter @tik/kernel test'],
      subtasks: [
        {
          id: 'st-api',
          title: 'Add auth API',
          goal: 'Expose auth endpoints.',
          dependsOn: [],
          allowedPaths: ['packages/kernel/src'],
          acceptanceCriteria: ['API routes exist.'],
          validationCommands: ['pnpm --filter @tik/kernel test'],
          reviewFocus: ['route guards'],
          assignedExecutor: 'codex',
          assignedReviewer: 'claude-code',
        },
        {
          id: 'st-ui',
          title: 'Connect UI',
          goal: 'Wire dashboard auth state.',
          dependsOn: ['st-api'],
          allowedPaths: ['packages/dashboard/src'],
          acceptanceCriteria: ['Dashboard reacts to auth state.'],
          validationCommands: ['pnpm --filter @tik/dashboard typecheck'],
          reviewFocus: ['state transitions'],
          assignedExecutor: 'codex',
          assignedReviewer: 'claude-code',
        },
      ],
    };

    const putGraph = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-auth/task-graph',
      payload: { graph: taskGraph },
    });
    expect(putGraph.statusCode).toBe(200);
    expect(putGraph.json().subtasks).toMatchObject({
      'st-api': { status: 'ready', fixRound: 0 },
      'st-ui': { status: 'pending', fixRound: 0 },
    });

    const evidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-auth/evidence',
      payload: {
        id: 'ev-validation',
        kind: 'validation',
        title: 'Kernel targeted tests',
        summary: 'Targeted tests passed.',
        subtaskId: 'st-api',
        command: 'pnpm --filter @tik/kernel test',
        passed: true,
      },
    });
    expect(evidence.statusCode).toBe(200);

    const decision = {
      id: 'dec-complete-api',
      workflowId: 'wf-auth',
      rootTaskId: 'root-auth',
      subtaskId: 'st-api',
      decidedBy: 'codex-workflow',
      decidedAt: '2026-06-30T00:00:00.000Z',
      action: 'complete_subtask',
      reason: 'Validation passed and Claude approved.',
      evidenceRefs: ['ev-validation'],
      expectedTikMutation: {
        taskStatus: 'done',
      },
      confidence: 0.91,
    };

    const recordDecision = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-auth/decisions',
      payload: { decision },
    });
    expect(recordDecision.statusCode).toBe(200);
    expect(recordDecision.json()).toMatchObject({
      guard: { accepted: true, code: 'ok' },
      decision,
      workflow: {
        id: 'wf-auth',
        lastDecisionId: 'dec-complete-api',
      },
    });

    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'implemented',
        evidenceRefs: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'approved',
      },
    });
    const updateSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'done',
        evidenceRefs: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });
    expect(updateSubtask.statusCode).toBe(200);
    expect(updateSubtask.json().subtask).toMatchObject({
      subtaskId: 'st-api',
      status: 'done',
      evidenceRefs: ['ev-validation'],
      lastValidatedHeadSha: 'abc123',
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth',
    });
    expect(readWorkflow.statusCode).toBe(200);
    expect(readWorkflow.json()).toMatchObject({
      workflow: {
        id: 'wf-auth',
        driver: 'codex-workflow',
        status: 'active',
      },
      taskGraph,
      subtasks: {
        'st-api': { status: 'done' },
        'st-ui': { status: 'pending' },
      },
    });
    expect(readWorkflow.json().decisions).toHaveLength(1);
    expect(readWorkflow.json().evidence).toHaveLength(1);

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth/timeline',
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toEqual([
      'workflow.created',
      'task_graph.created',
      'evidence.recorded',
      'decision.recorded',
      'subtask.updated',
      'subtask.updated',
      'subtask.updated',
      'subtask.updated',
    ]);

    const storedWorkflow = JSON.parse(
      await fs.readFile(path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-auth', 'workflow.json'), 'utf-8'),
    );
    expect(storedWorkflow.driver).toBe('codex-workflow');
  });

  it('rejects unsafe decision records with guard results instead of inventing a next policy action', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-guard',
        goal: 'Review round guard',
        rootTaskId: 'root-guard',
        headSha: 'head-1',
        maxRounds: 1,
      },
    });

    const missingEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-guard/decisions',
      payload: {
        decision: {
          id: 'dec-missing-evidence',
          workflowId: 'wf-guard',
          rootTaskId: 'root-guard',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-06-30T00:00:00.000Z',
          action: 'complete_workflow',
          reason: 'Pretend completion.',
          evidenceRefs: ['ev-does-not-exist'],
        },
      },
    });

    expect(missingEvidence.statusCode).toBe(409);
    expect(missingEvidence.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'missing_evidence',
      },
    });

    const maxRounds = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-guard/decisions',
      payload: {
        decision: {
          id: 'dec-review-too-far',
          workflowId: 'wf-guard',
          rootTaskId: 'root-guard',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-06-30T00:00:00.000Z',
          action: 'request_re_review',
          reason: 'Codex wants another round.',
          evidenceRefs: [],
          inputs: {
            round: 2,
          },
        },
      },
    });

    expect(maxRounds.statusCode).toBe(409);
    expect(maxRounds.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'max_rounds_exceeded',
      },
    });
    expect(maxRounds.json().decision.action).toBe('request_re_review');
  });

  it('rejects workflow creation when the effective worktree is outside the workspace root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-outside-'));
    tempDirs.push(root, outside);
    const server = await createTestServer(root);
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-outside',
        goal: 'Reject unsafe worktree',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          projectName: 'repo',
          effectiveProjectPath: outside,
          sourceProjectPath: outside,
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'invalid_workspace_binding',
      },
    });
  });

  it('derives workflow workspace root from the server instead of trusting caller input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo, { recursive: true });
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-root-normalized',
        goal: 'Normalize root',
        workspaceBinding: {
          workspaceRoot: '/',
          workspaceName: 'attacker-root',
          projectName: 'repo',
          effectiveProjectPath: repo,
          sourceProjectPath: repo,
          worktreeKind: 'root',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workflow.workspaceBinding).toMatchObject({
      workspaceRoot: root,
      workspaceName: path.basename(root),
      effectiveProjectPath: repo,
    });
  });

  it('preserves existing subtask runtime state when a new TaskGraph version keeps the same subtask id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-replan', goal: 'Preserve replan state' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-replan/task-graph',
      payload: {
        graph: buildTaskGraph('wf-replan', 1, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-ui', dependsOn: ['st-api'] },
        ]),
      },
    });
    let transition = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-replan/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    expect(transition.statusCode).toBe(200);
    transition = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-replan/subtasks/st-api',
      payload: {
        status: 'implemented',
        evidenceRefs: ['ev-implementation'],
        reviewRoundIds: ['rr-1'],
        implementationHeadSha: 'head-1',
        fixRound: 1,
      },
    });
    expect(transition.statusCode).toBe(200);

    const replan = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-replan/task-graph',
      payload: {
        graph: buildTaskGraph('wf-replan', 2, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-docs', dependsOn: ['st-api'] },
        ]),
      },
    });

    expect(replan.statusCode).toBe(200);
    expect(replan.json().subtasks['st-api']).toMatchObject({
      status: 'implemented',
      evidenceRefs: ['ev-implementation'],
      reviewRoundIds: ['rr-1'],
      implementationHeadSha: 'head-1',
      fixRound: 1,
    });
    expect(replan.json().subtasks['st-docs']).toMatchObject({
      status: 'pending',
      fixRound: 0,
    });
    expect(replan.json().subtasks['st-ui']).toBeUndefined();
  });

  it('rejects illegal subtask and invocation state transitions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-transitions', goal: 'Guard transitions' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-transitions/task-graph',
      payload: {
        graph: buildTaskGraph('wf-transitions', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const illegalSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-transitions/subtasks/st-api',
      payload: {
        status: 'done',
      },
    });
    expect(illegalSubtask.statusCode).toBe(409);
    expect(illegalSubtask.json().error.code).toBe('invalid_transition');

    const legalSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-transitions/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    expect(legalSubtask.statusCode).toBe(200);

    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-transitions/agent-invocations',
      payload: {
        role: 'planner',
        runner: 'claude-code',
        promptContract: 'task-graph.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;

    const illegalInvocation = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: { ok: true },
      },
    });
    expect(illegalInvocation.statusCode).toBe(409);
    expect(illegalInvocation.json().error.code).toBe('invalid_transition');

    const started = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/start`,
    });
    expect(started.statusCode).toBe(200);

    const completed = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: { ok: true },
      },
    });
    expect(completed.statusCode).toBe(200);

    const restart = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-transitions/agent-invocations/${invocationId}/start`,
    });
    expect(restart.statusCode).toBe(409);
    expect(restart.json().error.code).toBe('invalid_transition');
  });

  it('rejects foreign subtask identity fields and preserves stored arrays', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-subtask-sanitize', goal: 'Sanitize subtask patches' },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize/task-graph',
      payload: {
        graph: buildTaskGraph('wf-subtask-sanitize', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const polluted = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize/subtasks/st-api',
      payload: {
        subtaskId: 'st-attacker',
        workflowId: 'wf-attacker',
        status: 'executing',
        evidenceRefs: ['ev-a'],
        reviewRoundIds: ['rr-a'],
        validationRunIds: ['vr-a'],
        blockerFindingIds: ['bf-a'],
        fixRound: 99,
        createdAt: '2000-01-01T00:00:00.000Z',
      },
    });

    expect(polluted.statusCode).toBe(400);
    expect(polluted.json().error.code).toBe('invalid_subtask_patch');

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-subtask-sanitize',
    });
    expect(readWorkflow.json().subtasks['st-api']).toMatchObject({
      subtaskId: 'st-api',
      status: 'ready',
      evidenceRefs: [],
      reviewRoundIds: [],
      validationRunIds: [],
      blockerFindingIds: [],
      fixRound: 0,
    });
  });

  it('requires explicit invocation result status so failed runs cannot default to completed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: { id: 'wf-invocation-status', goal: 'Require invocation status' },
    });
    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations',
      payload: {
        role: 'reviewer',
        runner: 'claude-code',
        promptContract: 'review.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;
    await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}/start`,
    });

    const missingStatus = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}/result`,
      payload: {
        error: 'Claude runtime failed before ReviewResult.',
      },
    });

    expect(missingStatus.statusCode).toBe(400);
    expect(missingStatus.json().error.code).toBe('invalid_invocation_status');

    const stored = await server.inject({
      method: 'GET',
      url: `/api/v1/multi-agent/workflows/wf-invocation-status/agent-invocations/${invocationId}`,
    });
    expect(stored.json().invocation).toMatchObject({
      status: 'started',
    });
    expect(stored.json().invocation).not.toHaveProperty('error');
  });
});

async function createTestServer(root: string) {
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
    getSession: () => null,
    control: () => undefined,
    getEvents: () => [],
    streamEvents: async function* streamEvents() {},
    workbench,
  };
  return createServer(
    mockKernel as any,
    { port: 0, host: '127.0.0.1' },
    { workspaceRoot: root },
  );
}

function buildTaskGraph(
  workflowId: string,
  version: number,
  subtasks: Array<{ id: string; dependsOn: string[] }>,
) {
  return {
    workflowId,
    version,
    createdBy: 'claude-code',
    risks: [],
    globalAcceptanceCriteria: [],
    finalValidationCommands: [],
    subtasks: subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.id,
      goal: `Implement ${subtask.id}`,
      dependsOn: subtask.dependsOn,
      allowedPaths: ['packages/kernel/src'],
      acceptanceCriteria: ['Works as specified.'],
      validationCommands: ['pnpm --filter @tik/kernel test'],
      reviewFocus: ['correctness'],
      assignedExecutor: 'codex',
      assignedReviewer: 'claude-code',
    })),
  };
}
