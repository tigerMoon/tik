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

describe('multi-agent v1 core runtime API', () => {
  it('stores loop contracts on workflow policy through PATCH without replacing existing policy', async () => {
    const { root, server } = await createRuntimeServer();

    await createWorkflow(server, {
      id: 'wf-loop-contract',
      goal: 'Use a policy-owned loop contract',
      headSha: 'head-1',
      policy: {
        requireAcceptedContract: true,
      },
    });

    const loopContract = buildLoopContract('wf-loop-contract', {
      maxRounds: 4,
      allowedPaths: ['packages/kernel/src'],
    });
    const patched = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-loop-contract',
      payload: {
        policy: {
          loopContract,
          stalledInvocationTimeoutMs: 60000,
        },
      },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().workflow.policy).toMatchObject({
      requireAcceptedContract: true,
      loopContract,
      stalledInvocationTimeoutMs: 60000,
    });

    const stored = JSON.parse(
      await fs.readFile(path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-loop-contract', 'workflow.json'), 'utf-8'),
    );
    expect(stored.policy.loopContract.budget.maxRounds).toBe(4);
  });

  it('rejects stale decision commits with If-Match and returns the latest workflow state', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-if-match',
      goal: 'Protect decision commits',
      headSha: 'head-1',
    });
    await putTaskGraph(server, 'wf-if-match', ['st-api']);

    const firstDecision = buildDecision('wf-if-match', {
      id: 'dec-first',
      action: 'draft_contract',
      subtaskId: 'st-api',
      reason: 'First session drafts the contract.',
      inputs: { currentHeadSha: 'head-1' },
    });
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match/decisions',
      payload: { decision: firstDecision },
    });
    expect(first.statusCode).toBe(200);

    const staleDecision = buildDecision('wf-if-match', {
      id: 'dec-stale',
      action: 'draft_contract',
      subtaskId: 'st-api',
      reason: 'Second stale session tries to draft the contract.',
      inputs: { currentHeadSha: 'head-1' },
    });
    const stale = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match/decisions',
      headers: {
        'if-match': 'missing-previous-decision',
      },
      payload: { decision: staleDecision },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'invalid_transition',
      },
      workflow: {
        id: 'wf-if-match',
        lastDecisionId: 'dec-first',
      },
    });

    const read = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-if-match',
    });
    expect(read.json().decisions.map((decision: { id: string }) => decision.id)).toEqual(['dec-first']);
  });

  it('treats If-Match wildcard as matching any existing decision state', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-if-match-wildcard',
      goal: 'Keep If-Match wildcard RFC-compatible',
      headSha: 'head-1',
    });
    await putTaskGraph(server, 'wf-if-match-wildcard', ['st-api']);

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match-wildcard/decisions',
      payload: {
        decision: buildDecision('wf-if-match-wildcard', {
          id: 'dec-first',
          action: 'draft_contract',
          subtaskId: 'st-api',
          reason: 'First commit.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(first.statusCode).toBe(200);

    const wildcard = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match-wildcard/decisions',
      headers: {
        'if-match': '*',
      },
      payload: {
        decision: buildDecision('wf-if-match-wildcard', {
          id: 'dec-second',
          action: 'draft_contract',
          subtaskId: 'st-api',
          reason: 'Wildcard accepts any current decision state.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.json().workflow.lastDecisionId).toBe('dec-second');
  });

  it('preflights stale decision commits with a guard body while keeping HTTP 200', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-if-match-preflight',
      goal: 'Probe stale decision commits',
      headSha: 'head-1',
    });
    await putTaskGraph(server, 'wf-if-match-preflight', ['st-api']);

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match-preflight/decisions',
      payload: {
        decision: buildDecision('wf-if-match-preflight', {
          id: 'dec-first',
          action: 'draft_contract',
          subtaskId: 'st-api',
          reason: 'First commit.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(first.statusCode).toBe(200);

    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-if-match-preflight/decisions/preflight',
      headers: {
        'if-match': 'older-decision',
      },
      payload: {
        decision: buildDecision('wf-if-match-preflight', {
          id: 'dec-stale',
          action: 'draft_contract',
          subtaskId: 'st-api',
          reason: 'Probe stale commit.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'invalid_transition',
      },
      workflow: {
        id: 'wf-if-match-preflight',
        lastDecisionId: 'dec-first',
      },
    });
  });

  it('persists context snapshots with rendered markdown, etags, and local mirrors', async () => {
    const { root, server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-snapshot',
      goal: 'Keep prompt context compact',
      headSha: 'head-1',
    });

    const snapshot = buildSnapshot('wf-snapshot', {
      objectiveSummary: 'Keep the workflow brain prompt small.',
      artifactRefs: ['ev-implementation', 'er-evaluation'],
    });
    const saved = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-snapshot/context-snapshots',
      payload: { snapshot },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().snapshot).toMatchObject({
      workflowId: 'wf-snapshot',
      target: 'main',
      objectiveSummary: 'Keep the workflow brain prompt small.',
      renderedMarkdown: expect.stringContaining('Keep the workflow brain prompt small.'),
      etag: expect.any(String),
    });

    const stale = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-snapshot/context-snapshots',
      headers: {
        'if-match': 'stale-etag',
      },
      payload: {
        snapshot: {
          ...snapshot,
          nextActionHint: 'This write is stale.',
        },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'invalid_transition',
      },
      snapshot: {
        etag: saved.json().snapshot.etag,
      },
    });

    const loaded = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-snapshot/context-snapshots/main',
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().snapshot.artifactRefs).toEqual(['ev-implementation', 'er-evaluation']);

    const mirror = await fs.readFile(
      path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-snapshot', 'context', 'main.snapshot.md'),
      'utf-8',
    );
    expect(mirror).toContain('Keep the workflow brain prompt small.');
    expect(mirror).toContain('ev-implementation');
  });

  it('applies target snapshot defaults, truncates rendered markdown, and de-duplicates unchanged snapshot events', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-snapshot-limits',
      goal: 'Keep target snapshots compact',
      headSha: 'head-1',
      policy: {
        snapshotMaxChars: {
          builder: 120,
        },
      },
    });

    const builderSnapshot = buildSnapshot('wf-snapshot-limits', {
      target: 'builder',
      objectiveSummary: 'x'.repeat(600),
      artifactRefs: ['artifact-large'],
    });
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-snapshot-limits/context-snapshots',
      payload: { snapshot: builderSnapshot },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().snapshot.maxChars).toBe(120);
    expect(first.json().snapshot.renderedMarkdown.length).toBeLessThanOrEqual(120);
    expect(first.json().snapshot.renderedMarkdown).toContain('truncated');

    const unchanged = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-snapshot-limits/context-snapshots',
      headers: {
        'if-match': first.json().snapshot.etag,
      },
      payload: {
        snapshot: {
          ...builderSnapshot,
          nextActionHint: 'Only a hint changed.',
        },
      },
    });
    expect(unchanged.statusCode).toBe(200);

    const evaluator = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-snapshot-limits/context-snapshots',
      payload: {
        snapshot: buildSnapshot('wf-snapshot-limits', {
          target: 'evaluator',
          objectiveSummary: 'Evaluator sees more context.',
        }),
      },
    });
    expect(evaluator.statusCode).toBe(200);
    expect(evaluator.json().snapshot.maxChars).toBe(8000);

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-snapshot-limits/timeline',
    });
    const snapshotEvents = timeline.json().events
      .filter((event: { type: string }) => event.type === 'context_snapshot.recorded');
    expect(snapshotEvents.map((event: { payload: { target: string } }) => event.payload.target)).toEqual(['builder', 'evaluator']);
  });

  it('marks stalled Codex invocations failed and blocks the workflow with audit timeline evidence', async () => {
    const { root, server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-stalled',
      goal: 'Detect hung subagents',
      headSha: 'head-1',
      policy: {
        stalledInvocationTimeoutMs: 1,
      },
    });
    await putTaskGraph(server, 'wf-stalled', ['st-api']);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stalled/agent-invocations',
      payload: {
        id: 'inv-builder',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
      },
    });
    expect(created.statusCode).toBe(200);

    const token = created.json().invocation.attestationToken;
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stalled/agent-invocations/inv-builder/hook-start',
      payload: {
        attestationToken: token,
        nonce: 'nonce-builder',
        parentThreadId: 'parent-thread',
        actualSubagentThreadId: 'builder-thread',
        role: 'executor',
        nonce: 'nonce-builder',
      },
    });
    expect(started.statusCode).toBe(200);
    await writeInvocationJsonl(root, 'wf-stalled', {
      ...started.json().invocation,
      startedAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const reconciled = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stalled/invocations/reconcile-stalled',
      payload: {
        now: '2026-07-01T00:01:00.000Z',
      },
    });

    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({
      stalled: [
        {
          id: 'inv-builder',
          status: 'failed',
          error: 'stalled',
        },
      ],
      workflow: {
        id: 'wf-stalled',
        status: 'blocked',
        pauseReason: 'awaiting_subagent',
      },
      subtasks: {
        'st-api': {
          status: 'needs_fix',
        },
      },
    });

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-stalled/timeline',
    });
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toContain('invocation.stalled');
  });

  it('records human overrides with guard rejection audit context and can resume blocked workflows', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-human-override',
      goal: 'Require auditable human unblock',
      headSha: 'head-1',
      policy: {
        allowHumanOverride: true,
      },
      metadata: {
        lastGuardRejection: {
          code: 'evaluation_evidence_insufficient',
          message: 'Evaluation had coverage gaps.',
        },
      },
    });
    const patchBlocked = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-human-override',
      payload: {
        status: 'blocked',
        metadata: {
          lastGuardRejection: {
            code: 'evaluation_evidence_insufficient',
            message: 'Evaluation had coverage gaps.',
          },
        },
      },
    });
    expect(patchBlocked.statusCode).toBe(409);

    const activeOverride = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-human-override/human-overrides',
      payload: {
        reason: 'Human reviewed the missing edge case evidence out-of-band.',
        approver: 'lead-engineer',
        unblockAction: 'resume',
        note: 'Resume workflow; do not force completion.',
      },
    });
    expect(activeOverride.statusCode).toBe(409);

    await putTaskGraph(server, 'wf-human-override', ['st-api']);
    await blockWorkflowWithStalledInvocation(server, 'wf-human-override', 'st-api');

    const override = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-human-override/human-overrides',
      payload: {
        reason: 'Human reviewed the missing edge case evidence out-of-band.',
        approver: 'lead-engineer',
        unblockAction: 'resume',
        note: 'Resume workflow; do not force completion.',
      },
    });

    expect(override.statusCode).toBe(200);
    expect(override.json()).toMatchObject({
      override: {
        approver: 'lead-engineer',
        unblockAction: 'resume',
        guardRejection: {
          code: 'evaluation_evidence_insufficient',
        },
      },
      workflow: {
        id: 'wf-human-override',
        status: 'active',
      },
    });

    const timeline = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-human-override/timeline',
    });
    expect(timeline.json().events.map((event: { type: string }) => event.type)).toContain('workflow.human_override');
  });

  it('rejects human overrides when guard rejection audit context is missing', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-human-override-missing-guard',
      goal: 'Reject unauditable human unblock',
      headSha: 'head-1',
      policy: {
        allowHumanOverride: true,
        stalledInvocationTimeoutMs: 1,
      },
    });
    await putTaskGraph(server, 'wf-human-override-missing-guard', ['st-api']);
    await blockWorkflowWithStalledInvocation(server, 'wf-human-override-missing-guard', 'st-api');

    const override = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-human-override-missing-guard/human-overrides',
      payload: {
        reason: 'Resume without audit context.',
        approver: 'lead-engineer',
        unblockAction: 'resume',
      },
    });

    expect(override.statusCode).toBe(409);
    expect(override.json()).toMatchObject({
      error: {
        code: 'invalid_transition',
      },
    });
  });

  it('force-completes a subtask through a human override when a blocked workflow names the subtask', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-human-force-subtask',
      goal: 'Force complete a blocked subtask with audit context',
      headSha: 'head-1',
      policy: {
        allowHumanOverride: true,
      },
      metadata: {
        lastGuardRejection: {
          code: 'blocking_question_unresolved',
          message: 'Claude questioner had a blocking question.',
        },
      },
    });
    await putTaskGraph(server, 'wf-human-force-subtask', ['st-api']);
    await blockWorkflowWithStalledInvocation(server, 'wf-human-force-subtask', 'st-api');

    const override = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-human-force-subtask/human-overrides',
      payload: {
        reason: 'Human accepted the remaining subtask risk explicitly.',
        approver: 'lead-engineer',
        unblockAction: 'force_complete_subtask',
        subtaskId: 'st-api',
      },
    });

    expect(override.statusCode).toBe(200);
    expect(override.json()).toMatchObject({
      override: {
        unblockAction: 'force_complete_subtask',
        subtaskId: 'st-api',
        guardRejection: {
          code: 'blocking_question_unresolved',
        },
      },
      workflow: {
        status: 'active',
      },
    });

    const state = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-human-force-subtask',
    });
    expect(state.json().subtasks['st-api']).toMatchObject({
      status: 'done',
    });
    expect(state.json().subtasks['st-api'].blockerFindingIds).toEqual([]);
  });

  it('uses Tik-owned invocation start time for stall detection instead of hook supplied attestation time', async () => {
    const { server } = await createRuntimeServer();
    await createWorkflow(server, {
      id: 'wf-stall-clock',
      goal: 'Do not trust hook clock for stall age',
      headSha: 'head-1',
      policy: {
        stalledInvocationTimeoutMs: 1,
      },
    });
    await putTaskGraph(server, 'wf-stall-clock', ['st-api']);

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stall-clock/agent-invocations',
      payload: {
        id: 'inv-builder',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
      },
    });
    expect(created.statusCode).toBe(200);

    const token = created.json().invocation.attestationToken;
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stall-clock/agent-invocations/inv-builder/hook-start',
      payload: {
        attestationToken: token,
        nonce: 'nonce-builder',
        parentThreadId: 'parent-thread',
        actualSubagentThreadId: 'builder-thread',
        role: 'executor',
        nonce: 'nonce-builder',
        startedAt: '2026-07-01T00:00:00.000Z',
      },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().invocation.attestationStartedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(started.json().invocation.startedAt).not.toBe('2026-07-01T00:00:00.000Z');

    const reconciled = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-stall-clock/invocations/reconcile-stalled',
      payload: {
        now: new Date(Date.parse(started.json().invocation.startedAt) + 1).toISOString(),
      },
    });

    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json().stalled).toEqual([]);
    expect(reconciled.json().workflow.status).toBe('active');
  });
});

