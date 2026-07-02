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

describe('codex evaluator and Claude questioner workflow', () => {
  it('requires an accepted SprintContract before a v1 subtask can execute', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-contract-required', root);
    await putSingleSubtaskGraph(server, 'wf-contract-required');

    const withoutContract = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-required/decisions/preflight',
      payload: {
        decision: buildDecision('wf-contract-required', {
          id: 'dec-execute-before-contract',
          action: 'execute_subtask',
          subtaskId: 'st-api',
          reason: 'Execution should wait for an accepted contract.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(withoutContract.statusCode).toBe(200);
    expect(withoutContract.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_contract',
    });

    const contract = await createAcceptedContract(server, 'wf-contract-required');
    expect(contract.statusCode).toBe(200);

    const withContract = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-required/decisions/preflight',
      payload: {
        decision: buildDecision('wf-contract-required', {
          id: 'dec-execute-after-contract',
          action: 'execute_subtask',
          subtaskId: 'st-api',
          reason: 'Accepted contract makes execution legal.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(withContract.statusCode).toBe(200);
    expect(withContract.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('invalidates evaluator runs that write forbidden source paths', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-readonly', root);
    await putSingleSubtaskGraph(server, 'wf-readonly');
    await createAcceptedContract(server, 'wf-readonly');

    const evaluation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-readonly/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-readonly',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-session-1' },
      },
    });
    expect(evaluation.statusCode).toBe(200);

    const allowedOnly = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-readonly/subtasks/st-api/evaluations/eval-readonly/validate-readonly',
      payload: {
        gitStatusBefore: '',
        gitStatusAfter: '?? .tik/multi-agent/workflows/wf-readonly/evaluations/eval-readonly/stdout.log\n',
      },
    });
    expect(allowedOnly.statusCode).toBe(200);
    expect(allowedOnly.json().guard).toMatchObject({ accepted: true, code: 'ok' });

    const forbiddenWrite = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-readonly/subtasks/st-api/evaluations/eval-readonly/validate-readonly',
      payload: {
        gitStatusBefore: '',
        gitStatusAfter: [
          ' M packages/kernel/src/multi-agent/guard.ts',
          '?? .tik/multi-agent/workflows/wf-readonly/evaluations/eval-readonly/stdout.log',
        ].join('\n'),
      },
    });

    expect(forbiddenWrite.statusCode).toBe(409);
    expect(forbiddenWrite.json()).toMatchObject({
      guard: {
        accepted: false,
        code: 'readonly_policy_violated',
      },
      evaluationRun: {
        id: 'eval-readonly',
        status: 'invalidated',
      },
    });
    expect(forbiddenWrite.json().evaluationRun.readonlyPolicy.violations).toContain('packages/kernel/src/multi-agent/guard.ts');

    const recordedResult = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-readonly/subtasks/st-api/evaluations/eval-readonly/result',
      payload: {
        result: {
          workflowId: 'wf-readonly',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-readonly',
          headSha: 'head-1',
          verdict: 'fail',
          criteriaResults: [],
          commandResults: [
            {
              commandId: 'cmd-readonly',
              command: 'node -e "process.exit(0)"',
              status: 'passed',
              exitCode: 0,
              summary: 'Command passed but readonly policy failed.',
            },
          ],
          runtimeFindings: [
            {
              id: 'readonly_violation',
              severity: 'blocker',
              title: 'Readonly violation',
              observed: 'Evaluator wrote a forbidden source path.',
              expected: 'Evaluator writes only artifact paths.',
              reproductionSteps: ['Inspect readonlyPolicy.violations.'],
            },
          ],
          coverageGaps: [],
          confidence: 0.2,
        },
      },
    });
    expect(recordedResult.statusCode).toBe(200);
    expect(recordedResult.json().evaluationRun).toMatchObject({
      id: 'eval-readonly',
      status: 'invalidated',
      result: {
        verdict: 'fail',
      },
    });
  });

  it('completes a v1 subtask only after same-head implementation, evaluation pass, and non-blocking questioner output', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-complete-v1', root);
    await putSingleSubtaskGraph(server, 'wf-complete-v1');
    await createAcceptedContract(server, 'wf-complete-v1');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/evidence',
      payload: {
        id: 'ev-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/workflow-store.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-complete-v1', 'st-api');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-session-pass' },
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/subtasks/st-api/evaluations/eval-pass/result',
      payload: {
        result: {
          workflowId: 'wf-complete-v1',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-pass',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [
            { criterionId: 'ac-1', status: 'pass', evidence: 'Targeted test passed.' },
          ],
          commandResults: [
            {
              commandId: 'cmd-test',
              command: 'pnpm --filter @tik/kernel test',
              status: 'passed',
              exitCode: 0,
              summary: 'Kernel tests passed.',
            },
          ],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.88,
        },
      },
    });
    await createCompletedInvocation(server, 'wf-complete-v1', {
      id: 'inv-builder-complete-v1',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-complete-v1',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-complete-v1', {
      id: 'inv-evaluator-complete-v1',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-complete-v1',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const beforeQuestioner = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-complete-v1', {
          id: 'dec-complete-before-questioner',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Questioner must inspect evaluation evidence first.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(beforeQuestioner.statusCode).toBe(200);
    expect(beforeQuestioner.json().guard).toMatchObject({
      accepted: false,
      code: 'blocking_question_unresolved',
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/questioner-outputs',
      payload: {
        id: 'q-blocking',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-1' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-pass',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://claude-q-1',
        verdict: 'need_clarification',
        questions: [
          {
            id: 'q1',
            priority: 'blocking',
            question: 'Was the failure path evaluated?',
            whyItMatters: 'The contract includes an error path.',
            expectedAnswerType: 'test_case',
          },
        ],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    const blockingQuestion = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-complete-v1', {
          id: 'dec-complete-with-blocking-question',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Blocking questioner output must prevent completion.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(blockingQuestion.statusCode).toBe(200);
    expect(blockingQuestion.json().guard).toMatchObject({
      accepted: false,
      code: 'blocking_question_unresolved',
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/questioner-outputs',
      payload: {
        id: 'q-clear',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-2' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-pass',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://claude-q-2',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-complete-v1', {
          id: 'dec-complete-v1',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Contract accepted, implementation and evaluation match head, and questioner found no blockers.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('accepts implementation evidence inside contract glob allowed paths', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-glob-scope', root);
    await putSingleSubtaskGraph(server, 'wf-glob-scope');
    await createAcceptedContract(server, 'wf-glob-scope', {
      allowedPaths: [
        'packages/kernel/src/multi-agent/**',
        'packages/kernel/tests/**',
        'codex-skill/tik-multi-agent-workflow/**',
      ],
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-glob-scope/evidence',
      payload: {
        id: 'ev-glob-impl',
        kind: 'implementation',
        title: 'Codex implementation evidence with glob-scoped paths',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
            { path: 'packages/kernel/tests/multi-agent-codex-evaluator-questioner.test.ts', changeType: 'modified' },
            { path: 'codex-skill/tik-multi-agent-workflow/scripts/tik-multi-agent-workflow.mjs', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-glob-scope', 'st-api');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-glob-scope/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-glob-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-session-glob-pass' },
      },
    });
    await recordPassingEvaluation(server, 'wf-glob-scope', 'eval-glob-pass');
    await recordClearQuestioner(server, 'wf-glob-scope', 'q-glob-clear', {
      evaluationRunId: 'eval-glob-pass',
    });
    await createCompletedInvocation(server, 'wf-glob-scope', {
      id: 'inv-builder-glob',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-glob',
      headSha: 'head-1',
      evidenceRefs: ['ev-glob-impl'],
    });
    await createCompletedInvocation(server, 'wf-glob-scope', {
      id: 'inv-evaluator-glob',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-glob',
      headSha: 'head-1',
      evaluationRunId: 'eval-glob-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-glob-scope/decisions/preflight',
      payload: {
        decision: buildDecision('wf-glob-scope', {
          id: 'dec-complete-glob-scope',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Changed files are inside contract glob allowed paths.',
          evidenceRefs: ['ev-glob-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('requires separate builder and evaluator Codex subagent invocations before subtask completion', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-subagent-isolation', root);
    await putSingleSubtaskGraph(server, 'wf-subagent-isolation');
    await createAcceptedContract(server, 'wf-subagent-isolation');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/evidence',
      payload: {
        id: 'ev-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-subagent-isolation', 'st-api');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'same-thread' },
      },
    });
    await recordPassingEvaluation(server, 'wf-subagent-isolation', 'eval-pass');
    await recordClearQuestioner(server, 'wf-subagent-isolation', 'q-clear');

    const withoutInvocations = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-subagent-isolation', {
          id: 'dec-complete-without-subagents',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Builder and Evaluator subagent invocations must be recorded.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutInvocations.statusCode).toBe(200);
    expect(withoutInvocations.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_subagent_invocation',
    });

    const manualBuilder = await createInvocationRecord(server, 'wf-subagent-isolation', {
      id: 'inv-builder-manual-start',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    expect(manualBuilder.statusCode).toBe(200);
    const missingRuntimeThread = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/agent-invocations/inv-builder-manual-start/start',
      payload: {},
    });
    expect(missingRuntimeThread.statusCode).toBe(409);
    expect(missingRuntimeThread.json().error).toMatchObject({ code: 'missing_subagent_invocation' });

    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-builder',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'same-thread',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-evaluator-same-thread',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'same-thread',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const sameThread = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-subagent-isolation', {
          id: 'dec-complete-same-thread',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Builder and Evaluator must be different Codex subagent threads.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(sameThread.statusCode).toBe(200);
    expect(sameThread.json().guard).toMatchObject({
      accepted: false,
      code: 'subagent_thread_not_isolated',
    });

    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-evaluator-readonly',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-subagent-isolation', {
          id: 'dec-complete-isolated-subagents',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Builder and Evaluator ran as isolated Codex subagent threads.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('rejects v1 subtask completion when implementation evidence has no derived changed files', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-empty-changes', root);
    await putSingleSubtaskGraph(server, 'wf-empty-changes');
    await createAcceptedContract(server, 'wf-empty-changes');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-empty-changes/evidence',
      payload: {
        id: 'ev-empty-impl',
        kind: 'implementation',
        title: 'Implementation with omitted changed files',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {},
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-empty-changes', 'st-api', 'ev-empty-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-empty-changes/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-empty-changes',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-empty-changes' },
      },
    });
    await recordPassingEvaluation(server, 'wf-empty-changes', 'eval-empty-changes');
    await recordClearQuestioner(server, 'wf-empty-changes', 'q-empty-changes', {
      evaluationRunId: 'eval-empty-changes',
    });
    await createCompletedInvocation(server, 'wf-empty-changes', {
      id: 'inv-builder-empty-changes',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-empty-changes',
      headSha: 'head-1',
      evidenceRefs: ['ev-empty-impl'],
    });
    await createCompletedInvocation(server, 'wf-empty-changes', {
      id: 'inv-evaluator-empty-changes',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-empty-changes',
      headSha: 'head-1',
      evaluationRunId: 'eval-empty-changes',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-empty-changes/decisions/preflight',
      payload: {
        decision: buildDecision('wf-empty-changes', {
          id: 'dec-complete-empty-changes',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Implementation evidence with omitted changed files must not bypass scope guard.',
          evidenceRefs: ['ev-empty-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_implementation_evidence',
    });
  });

  it('rejects implementation scope using Tik observed changed files instead of declared files', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-observed-scope', root);
    await putSingleSubtaskGraph(server, 'wf-observed-scope');
    await createAcceptedContract(server, 'wf-observed-scope', {
      allowedPaths: ['packages/kernel/src/multi-agent/**'],
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-observed-scope/evidence',
      payload: {
        id: 'ev-observed-impl',
        kind: 'implementation',
        title: 'Implementation evidence with conflicting declared and observed files',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
          declaredChangedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
          observedChangedFiles: [
            { path: 'README.md', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-observed-scope', 'st-api', 'ev-observed-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-observed-scope/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-observed-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-observed-pass' },
      },
    });
    await recordPassingEvaluation(server, 'wf-observed-scope', 'eval-observed-pass');
    await recordClearQuestioner(server, 'wf-observed-scope', 'q-observed-clear', {
      evaluationRunId: 'eval-observed-pass',
    });
    await createCompletedInvocation(server, 'wf-observed-scope', {
      id: 'inv-builder-observed',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-observed',
      headSha: 'head-1',
      evidenceRefs: ['ev-observed-impl'],
    });
    await createCompletedInvocation(server, 'wf-observed-scope', {
      id: 'inv-evaluator-observed',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-observed',
      headSha: 'head-1',
      evaluationRunId: 'eval-observed-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-observed-scope/decisions/preflight',
      payload: {
        decision: buildDecision('wf-observed-scope', {
          id: 'dec-complete-observed-scope',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Observed changed files must drive contract scope validation.',
          evidenceRefs: ['ev-observed-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'worktree_out_of_scope',
    });
  });

  it('rejects v1 subtask completion when a passing evaluation lacks must-criteria coverage and real evidence', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-thin-evaluation', root);
    await putSingleSubtaskGraph(server, 'wf-thin-evaluation');
    await createAcceptedContract(server, 'wf-thin-evaluation');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-evaluation/evidence',
      payload: {
        id: 'ev-thin-impl',
        kind: 'implementation',
        title: 'Implementation evidence',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-thin-evaluation', 'st-api', 'ev-thin-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-evaluation/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-thin-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-thin-pass' },
      },
    });
    const thinResult = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-evaluation/subtasks/st-api/evaluations/eval-thin-pass/result',
      payload: {
        result: {
          workflowId: 'wf-thin-evaluation',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-thin-pass',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [],
          commandResults: [],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.9,
        },
      },
    });
    expect(thinResult.statusCode).toBe(200);
    expect(thinResult.json().evaluationRun).toMatchObject({
      status: 'inconclusive',
      result: {
        verdict: 'inconclusive',
      },
    });

    await recordClearQuestioner(server, 'wf-thin-evaluation', 'q-thin-clear', {
      evaluationRunId: 'eval-thin-pass',
    });
    await createCompletedInvocation(server, 'wf-thin-evaluation', {
      id: 'inv-builder-thin',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-thin',
      headSha: 'head-1',
      evidenceRefs: ['ev-thin-impl'],
    });
    await createCompletedInvocation(server, 'wf-thin-evaluation', {
      id: 'inv-evaluator-thin',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-thin',
      headSha: 'head-1',
      evaluationRunId: 'eval-thin-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-evaluation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-thin-evaluation', {
          id: 'dec-complete-thin-evaluation',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Passing verdict without criteria/evidence must not complete.',
          evidenceRefs: ['ev-thin-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'evaluation_not_passed',
    });
  });

  it('downgrades thin pass evaluation results before they can become passed runs', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-thin-result-downgrade', root);
    await putSingleSubtaskGraph(server, 'wf-thin-result-downgrade');
    await createAcceptedContract(server, 'wf-thin-result-downgrade');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-result-downgrade/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-thin-result',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-thin-result' },
      },
    });

    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-thin-result-downgrade/subtasks/st-api/evaluations/eval-thin-result/result',
      payload: {
        result: {
          workflowId: 'wf-thin-result-downgrade',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-thin-result',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [],
          commandResults: [],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.99,
        },
      },
    });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().evaluationRun).toMatchObject({
      id: 'eval-thin-result',
      status: 'inconclusive',
      result: {
        verdict: 'inconclusive',
      },
    });
    expect(recorded.json().evaluationRun.result.coverageGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        criterionId: 'all',
        reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
      }),
    ]));
  });

  it('does not treat not_tested placeholder criteria as real evaluator evidence', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-placeholder-criteria', root);
    await putSingleSubtaskGraph(server, 'wf-placeholder-criteria');
    await createAcceptedContract(server, 'wf-placeholder-criteria');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-placeholder-criteria/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-placeholder-criteria',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-placeholder-criteria' },
      },
    });

    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-placeholder-criteria/subtasks/st-api/evaluations/eval-placeholder-criteria/result',
      payload: {
        result: {
          workflowId: 'wf-placeholder-criteria',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-placeholder-criteria',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [
            { criterionId: 'ac-1', status: 'not_tested', evidence: 'No evaluator command was provided.' },
          ],
          commandResults: [],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.8,
        },
      },
    });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().evaluationRun).toMatchObject({
      status: 'inconclusive',
      result: {
        verdict: 'inconclusive',
      },
    });
    expect(recorded.json().evaluationRun.result.coverageGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        criterionId: 'all',
        reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
      }),
      expect.objectContaining({
        criterionId: 'ac-1',
        reason: 'Missing passing criteriaResult for a must acceptance criterion.',
      }),
    ]));
  });

  it('requires Claude Questioner output to match the latest evaluation provenance', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-provenance', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-provenance');
    await createAcceptedContract(server, 'wf-questioner-provenance');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/evidence',
      payload: {
        id: 'ev-questioner-impl',
        kind: 'implementation',
        title: 'Implementation evidence',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-questioner-provenance', 'st-api', 'ev-questioner-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-provenance',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-provenance' },
      },
    });
    await recordPassingEvaluation(server, 'wf-questioner-provenance', 'eval-provenance');
    await createCompletedInvocation(server, 'wf-questioner-provenance', {
      id: 'inv-builder-provenance',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-provenance',
      headSha: 'head-1',
      evidenceRefs: ['ev-questioner-impl'],
    });
    await createCompletedInvocation(server, 'wf-questioner-provenance', {
      id: 'inv-evaluator-provenance',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-provenance',
      headSha: 'head-1',
      evaluationRunId: 'eval-provenance',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/questioner-outputs',
      payload: {
        id: 'q-wrong-eval',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-wrong-eval' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-other',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://wrong-eval',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    const wrongEvaluation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/decisions/preflight',
      payload: {
        decision: buildDecision('wf-questioner-provenance', {
          id: 'dec-complete-wrong-questioner-eval',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Questioner must bind to the latest evaluation run.',
          evidenceRefs: ['ev-questioner-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(wrongEvaluation.statusCode).toBe(200);
    expect(wrongEvaluation.json().guard).toMatchObject({
      accepted: false,
      code: 'blocking_question_unresolved',
    });

    await recordClearQuestioner(server, 'wf-questioner-provenance', 'q-provenance-clear', {
      evaluationRunId: 'eval-provenance',
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/decisions/preflight',
      payload: {
        decision: buildDecision('wf-questioner-provenance', {
          id: 'dec-complete-questioner-provenance',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Questioner provenance matches current evaluation.',
          evidenceRefs: ['ev-questioner-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
  });

  it('ignores non-record artifact json files in the Questioner storage directory', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-artifact-noise', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-artifact-noise');
    await createAcceptedContract(server, 'wf-questioner-artifact-noise');
    await recordClearQuestioner(server, 'wf-questioner-artifact-noise', 'q-artifact-noise');

    const noisyDir = path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-questioner-artifact-noise', 'questioner');
    await fs.writeFile(
      path.join(noisyDir, 'q-artifact-copy.json'),
      JSON.stringify({
        id: 'q-artifact-copy',
        source: 'claude-plugin',
        intent: 'question_evaluation',
        // No workflowId/createdAt: this is an artifact copy, not a Tik store record.
      }),
      'utf-8',
    );

    const bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-questioner-artifact-noise',
    });

    expect(bundle.statusCode).toBe(200);
    expect(bundle.json().questionerOutputs).toHaveLength(1);
    expect(bundle.json().questionerOutputs[0]).toMatchObject({
      id: 'q-artifact-noise',
      workflowId: 'wf-questioner-artifact-noise',
    });
  });

  it('rejects hand-filled subagent thread ids without runtime attestation', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-manual-thread-ids', root);
    await putSingleSubtaskGraph(server, 'wf-manual-thread-ids');
    await createAcceptedContract(server, 'wf-manual-thread-ids');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-manual-thread-ids/evidence',
      payload: {
        id: 'ev-manual-impl',
        kind: 'implementation',
        title: 'Implementation evidence',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-manual-thread-ids', 'st-api', 'ev-manual-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-manual-thread-ids/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-manual-thread-ids',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-manual-thread-ids' },
      },
    });
    await recordPassingEvaluation(server, 'wf-manual-thread-ids', 'eval-manual-thread-ids');
    await recordClearQuestioner(server, 'wf-manual-thread-ids', 'q-manual-thread-ids', {
      evaluationRunId: 'eval-manual-thread-ids',
    });
    const manualBuilder = await createInvocationRecord(server, 'wf-manual-thread-ids', {
      id: 'inv-builder-manual',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-manual',
      headSha: 'head-1',
      evidenceRefs: ['ev-manual-impl'],
    });
    expect(manualBuilder.statusCode).toBe(200);
    const manualStart = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-manual-thread-ids/agent-invocations/inv-builder-manual/start',
      payload: {},
    });
    expect(manualStart.statusCode).toBe(409);
    expect(manualStart.json().error).toMatchObject({ code: 'missing_subagent_invocation' });

    const manualEvaluator = await createInvocationRecord(server, 'wf-manual-thread-ids', {
      id: 'inv-evaluator-manual',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-manual',
      headSha: 'head-1',
      evaluationRunId: 'eval-manual-thread-ids',
      readonlyPolicy: { enforced: true, violations: [] },
    });
    expect(manualEvaluator.statusCode).toBe(200);

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-manual-thread-ids/decisions/preflight',
      payload: {
        decision: buildDecision('wf-manual-thread-ids', {
          id: 'dec-complete-manual-thread-ids',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Hand-filled thread ids without runtime hook attestation must not complete.',
          evidenceRefs: ['ev-manual-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_subagent_invocation',
    });
  });

  it('rejects forged runtime attestation payloads that did not come through hook token endpoints', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-forged-attestation', root);

    const created = await createInvocationRecord(server, 'wf-forged-attestation', {
      id: 'inv-forged-attestation',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'forged-thread',
      headSha: 'head-1',
      evidenceRefs: ['ev-forged'],
        runtimeAttestation: {
          source: 'codex-plugin-hook',
          parentThreadId: 'workflow-parent-thread',
          actualSubagentThreadId: 'forged-thread',
          role: 'executor',
          nonce: 'forged-nonce',
          startedAt: '2026-07-01T00:00:00.000Z',
          stoppedAt: '2026-07-01T00:01:00.000Z',
        },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().invocation).toHaveProperty('attestationToken');
    expect(created.json().invocation).not.toHaveProperty('runtimeAttestation');

    const forgedStart = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-forged-attestation/agent-invocations/inv-forged-attestation/start',
      payload: {
        runtimeAttestation: {
          source: 'codex-plugin-hook',
          parentThreadId: 'workflow-parent-thread',
          actualSubagentThreadId: 'forged-thread',
          role: 'executor',
          nonce: 'forged-nonce',
          startedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    expect(forgedStart.statusCode).toBe(409);
    expect(forgedStart.json().error).toMatchObject({ code: 'missing_subagent_invocation' });

    const stored = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-forged-attestation/agent-invocations/inv-forged-attestation',
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().invocation).toMatchObject({
      status: 'created',
      hookAttested: false,
    });
    expect(stored.json().invocation).not.toHaveProperty('runtimeAttestation');
  });

  it('rejects hook-attested subagents whose parent thread does not match the workflow thread', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-parent-thread', root);
    await putSingleSubtaskGraph(server, 'wf-parent-thread');
    await createAcceptedContract(server, 'wf-parent-thread');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-parent-thread/evidence',
      payload: {
        id: 'ev-parent-thread-impl',
        kind: 'implementation',
        title: 'Implementation evidence',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-parent-thread', 'st-api', 'ev-parent-thread-impl');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-parent-thread/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-parent-thread',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-parent-thread' },
      },
    });
    await recordPassingEvaluation(server, 'wf-parent-thread', 'eval-parent-thread');
    await recordClearQuestioner(server, 'wf-parent-thread', 'q-parent-thread-clear', {
      evaluationRunId: 'eval-parent-thread',
    });
    await createCompletedInvocation(server, 'wf-parent-thread', {
      id: 'inv-builder-parent-thread',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-parent',
      headSha: 'head-1',
      evidenceRefs: ['ev-parent-thread-impl'],
      parentThreadId: 'workflow-parent-thread',
    });
    await createCompletedInvocation(server, 'wf-parent-thread', {
      id: 'inv-evaluator-parent-thread',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-parent',
      headSha: 'head-1',
      evaluationRunId: 'eval-parent-thread',
      readonlyPolicy: { enforced: true, violations: [] },
      parentThreadId: 'other-parent-thread',
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-parent-thread/decisions/preflight',
      payload: {
        decision: buildDecision('wf-parent-thread', {
          id: 'dec-complete-wrong-parent-thread',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Runtime attestation parent must match workflow parent thread.',
          evidenceRefs: ['ev-parent-thread-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'subagent_thread_not_isolated',
    });
  });

  it('guards v1 intermediate evaluator and final-evaluation actions', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-action-guards', root);
    await putSingleSubtaskGraph(server, 'wf-action-guards');
    await createAcceptedContract(server, 'wf-action-guards');

    const evaluatorBeforeImplementation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/decisions/preflight',
      payload: {
        decision: buildDecision('wf-action-guards', {
          id: 'dec-run-evaluator-before-implementation',
          action: 'run_codex_evaluator',
          subtaskId: 'st-api',
          reason: 'Evaluator requires implementation evidence first.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(evaluatorBeforeImplementation.statusCode).toBe(200);
    expect(evaluatorBeforeImplementation.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_implementation_evidence',
    });

    const finalEvaluationBeforeDone = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/decisions/preflight',
      payload: {
        decision: buildDecision('wf-action-guards', {
          id: 'dec-run-final-before-done',
          action: 'run_final_evaluation',
          reason: 'Final evaluation requires all subtasks done.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(finalEvaluationBeforeDone.statusCode).toBe(200);
    expect(finalEvaluationBeforeDone.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });
  });

  it('completes a v1 workflow only after final evaluation and final Questioner evidence pass', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-final-v1', root);
    await putSingleSubtaskGraph(server, 'wf-final-v1');
    await moveSubtaskToDone(server, 'wf-final-v1', 'st-api');

    const withoutFinalEvaluation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-final-v1', {
          id: 'dec-complete-workflow-before-final-eval',
          action: 'complete_workflow',
          reason: 'Final Codex evaluation should be required.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutFinalEvaluation.statusCode).toBe(200);
    expect(withoutFinalEvaluation.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_evaluation_result',
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/subtasks/__final__/evaluations',
      payload: {
        id: 'eval-final-pass',
        contractId: '__final__',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-final-session' },
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/subtasks/__final__/evaluations/eval-final-pass/result',
      payload: {
        result: {
          workflowId: 'wf-final-v1',
          subtaskId: '__final__',
          contractId: '__final__',
          evaluatorRunId: 'eval-final-pass',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [
            {
              criterionId: 'global-ac-1',
              status: 'pass',
              evidence: 'Final validation covered the v1 guarded loop.',
            },
          ],
          commandResults: [
            {
              commandId: 'cmd-final',
              command: 'pnpm --filter @tik/kernel test',
              status: 'passed',
              exitCode: 0,
              summary: 'Final verification passed.',
            },
          ],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.9,
        },
      },
    });

    const withoutFinalQuestioner = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-final-v1', {
          id: 'dec-complete-workflow-before-final-questioner',
          action: 'complete_workflow',
          reason: 'Final Questioner should inspect final evidence.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(withoutFinalQuestioner.statusCode).toBe(200);
    expect(withoutFinalQuestioner.json().guard).toMatchObject({
      accepted: false,
      code: 'blocking_question_unresolved',
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/questioner-outputs',
      payload: {
        id: 'q-final-clear',
        intent: 'question_final_evidence',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-final-q' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-final-pass',
        contractId: '__final__',
        artifactRef: 'questioner://claude-final-q',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-v1/decisions/preflight',
      payload: {
        decision: buildDecision('wf-final-v1', {
          id: 'dec-complete-workflow-v1',
          action: 'complete_workflow',
          reason: 'Final evaluation passed and final Questioner has no blockers.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
  });

  it('rejects v1 workflow completion when final evaluation does not cover global criteria', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-final-thin-evidence', root);
    await putSingleSubtaskGraph(server, 'wf-final-thin-evidence');
    await moveSubtaskToDone(server, 'wf-final-thin-evidence', 'st-api');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-thin-evidence/subtasks/__final__/evaluations',
      payload: {
        id: 'eval-final-thin',
        contractId: '__final__',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-final-thin-session' },
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-thin-evidence/subtasks/__final__/evaluations/eval-final-thin/result',
      payload: {
        result: {
          workflowId: 'wf-final-thin-evidence',
          subtaskId: '__final__',
          contractId: '__final__',
          evaluatorRunId: 'eval-final-thin',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [],
          commandResults: [
            {
              commandId: 'cmd-final-other',
              command: 'node -e "process.exit(0)"',
              status: 'passed',
              exitCode: 0,
              summary: 'A command passed, but it is not the required final command.',
            },
          ],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.9,
        },
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-thin-evidence/questioner-outputs',
      payload: {
        id: 'q-final-thin-clear',
        intent: 'question_final_evidence',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-final-thin-q' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-final-thin',
        contractId: '__final__',
        artifactRef: 'questioner://claude-final-thin-q',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-final-thin-evidence/decisions/preflight',
      payload: {
        decision: buildDecision('wf-final-thin-evidence', {
          id: 'dec-complete-workflow-thin-final-evidence',
          action: 'complete_workflow',
          reason: 'Thin final evidence must not complete the workflow.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });

    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({
      accepted: false,
      code: 'evaluation_evidence_insufficient',
    });
  });

  it('records complete-subtask through a single guarded action endpoint', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-action-complete-subtask', root);
    await putSingleSubtaskGraph(server, 'wf-action-complete-subtask');
    await createAcceptedContract(server, 'wf-action-complete-subtask');

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask/evidence',
      payload: {
        id: 'ev-action-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/guard.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-action-complete-subtask', 'st-api', 'ev-action-impl');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-action-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-action-pass' },
      },
    });
    await recordPassingEvaluation(server, 'wf-action-complete-subtask', 'eval-action-pass');
    await recordClearQuestioner(server, 'wf-action-complete-subtask', 'q-action-clear', {
      evaluationRunId: 'eval-action-pass',
    });
    await createCompletedInvocation(server, 'wf-action-complete-subtask', {
      id: 'inv-action-builder',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-action',
      headSha: 'head-1',
      evidenceRefs: ['ev-action-impl'],
    });
    await createCompletedInvocation(server, 'wf-action-complete-subtask', {
      id: 'inv-action-evaluator',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-action',
      headSha: 'head-1',
      evaluationRunId: 'eval-action-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const invalidAction = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask/actions/complete-subtask',
      payload: {
        decision: buildDecision('wf-action-complete-subtask', {
          id: 'dec-action-complete-subtask-invalid',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Wrong head should fail before any mutation.',
          evidenceRefs: ['ev-action-impl'],
          inputs: { currentHeadSha: 'wrong-head' },
        }),
        subtaskPatch: { status: 'done' },
      },
    });
    expect(invalidAction.statusCode).toBe(409);

    let bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask',
    });
    expect(bundle.json().decisions).toHaveLength(0);
    expect(bundle.json().subtasks['st-api'].status).toBe('questioning_evidence');

    const action = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask/actions/complete-subtask',
      payload: {
        decision: buildDecision('wf-action-complete-subtask', {
          id: 'dec-action-complete-subtask',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Single action records decision and completes subtask.',
          evidenceRefs: ['ev-action-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
        subtaskPatch: { status: 'done', evidenceRefs: ['ev-action-impl'] },
      },
    });

    expect(action.statusCode).toBe(200);
    expect(action.json().guard).toMatchObject({ accepted: true, code: 'ok' });
    expect(action.json().subtask).toMatchObject({ subtaskId: 'st-api', status: 'done' });

    bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-action-complete-subtask',
    });
    expect(bundle.json().decisions.map((decision: any) => decision.id)).toEqual(['dec-action-complete-subtask']);
    expect(bundle.json().subtasks['st-api'].status).toBe('done');
  });
});

async function makeTempWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-codex-evaluator-questioner-'));
  await fs.mkdir(path.join(root, 'repo'), { recursive: true });
  tempDirs.push(root);
  return root;
}

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

async function createV1Workflow(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  root: string,
) {
  const response = await server.inject({
    method: 'POST',
    url: '/api/v1/multi-agent/workflows',
    payload: {
      id: workflowId,
      goal: 'Exercise Codex evaluator and Claude questioner gates',
      rootTaskId: `root-${workflowId}`,
      headSha: 'head-1',
      metadata: {
        parentCodexThreadId: 'workflow-parent-thread',
      },
      policy: {
        requireAcceptedContract: true,
        requireQuestionerAfterEvaluation: true,
        requireEvaluationPassForComplete: true,
        requireSameHeadShaForEvidence: true,
        allowHumanOverride: false,
      },
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: path.basename(root),
        projectName: 'repo',
        effectiveProjectPath: path.join(root, 'repo'),
        sourceProjectPath: path.join(root, 'repo'),
        worktreeKind: 'root',
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

async function putSingleSubtaskGraph(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
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
        globalAcceptanceCriteria: ['Complete the v1 guarded loop.'],
        finalValidationCommands: ['pnpm --filter @tik/kernel test'],
        subtasks: [
          {
            id: 'st-api',
            title: 'Add coordination API',
            goal: 'Support v1 evaluator/questioner coordination.',
            dependsOn: [],
            allowedPaths: ['packages/kernel/src'],
            blockedPaths: ['package.json'],
            acceptanceCriteria: ['Accepted contract gates execution.'],
            validationCommands: ['pnpm --filter @tik/kernel test'],
            reviewFocus: ['guard behavior'],
            assignedExecutor: 'codex',
            assignedReviewer: 'claude-code',
          },
        ],
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

async function createAcceptedContract(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  options: {
    allowedPaths?: string[];
    blockedPaths?: string[];
  } = {},
) {
  const contract = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/contracts`,
    payload: {
      id: 'contract-st-api-v1',
      version: 1,
      status: 'draft',
      goal: 'Support accepted contract, evaluator, and questioner gates.',
      scope: {
        allowedPaths: options.allowedPaths || ['packages/kernel/src'],
        blockedPaths: options.blockedPaths || ['package.json'],
      },
      deliverables: [
        { id: 'del-api', description: 'API routes persist v1 artifacts.' },
      ],
      acceptanceCriteria: [
        {
          id: 'ac-1',
          statement: 'Subtask completion requires pass evidence from an isolated Codex evaluator.',
          priority: 'must',
          verificationMethod: 'command',
        },
      ],
      verificationPlan: {
        commands: [
          {
            id: 'cmd-test',
            command: 'pnpm --filter @tik/kernel test',
            hardTimeoutMs: 120000,
            required: true,
          },
        ],
      },
      questionerOutputRefs: [],
      headShaAtAcceptance: 'head-1',
    },
  });
  expect(contract.statusCode).toBe(200);

  return server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/contracts/contract-st-api-v1/accept`,
    payload: {
      acceptedBy: 'codex-workflow-plugin',
      headShaAtAcceptance: 'head-1',
    },
  });
}

async function moveSubtaskToQuestioningEvidence(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
  evidenceId = 'ev-impl',
) {
  for (const status of ['contract_drafting', 'contract_questioning', 'contract_accepted', 'building', 'implemented', 'evaluating', 'evaluation_passed', 'questioning_evidence']) {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
      payload: {
        status,
        implementationHeadSha: status === 'implemented' ? 'head-1' : undefined,
        evidenceRefs: status === 'implemented' ? [evidenceId] : undefined,
      },
    });
    expect(response.statusCode).toBe(200);
  }
}

async function recordPassingEvaluation(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  evaluationId: string,
) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/evaluations/${evaluationId}/result`,
    payload: {
      result: {
        workflowId,
        subtaskId: 'st-api',
        contractId: 'contract-st-api-v1',
        evaluatorRunId: evaluationId,
        headSha: 'head-1',
        verdict: 'pass',
        criteriaResults: [
          { criterionId: 'ac-1', status: 'pass', evidence: 'Targeted test passed.' },
        ],
        commandResults: [
          {
            commandId: 'cmd-test',
            command: 'pnpm --filter @tik/kernel test',
            status: 'passed',
            exitCode: 0,
            summary: 'Kernel tests passed.',
          },
        ],
        runtimeFindings: [],
        coverageGaps: [],
        confidence: 0.88,
      },
    },
  });
  expect(response.statusCode).toBe(200);
}

async function recordClearQuestioner(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  questionerId: string,
  options: {
    evaluationRunId?: string;
    contractId?: string;
    headSha?: string;
  } = {},
) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/questioner-outputs`,
    payload: {
      id: questionerId,
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      actor: { kind: 'claude-code-questioner', invocationId: questionerId },
      source: 'claude-plugin',
      headSha: options.headSha || 'head-1',
      evaluationRunId: options.evaluationRunId || 'eval-pass',
      contractId: options.contractId || 'contract-st-api-v1',
      artifactRef: `questioner://${questionerId}`,
      verdict: 'evidence_sufficient',
      questions: [],
      risks: [],
      missingTests: [],
      suggestedContractChanges: [],
    },
  });
  expect(response.statusCode).toBe(200);
}

async function createCompletedInvocation(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  input: {
    id: string;
    subtaskId: string;
    role: 'executor' | 'evaluator';
    runner: 'codex' | 'codex-evaluator';
    promptContract: string;
    threadId: string;
    headSha: string;
    evidenceRefs?: string[];
    evaluationRunId?: string;
    readonlyPolicy?: {
      enforced: boolean;
      violations: string[];
    };
    runtimeAttested?: boolean;
    parentThreadId?: string;
  },
) {
  const created = await createInvocationRecord(server, workflowId, {
    ...input,
  });
  expect(created.statusCode).toBe(200);
  const attestationToken = created.json().invocation.attestationToken;

  if (input.runtimeAttested === false) {
    return created;
  }
  expect(attestationToken).toBeTypeOf('string');

  const started = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/${input.id}/hook-start`,
    payload: {
      attestationToken,
      nonce: `nonce-${input.id}`,
      parentThreadId: input.parentThreadId || 'workflow-parent-thread',
      actualSubagentThreadId: input.threadId,
      role: input.role,
      startedAt: '2026-07-01T00:00:00.000Z',
    },
  });
  expect(started.statusCode).toBe(200);

  const completed = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/${input.id}/hook-stop`,
    payload: {
      attestationToken,
      status: 'completed',
      stoppedAt: '2026-07-01T00:01:00.000Z',
      headSha: input.headSha,
      evidenceRefs: input.evidenceRefs,
      evaluationRunId: input.evaluationRunId,
      readonlyPolicy: input.readonlyPolicy,
      result: {
        threadId: input.threadId,
        headSha: input.headSha,
        evidenceRefs: input.evidenceRefs,
        evaluationRunId: input.evaluationRunId,
        readonlyPolicy: input.readonlyPolicy,
      },
    },
  });
  expect(completed.statusCode).toBe(200);
  return completed;
}

async function createInvocationRecord(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  input: {
    id: string;
    subtaskId: string;
    role: 'executor' | 'evaluator';
    runner: 'codex' | 'codex-evaluator';
    promptContract: string;
    threadId?: string;
    headSha: string;
    evidenceRefs?: string[];
    evaluationRunId?: string;
    readonlyPolicy?: {
      enforced: boolean;
      violations: string[];
    };
    runtimeAttestation?: Record<string, unknown>;
  },
) {
  return server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations`,
    payload: {
      id: input.id,
      subtaskId: input.subtaskId,
      role: input.role,
      runner: input.runner,
      promptContract: input.promptContract,
      threadId: input.threadId,
      headSha: input.headSha,
      evidenceRefs: input.evidenceRefs,
      evaluationRunId: input.evaluationRunId,
      readonlyPolicy: input.readonlyPolicy,
      runtimeAttestation: input.runtimeAttestation,
    },
  });
}

async function moveSubtaskToDone(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  subtaskId: string,
) {
  for (const status of ['contract_drafting', 'contract_questioning', 'contract_accepted', 'building', 'implemented', 'evaluating', 'evaluation_passed', 'questioning_evidence', 'done']) {
    const response = await server.inject({
      method: 'PATCH',
      url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/${subtaskId}`,
      payload: {
        status,
      },
    });
    expect(response.statusCode).toBe(200);
  }
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
    decidedBy: 'codex-workflow-plugin',
    decidedAt: '2026-07-01T00:00:00.000Z',
    evidenceRefs: [],
    ...patch,
  };
}
