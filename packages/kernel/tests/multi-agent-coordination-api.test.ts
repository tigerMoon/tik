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
    const reviewEvidence = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-auth/evidence',
      payload: {
        id: 'ev-review',
        kind: 'review',
        title: 'Claude review approved',
        subtaskId: 'st-api',
        passed: true,
        headSha: 'abc123',
        payload: {
          result: {
            verdict: 'approve',
            headShaReviewed: 'abc123',
            currentHeadSha: 'abc123',
            blockingIssues: [],
          },
        },
      },
    });
    expect(reviewEvidence.statusCode).toBe(200);

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
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'reviewing',
        reviewRoundIds: ['rr-1'],
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'review_approved',
        evidenceRefs: ['ev-review'],
        lastReviewedHeadSha: 'abc123',
      },
    });

    const decision = {
      id: 'dec-complete-api',
      workflowId: 'wf-auth',
      rootTaskId: 'root-auth',
      subtaskId: 'st-api',
      decidedBy: 'codex-workflow',
      decidedAt: '2026-06-30T00:00:00.000Z',
      action: 'complete_subtask',
      reason: 'Validation passed and Claude approved.',
      evidenceRefs: ['ev-validation', 'ev-review'],
      inputs: {
        currentHeadSha: 'abc123',
      },
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

    const updateSubtask = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-auth/subtasks/st-api',
      payload: {
        status: 'done',
        evidenceRefs: ['ev-validation', 'ev-review'],
        lastValidatedHeadSha: 'abc123',
        lastReviewedHeadSha: 'abc123',
      },
    });
    expect(updateSubtask.statusCode).toBe(200);
    expect(updateSubtask.json().subtask).toMatchObject({
      subtaskId: 'st-api',
      status: 'done',
      evidenceRefs: ['ev-validation', 'ev-review'],
      lastValidatedHeadSha: 'abc123',
      lastReviewedHeadSha: 'abc123',
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
    expect(readWorkflow.json().evidence).toHaveLength(2);

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-auth/timeline',
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toEqual([
      'workflow.created',
      'task_graph.created',
      'evidence.recorded',
      'evidence.recorded',
      'subtask.updated',
      'subtask.updated',
      'subtask.updated',
      'subtask.updated',
      'subtask.updated',
      'decision.recorded',
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

  it('requires final review approval before completing a workflow', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-final-review',
        goal: 'Final review gate',
        rootTaskId: 'root-final-review',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-final-review/task-graph',
      payload: {
        graph: buildTaskGraph('wf-final-review', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await moveSubtaskToDone(server, 'wf-final-review', 'st-api', 'head-1');

    const withoutFinalReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-review/decisions',
      payload: {
        decision: buildDecision('wf-final-review', {
          id: 'dec-complete-without-final-review',
          action: 'complete_workflow',
          reason: 'Should need final review.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutFinalReview.statusCode).toBe(409);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-review/evidence',
      payload: {
        id: 'ev-final-review',
        kind: 'review',
        title: 'Final review approved',
        passed: true,
        headSha: 'head-1',
        payload: {
          result: {
            verdict: 'approve',
            workflowId: 'wf-final-review',
            headShaReviewed: 'head-1',
            blockingIssues: [],
          },
        },
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-review/decisions',
      payload: {
        decision: buildDecision('wf-final-review', {
          id: 'dec-complete-with-final-review',
          action: 'complete_workflow',
          reason: 'Final review approved.',
          evidenceRefs: ['ev-final-review'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().workflow.status).toBe('completed');
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
          id: 'dec-execute-ui-too-early',
          action: 'execute_subtask',
          subtaskId: 'st-ui',
          reason: 'Dependent subtask should not start before st-api is done.',
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
    const afterDependency = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-dag-ready/decisions/preflight',
      payload: {
        decision: buildDecision('wf-dag-ready', {
          id: 'dec-execute-ui-after-api',
          action: 'execute_subtask',
          subtaskId: 'st-ui',
          reason: 'Dependency is done, so the pending subtask is DAG-ready.',
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

  it('allows re-review only after a fix is validated on the current head', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-fix-rereview',
        goal: 'Fix then re-review',
        rootTaskId: 'root-fix-rereview',
        headSha: 'head-1',
        maxRounds: 3,
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/task-graph',
      payload: {
        graph: buildTaskGraph('wf-fix-rereview', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: { status: 'executing' },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: { status: 'implemented', implementationHeadSha: 'head-1' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/evidence',
      payload: {
        id: 'ev-validation-before-fix',
        kind: 'validation',
        title: 'Validation before fix',
        subtaskId: 'st-api',
        passed: true,
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: {
        status: 'validated',
        validationRunIds: ['ev-validation-before-fix'],
        evidenceRefs: ['ev-validation-before-fix'],
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: {
        status: 'reviewing',
        reviewRoundIds: ['review-1'],
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/evidence',
      payload: {
        id: 'ev-review-blocking',
        kind: 'review',
        title: 'Claude review blocked',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          result: {
            verdict: 'request_changes',
            headShaReviewed: 'head-1',
            blockingIssues: [{ title: 'Missing test' }],
          },
        },
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: {
        status: 'needs_fix',
        evidenceRefs: ['ev-review-blocking'],
        blockerFindingIds: ['review-1:blocking:1'],
        fixRound: 1,
      },
    });

    const fixDecision = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/decisions/preflight',
      payload: {
        decision: buildDecision('wf-fix-rereview', {
          id: 'dec-fix-blocker',
          action: 'fix_claude_blockers',
          subtaskId: 'st-api',
          reason: 'Blocking review findings need a fix.',
          evidenceRefs: ['ev-validation-before-fix', 'ev-review-blocking'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(fixDecision.statusCode).toBe(200);

    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: { status: 'fixing' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/evidence',
      payload: {
        id: 'ev-fix',
        kind: 'fix',
        title: 'Fix blockers',
        subtaskId: 'st-api',
        headSha: 'head-2',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: {
        status: 'implemented',
        implementationHeadSha: 'head-2',
        evidenceRefs: ['ev-fix'],
      },
    });

    const reReviewBeforeValidation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/decisions/preflight',
      payload: {
        decision: buildDecision('wf-fix-rereview', {
          id: 'dec-rereview-before-validation',
          action: 'request_re_review',
          subtaskId: 'st-api',
          reason: 'Re-review should wait for validation after fix.',
          evidenceRefs: ['ev-fix'],
          inputs: { currentHeadSha: 'head-2', round: 2, fixRecorded: true },
        }),
      },
    });
    expect(reReviewBeforeValidation.statusCode).toBe(200);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/evidence',
      payload: {
        id: 'ev-validation-after-fix',
        kind: 'validation',
        title: 'Validation after fix',
        subtaskId: 'st-api',
        passed: true,
        headSha: 'head-2',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/subtasks/st-api',
      payload: {
        status: 'validated',
        validationRunIds: ['ev-validation-after-fix'],
        evidenceRefs: ['ev-validation-after-fix'],
      },
    });

    const reReviewAfterValidation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-fix-rereview/decisions/preflight',
      payload: {
        decision: buildDecision('wf-fix-rereview', {
          id: 'dec-rereview-after-validation',
          action: 'request_re_review',
          subtaskId: 'st-api',
          reason: 'Fix was validated on the current head, so re-review is legal.',
          evidenceRefs: ['ev-fix', 'ev-validation-after-fix'],
          inputs: { currentHeadSha: 'head-2', round: 2, fixRecorded: true },
        }),
      },
    });
    expect(reReviewAfterValidation.statusCode).toBe(200);
    expect(reReviewAfterValidation.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('accepts review decisions that reference their planned review evidence id', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-planned-review-evidence',
        goal: 'Process review with an auditable evidence chain',
        rootTaskId: 'root-planned-review-evidence',
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PUT',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/task-graph',
      payload: {
        graph: buildTaskGraph('wf-planned-review-evidence', 1, [
          { id: 'st-api', dependsOn: [] },
        ]),
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/subtasks/st-api',
      payload: { status: 'executing' },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/subtasks/st-api',
      payload: { status: 'implemented', implementationHeadSha: 'head-1' },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/evidence',
      payload: {
        id: 'ev-validation',
        kind: 'validation',
        title: 'Validation before review',
        subtaskId: 'st-api',
        passed: true,
        headSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/subtasks/st-api',
      payload: {
        status: 'reviewing',
        validationRunIds: ['ev-validation'],
        evidenceRefs: ['ev-validation'],
        reviewRoundIds: ['task-review-1'],
      },
    });

    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-planned-review-evidence/decisions/preflight',
      payload: {
        decision: buildDecision('wf-planned-review-evidence', {
          id: 'dec-process-review',
          action: 'fix_claude_blockers',
          subtaskId: 'st-api',
          reason: 'Claude review found blocking issues.',
          evidenceRefs: ['ev-validation', 'ev_review_task-review-1'],
          inputs: {
            currentHeadSha: 'head-1',
            plannedReviewEvidenceId: 'ev_review_task-review-1',
            plannedReviewResult: {
              verdict: 'request_changes',
              headShaReviewed: 'head-1',
              blockingIssues: [{ title: 'Missing regression test' }],
            },
          },
        }),
      },
    });

    expect(preflight.statusCode).toBe(200);
    expect(preflight.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('rejects action decisions that skip validation or Claude review approval', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-api-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-action-guard',
        goal: 'Guard action-specific transitions',
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

    const prematureReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-review-before-validation',
          action: 'request_claude_review',
          subtaskId: 'st-api',
          reason: 'Review before validation should be rejected.',
          inputs: { currentHeadSha: 'head-1', round: 1 },
        }),
      },
    });
    expect(prematureReview.statusCode).toBe(409);
    expect(prematureReview.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });

    const validation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/evidence',
      payload: {
        id: 'ev-validation',
        kind: 'validation',
        title: 'Validation passed',
        subtaskId: 'st-api',
        command: 'pnpm test',
        passed: true,
        headSha: 'head-1',
      },
    });
    expect(validation.statusCode).toBe(200);
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'executing',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'implemented',
        evidenceRefs: ['ev-validation'],
        implementationHeadSha: 'head-1',
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'validated',
        validationRunIds: ['ev-validation'],
        lastValidatedHeadSha: 'head-1',
      },
    });

    const requestReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-request-review',
          action: 'request_claude_review',
          subtaskId: 'st-api',
          reason: 'Validated subtask is ready for Claude review.',
          evidenceRefs: ['ev-validation'],
          inputs: { currentHeadSha: 'head-1', round: 1 },
        }),
      },
    });
    expect(requestReview.statusCode).toBe(200);

    const completeWithoutReview = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-complete-without-review',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Completion without review should be rejected.',
          evidenceRefs: ['ev-validation'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(completeWithoutReview.statusCode).toBe(409);
    expect(completeWithoutReview.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });

    const review = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/evidence',
      payload: {
        id: 'ev-review',
        kind: 'review',
        title: 'Claude review approve',
        subtaskId: 'st-api',
        passed: true,
        headSha: 'head-1',
        payload: {
          result: {
            verdict: 'approve',
            headShaReviewed: 'head-1',
            currentHeadSha: 'head-1',
            blockingIssues: [],
          },
        },
      },
    });
    expect(review.statusCode).toBe(200);
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'reviewing',
        reviewRoundIds: ['review-task-1'],
      },
    });
    await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/subtasks/st-api',
      payload: {
        status: 'review_approved',
        evidenceRefs: ['ev-review'],
        lastReviewedHeadSha: 'head-1',
        blockerFindingIds: [],
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guard/decisions',
      payload: {
        decision: buildDecision('wf-action-guard', {
          id: 'dec-complete-after-review',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Validation and Claude review approved the same head.',
          evidenceRefs: ['ev-validation', 'ev-review'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
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

async function moveSubtaskToDone(
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
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/evidence`,
    payload: {
      id: `ev-${subtaskId}-review`,
      kind: 'review',
      title: `${subtaskId} review`,
      subtaskId,
      passed: true,
      headSha,
      payload: {
        result: {
          verdict: 'approve',
          headShaReviewed: headSha,
          currentHeadSha: headSha,
          blockingIssues: [],
        },
      },
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
      status: 'reviewing',
      reviewRoundIds: [`rr-${subtaskId}`],
    },
  });
  await server.inject({
    method: 'PATCH',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
    payload: {
      status: 'review_approved',
      evidenceRefs: [`ev-${subtaskId}-review`],
      lastReviewedHeadSha: headSha,
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