async function createRuntimeServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-v1-'));
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
  servers.push(server);
  return { root, server };
}

async function createWorkflow(
  server: { inject: (input: any) => Promise<any> },
  payload: Record<string, unknown>,
) {
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/multi-agent/workflows',
    payload,
  });
  expect(created.statusCode).toBe(200);
  return created.json().workflow;
}

async function putTaskGraph(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtasks: string[],
) {
  const response = await server.inject({
    method: 'PUT',
    url: `/api/v1/multi-agent/workflows/${workflowId}/task-graph`,
    payload: {
      graph: {
        workflowId,
        version: 1,
        createdBy: 'codex-workflow',
        risks: [],
        globalAcceptanceCriteria: [],
        finalValidationCommands: [],
        subtasks: subtasks.map((subtaskId) => ({
          id: subtaskId,
          title: subtaskId,
          goal: `Implement ${subtaskId}`,
          dependsOn: [],
          allowedPaths: ['packages/kernel/src'],
          blockedPaths: ['secrets'],
          acceptanceCriteria: ['Works as specified.'],
          validationCommands: ['pnpm --filter @tik/kernel test'],
          reviewFocus: ['correctness'],
          assignedExecutor: 'codex',
          assignedReviewer: 'claude-code',
        })),
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

async function blockWorkflowWithStalledInvocation(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
) {
  const created = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations`,
    payload: {
      id: 'inv-stalled',
      subtaskId,
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
    },
  });
  expect(created.statusCode).toBe(200);

  const started = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/inv-stalled/hook-start`,
    payload: {
      attestationToken: created.json().invocation.attestationToken,
      nonce: 'nonce-stalled',
      parentThreadId: 'parent-thread',
      actualSubagentThreadId: 'builder-thread',
      role: 'executor',
      nonce: 'nonce-builder',
    },
  });
  expect(started.statusCode).toBe(200);

  const startedAt = Date.parse(started.json().invocation.startedAt);
  const reconciled = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/invocations/reconcile-stalled`,
    payload: {
      now: new Date(startedAt + 31 * 60_000).toISOString(),
    },
  });
  expect(reconciled.statusCode).toBe(200);
  expect(reconciled.json().workflow.status).toBe('blocked');
}

async function writeInvocationJsonl(root: string, workflowId: string, invocation: Record<string, unknown>) {
  await fs.writeFile(
    path.join(root, '.tik', 'multi-agent', 'workflows', workflowId, 'invocations.jsonl'),
    `${JSON.stringify(invocation)}\n`,
    'utf-8',
  );
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

function buildLoopContract(
  workflowId: string,
  input: {
    maxRounds: number;
    allowedPaths: string[];
  },
) {
  return {
    id: `${workflowId}-loop-contract`,
    workflowId,
    scope: {
      allowedPaths: input.allowedPaths,
      blockedPaths: ['secrets'],
    },
    budget: {
      maxRounds: input.maxRounds,
      maxRuntimeMs: 300000,
      maxConsecutiveFailures: 2,
      maxSubagentRuns: 4,
      maxEvaluatorRuns: 3,
    },
    stop: [
      'guard_rejected',
      'same_failure_repeated',
      'head_sha_changed',
      'human_required',
      'budget_exceeded',
      'evaluation_inconclusive',
    ],
    refresh: [
      'read_latest_head_sha',
      'read_observed_git_diff',
      'reload_task_graph',
      'reload_contract',
      'reload_latest_evidence',
    ],
    report: {
      destination: 'tik_timeline',
      fields: ['guard', 'evidence', 'headSha'],
    },
  };
}

function buildSnapshot(
  workflowId: string,
  patch: {
    target?: 'main' | 'builder' | 'evaluator' | 'questioner';
    objectiveSummary: string;
    artifactRefs?: string[];
  },
) {
  return {
    workflowId,
    headSha: 'head-1',
    target: patch.target || 'main',
    objectiveSummary: patch.objectiveSummary,
    completedSubtasks: [],
    currentContractSummary: 'No active contract yet.',
    latestImplementationSummary: 'No implementation evidence yet.',
    latestEvaluationSummary: 'No evaluation yet.',
    latestQuestionerSummary: 'No questioner output yet.',
    unresolvedBlockers: [],
    nextActionHint: 'Draft the first contract.',
    artifactRefs: patch.artifactRefs || [],
    maxChars: undefined,
  };
}
