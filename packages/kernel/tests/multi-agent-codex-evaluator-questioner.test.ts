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

    expect(withoutContract.statusCode).toBe(409);
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
    expect(beforeQuestioner.statusCode).toBe(409);
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
    expect(blockingQuestion.statusCode).toBe(409);
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
    await recordClearQuestioner(server, 'wf-glob-scope', 'q-glob-clear');
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
    expect(withoutInvocations.statusCode).toBe(409);
    expect(withoutInvocations.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_subagent_invocation',
    });

    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-builder-threaded',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-evaluator-missing-thread',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const missingThread = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-subagent-isolation', {
          id: 'dec-complete-missing-thread',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Builder and Evaluator invocations must include Codex subagent thread ids.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(missingThread.statusCode).toBe(409);
    expect(missingThread.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_subagent_invocation',
    });

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
    expect(sameThread.statusCode).toBe(409);
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
    expect(withoutFinalEvaluation.statusCode).toBe(409);
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
          criteriaResults: [],
          commandResults: [
            {
              commandId: 'cmd-final',
              command: 'pnpm test',
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
    expect(withoutFinalQuestioner.statusCode).toBe(409);
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
) {
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/questioner-outputs`,
    payload: {
      id: questionerId,
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      actor: { kind: 'claude-code-questioner', invocationId: questionerId },
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
  },
) {
  const created = await server.inject({
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
    },
  });
  expect(created.statusCode).toBe(200);

  const started = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/${input.id}/start`,
  });
  expect(started.statusCode).toBe(200);

  const completed = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/agent-invocations/${input.id}/result`,
    payload: {
      status: 'completed',
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
