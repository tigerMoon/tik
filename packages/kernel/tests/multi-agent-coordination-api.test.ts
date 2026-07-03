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
  it('serves a workflow bundle from root and review workbench task references', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    await fs.mkdir(path.join(root, 'repo'), { recursive: true });
    tempDirs.push(root);
    const { server, workbench } = await createTestServerWithWorkbench(root);
    servers.push(server);

    const rootTask = await workbench.createTask({
      title: 'Workflow root task',
      goal: 'Show workflow evidence from the task page.',
      status: 'in_progress',
      identifier: 'TIK-ROOT',
      labels: ['multi-agent'],
    }, 'task-root');
    const reviewTask = await workbench.createTask({
      title: 'Workflow review task',
      goal: 'Review workflow evidence.',
      status: 'in_review',
      identifier: 'TIK-REVIEW',
      labels: ['external-claude-review'],
      agentLoop: {
        kind: 'human_review',
        phase: 'needs_human_review',
        rootTaskId: 'wf-task-detail',
        round: 1,
        maxRounds: 3,
        idempotencyKey: 'review:wf-task-detail:r1',
        changeRequest: {
          scm: 'internal',
          repo: 'repo',
          id: 'wf-task-detail:abc123',
          type: 'internal_review',
          title: 'Review workflow evidence',
          baseRef: 'main',
          headRef: 'codex/workflow-evidence',
          headSha: 'abc123',
        },
      },
    }, 'task-review');

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-task-detail',
        goal: 'Expose workflow evidence on task detail',
        rootTaskId: rootTask.id,
        repo: 'repo',
        baseRef: 'main',
        headRef: 'codex/workflow-evidence',
        headSha: 'abc123',
        metadata: {
          deployToken: 'workflow-secret',
          safeLabel: 'workflow-visible',
        },
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

    const taskGraph = buildTaskGraph('wf-task-detail', 1, [{ id: 'st-api', dependsOn: [] }]);
    taskGraph.risks = ['credential should-not-leak in task graph risk'];
    const putGraph = await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/task-graph',
      payload: { graph: taskGraph },
    });
    expect(putGraph.statusCode).toBe(200);

    const evidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/evidence',
      payload: {
        id: 'ev-task-detail',
        kind: 'validation',
        title: 'Task detail API tests',
        summary: 'The workflow bundle is available from task detail.',
        subtaskId: 'st-api',
        command: 'pnpm --filter @tik/kernel test -- multi-agent-coordination-api.test.ts',
        passed: true,
        headSha: 'abc123',
        payload: {
          details: {
            apiKey: 'should-not-leak',
            safeNote: 'visible evidence detail',
          },
        },
      },
    });
    expect(evidence.statusCode).toBe(200);

    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-task-detail/agent-invocations',
      payload: {
        id: 'inv-evaluator',
        role: 'evaluator',
        provider: 'codex',
        status: 'pending',
        createdBy: 'codex-workflow',
        promptSummary: 'Verify task detail workflow evidence.',
        attestationToken: 'secret-token',
      },
    });
    expect(invocation.statusCode).toBe(200);

    const fromRootId = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${rootTask.id}/multi-agent-workflow`,
    });
    expect(fromRootId.statusCode).toBe(200);
    expect(fromRootId.json()).toMatchObject({
      workflow: {
        id: 'wf-task-detail',
        rootTaskId: rootTask.id,
      },
      taskGraph,
      subtasks: {
        'st-api': { status: 'ready' },
      },
      evidence: [
        {
          id: 'ev-task-detail',
          kind: 'validation',
          subtaskId: 'st-api',
        },
      ],
    });
    expect(fromRootId.json().invocations[0]).not.toHaveProperty('attestationToken');
    expect(fromRootId.json().workflow.metadata).toEqual({
      deployToken: '[redacted]',
      safeLabel: 'workflow-visible',
    });
    expect(fromRootId.json().taskGraph.risks).toEqual(['credential should-not-leak in task graph risk']);
    expect(fromRootId.json().evidence[0].payload.details).toEqual({
      apiKey: '[redacted]',
      safeNote: 'visible evidence detail',
    });

    const fromRootIdentifier = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/TIK-ROOT/multi-agent-workflow',
    });
    expect(fromRootIdentifier.statusCode).toBe(200);
    expect(fromRootIdentifier.json().workflow.id).toBe('wf-task-detail');

    const fromReviewTask = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${reviewTask.id}/multi-agent-workflow`,
    });
    expect(fromReviewTask.statusCode).toBe(200);
    expect(fromReviewTask.json().workflow.id).toBe('wf-task-detail');

    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/no-workflow/multi-agent-workflow',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('workflow_not_found');
  });

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

    const validationEvidence = await server.inject({
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
        headSha: 'abc123',
      },
    });
    expect(validationEvidence.statusCode).toBe(200);

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
        implementationHeadSha: 'abc123',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'validated',
        validationRunIds: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });

    const decision = {
      id: 'dec-human-review-api',
      workflowId: 'wf-auth',
      rootTaskId: 'root-auth',
      subtaskId: 'st-api',
      decidedBy: 'codex-workflow',
      decidedAt: '2026-06-30T00:00:00.000Z',
      action: 'request_human_review',
      reason: 'Escalate validated evidence for human review.',
      evidenceRefs: ['ev-validation'],
      inputs: {
        currentHeadSha: 'abc123',
      },
      expectedTikMutation: {
        taskStatus: 'human_review_required',
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
        lastDecisionId: 'dec-human-review-api',
      },
    });

    const updateSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'human_review_required',
        evidenceRefs: ['ev-validation'],
        lastValidatedHeadSha: 'abc123',
      },
    });
    expect(updateSubtask.statusCode).toBe(200);
    expect(updateSubtask.json().subtask).toMatchObject({
      subtaskId: 'st-api',
      status: 'human_review_required',
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
        'st-api': { status: 'human_review_required' },
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
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining([
      'workflow.created',
      'task_graph.created',
      'evidence.recorded',
      'decision.recorded',
      'subtask.updated',
    ]));

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

    const removedLegacyAction = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-guard/decisions',
      payload: {
        decision: {
          id: 'dec-legacy-review-action',
          workflowId: 'wf-guard',
          rootTaskId: 'root-guard',
          decidedBy: 'codex-workflow',
          decidedAt: '2026-06-30T00:00:00.000Z',
          action: 'request_re_review',
          reason: 'Legacy multi-agent review action should be gone.',
          evidenceRefs: [],
        },
      },
    });

    expect(removedLegacyAction.statusCode).toBe(409);
    expect(removedLegacyAction.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'invalid_transition',
      },
    });
    expect(removedLegacyAction.json().guard.message).toMatch(/Unsupported workflow decision action/);
  });

  it('preflights workflow decisions without appending decision history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-preflight',
        goal: 'Preflight decisions',
        rootTaskId: 'root-preflight',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-preflight/task-graph',
      payload: {
        graph: buildTaskGraph('wf-preflight', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await acceptContractForSubtask(server, 'wf-preflight', 'st-api', 'head-1');

    const decision = buildDecision('wf-preflight', {
      id: 'dec-preflight-execute',
      action: 'execute_subtask',
      subtaskId: 'st-api',
      reason: 'Preflight execution.',
      inputs: { currentHeadSha: 'head-1' },
    });
    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-preflight/decisions/preflight',
      payload: { decision },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      guard: { accepted: true, code: 'ok' },
      decision,
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-preflight',
    });
    expect(readWorkflow.json().decisions).toHaveLength(0);
    expect(readWorkflow.json().workflow.lastDecisionId).toBeUndefined();
  });

  it('allocates a new SprintContract version instead of overwriting an accepted contract', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-contract-versioning',
        goal: 'Keep accepted contract history intact',
        rootTaskId: 'root-contract-versioning',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/task-graph',
      payload: {
        graph: buildTaskGraph('wf-contract-versioning', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });

    const firstDraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts',
      payload: buildSprintContractPayload({
        id: 'contract-st-api-v1',
        version: 1,
        goal: 'Initial scope',
      }),
    });
    expect(firstDraft.statusCode).toBe(200);
    expect(firstDraft.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      version: 1,
      status: 'draft',
      goal: 'Initial scope',
    });

    const acceptFirst = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/contract-st-api-v1/accept',
    });
    expect(acceptFirst.statusCode).toBe(200);
    expect(acceptFirst.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      version: 1,
      status: 'accepted',
      goal: 'Initial scope',
    });

    const secondDraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts',
      payload: buildSprintContractPayload({
        id: 'contract-st-api-v1',
        version: 1,
        goal: 'Expanded scope',
      }),
    });
    expect(secondDraft.statusCode).toBe(200);
    expect(secondDraft.json().contract).toMatchObject({
      id: 'contract-st-api-v2',
      version: 2,
      status: 'draft',
      goal: 'Expanded scope',
    });

    const latest = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/latest',
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().contract).toMatchObject({
      id: 'contract-st-api-v2',
      version: 2,
      status: 'draft',
    });

    const firstAfterRedraft = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-versioning/subtasks/st-api/contracts/contract-st-api-v1/accept',
    });
    expect(firstAfterRedraft.statusCode).toBe(200);
    expect(firstAfterRedraft.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      version: 1,
      status: 'accepted',
      goal: 'Initial scope',
    });
  });

  it('stores a planner TaskGraph automatically when a planner invocation completes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-planner-auto',
        goal: 'Planner writes TaskGraph',
        rootTaskId: 'root-planner-auto',
        headSha: 'head-1',
      },
    });
    const invocation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations',
      payload: {
        role: 'planner',
        runner: 'claude-code',
        promptContract: 'task-graph.v1',
      },
    });
    const invocationId = invocation.json().invocation.id;
    await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations/${invocationId}/start`,
    });

    const graph = buildTaskGraph('wf-planner-auto', 1, [
      { id: 'st-api', dependsOn: [] },
      { id: 'st-ui', dependsOn: ['st-api'] },
    ]);
    const completed = await server.inject({
      method: 'POST',
      url: `/api/v1/multi-agent/workflows/wf-planner-auto/agent-invocations/${invocationId}/result`,
      payload: {
        status: 'completed',
        result: {
          taskGraph: graph,
        },
      },
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json().taskGraph).toMatchObject({
      graph,
      subtasks: {
        'st-api': { status: 'ready' },
        'st-ui': { status: 'pending' },
      },
    });

    const readWorkflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-planner-auto',
    });
    expect(readWorkflow.json().taskGraph).toMatchObject(graph);
  });

  it('rejects workflow completion without v1 final evaluation evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-v1-completion-gate',
        goal: 'Missing final evaluation gate',
        rootTaskId: 'root-v1-completion-gate',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-v1-completion-gate/task-graph',
      payload: {
        graph: buildTaskGraph('wf-v1-completion-gate', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await moveSubtaskToDoneWithoutReview(server, 'wf-v1-completion-gate', 'st-api', 'head-1');

    const withoutFinalEvaluation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-v1-completion-gate/decisions',
      payload: {
        decision: buildDecision('wf-v1-completion-gate', {
          id: 'dec-complete-without-final-evaluation',
          action: 'complete_workflow',
          reason: 'Should need v1 final evaluation evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutFinalEvaluation.statusCode).toBe(409);
    expect(withoutFinalEvaluation.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_evaluation_result',
    });
  });

  it('allows DAG-ready pending subtasks to start only after dependencies are done', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-dag-ready',
        goal: 'Advance DAG subtasks',
        rootTaskId: 'root-dag-ready',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/task-graph',
      payload: {
        graph: buildTaskGraph('wf-dag-ready', 1, [
          { id: 'st-api', dependsOn: [] },
          { id: 'st-ui', dependsOn: ['st-api'] },
        ]),
      },
    });
    const beforeDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-draft-ui-too-early',
          action: 'draft_contract',
          subtaskId: 'st-ui',
          reason: 'Dependent subtask should not draft before st-api is done.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(beforeDependency.statusCode).toBe(200);
    expect(beforeDependency.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });

    await moveSubtaskToDone(server, 'wf-dag-ready', 'st-api', 'head-1');
    const draftAfterDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-draft-ui-after-api',
          action: 'draft_contract',
          subtaskId: 'st-ui',
          reason: 'Dependency is done, so the pending subtask can draft a contract.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(draftAfterDependency.statusCode).toBe(200);
    expect(draftAfterDependency.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });

    await acceptContractForSubtask(server, 'wf-dag-ready', 'st-ui', 'head-1');
    const afterDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-execute-ui-after-contract',
          action: 'execute_subtask',
          subtaskId: 'st-ui',
          reason: 'Dependency and contract are ready, so the subtask can start.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(afterDependency.statusCode).toBe(200);
    expect(afterDependency.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });



  it('rejects removed legacy review actions and enforces v1 evaluator evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-action-guard',
        goal: 'Guard v1 action-specific transitions',
        rootTaskId: 'root-action-guard',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/task-graph',
      payload: {
        graph: buildTaskGraph('wf-action-guard', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await acceptContractForSubtask(server, 'wf-action-guard', 'st-api', 'head-1');

    const legacyReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-legacy-review',
          action: 'request_claude_review',
          subtaskId: 'st-api',
          reason: 'Legacy review action should not be accepted in v1.1.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(legacyReview.statusCode).toBe(409);
    expect(legacyReview.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });
    expect(legacyReview.json().guard.message).toMatch(/Unsupported workflow decision action/);

    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: { status: 'executing' },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'implemented',
        implementationHeadSha: 'head-1',
      },
    });

    const evaluatorWithoutImplementationEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions/preflight',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-evaluate-without-impl-evidence',
          action: 'run_codex_evaluator',
          subtaskId: 'st-api',
          reason: 'Evaluator needs implementation evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(evaluatorWithoutImplementationEvidence.statusCode).toBe(200);
    expect(evaluatorWithoutImplementationEvidence.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_implementation_evidence',
    });
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
        role: 'questioner',
        runner: 'claude-code',
        promptContract: 'questioner.v1',
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
  return (await createTestServerWithWorkbench(root)).server;
}

async function createTestServerWithWorkbench(root: string) {
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
  const server = await createServer(
    mockKernel as any,
    { port: 0, host: '127.0.0.1' },
    { workspaceRoot: root },
  );
  return { server, workbench };
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

function buildDecision(
  workflowId: string,
  patch: {
    id: string;
    action: string;
    reason: string;
    subtaskId?: string;
    evidenceRefs?: string[];
    inputs?: Record<string, unknown>;
  },
) {
  return {
    workflowId,
    rootTaskId: `root-${workflowId}`,
    decidedBy: 'codex-workflow',
    decidedAt: '2026-07-01T00:00:00.000Z',
    evidenceRefs: [],
    ...patch,
  };
}

function buildSprintContractPayload(patch: {
  id?: string;
  version?: number;
  goal?: string;
} = {}) {
  return {
    id: patch.id,
    version: patch.version,
    status: 'draft',
    goal: patch.goal || 'Implement st-api',
    scope: {
      allowedPaths: ['packages/kernel/src'],
      blockedPaths: [],
    },
    deliverables: [{
      id: 'deliver-st-api',
      description: patch.goal || 'Implement st-api',
      expectedFiles: ['packages/kernel/src/multi-agent/workflow-store.ts'],
    }],
    acceptanceCriteria: [{
      id: 'ac-1',
      statement: 'Contract behavior is auditable.',
      priority: 'must',
      verificationMethod: 'test',
    }],
    verificationPlan: {
      commands: [{
        id: 'cmd-1',
        command: 'pnpm --filter @tik/kernel test',
        required: true,
      }],
    },
  };
}

async function moveSubtaskToDone(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
) {
  await acceptContractForSubtask(server, workflowId, subtaskId, headSha);
  await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/evidence`,
    payload: {
      id: `ev-${subtaskId}-validation`,
      kind: 'validation',
      title: `${subtaskId} validation`,
      subtaskId,
      passed: true,
      headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'executing',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'implemented',
      implementationHeadSha: headSha,
      evidenceRefs: [`ev-${subtaskId}-validation`],
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'validated',
      validationRunIds: [`ev-${subtaskId}-validation`],
      lastValidatedHeadSha: headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'questioning_evidence',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'done',
    },
  });
}

async function acceptContractForSubtask(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
) {
  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}/contracts`,
    payload: buildSprintContractPayload({
      id: `contract-${subtaskId}-v1`,
      goal: `Implement ${subtaskId}`,
    }),
  });
  expect(created.statusCode).toBe(200);
  const accepted = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}/contracts/contract-${subtaskId}-v1/accept`,
    payload: {
      acceptedBy: 'codex-workflow-plugin',
      headShaAtAcceptance: headSha,
    },
  });
  expect(accepted.statusCode).toBe(200);
  const ready = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'ready',
    },
  });
  expect(ready.statusCode).toBe(200);
  const drafting = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'contract_drafting',
    },
  });
  expect(drafting.statusCode).toBe(200);
  const patched = await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'contract_accepted',
    },
  });
  expect(patched.statusCode).toBe(200);
}

async function moveSubtaskToDoneWithoutReview(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  headSha: string,
) {
  await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/evidence`,
    payload: {
      id: `ev-${subtaskId}-validation`,
      kind: 'validation',
      title: `${subtaskId} validation`,
      subtaskId,
      passed: true,
      headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'executing',
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'implemented',
      implementationHeadSha: headSha,
      evidenceRefs: [`ev-${subtaskId}-validation`],
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'validated',
      validationRunIds: [`ev-${subtaskId}-validation`],
      lastValidatedHeadSha: headSha,
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'done',
    },
  });
}
