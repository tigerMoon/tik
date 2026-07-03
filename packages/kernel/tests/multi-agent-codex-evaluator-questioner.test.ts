import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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

    const manualQuestioner = await server.inject({
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
    expect(manualQuestioner.statusCode).toBe(409);
    expect(manualQuestioner.json().error.code).toBe('missing_subagent_invocation');

    const blockingRun = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/questioner-runs',
      payload: {
        id: 'qr-blocking',
        invocationId: 'claude-q-1',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-pass',
        headSha: 'head-1',
        start: true,
        runtimeAudit: { gitStatusBefore: '' },
      },
    });
    expect(blockingRun.statusCode).toBe(200);
    const blockingV2 = buildQuestionerOutputV2({
      id: 'q-blocking',
      runResponse: blockingRun.json(),
      workflowId: 'wf-complete-v1',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      verdict: 'questions_blocking',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: ['eval-pass:criteria:ac-1'],
          comment: 'Evidence exists, but the failure path is still unchallenged.',
        },
      ],
      questions: [
        {
          id: 'q1',
          priority: 'blocking',
          category: 'missing_test',
          claim: 'Was the failure path evaluated?',
          evidenceRefs: ['eval-pass'],
          requestedEvidence: 'Add or cite failure-path test evidence.',
          status: 'open',
        },
      ],
    });
    const blockingOutput = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-complete-v1/questioner-runs/qr-blocking/output',
      headers: {
        authorization: `Bearer ${blockingRun.json().token}`,
      },
      payload: { output: blockingV2, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(blockingOutput.statusCode).toBe(200);

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

    await recordClearQuestioner(server, 'wf-complete-v1', 'q-clear', {
      invocationId: 'claude-q-2',
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

  it('creates a token-scoped QuestionerRun context and accepts a matching QuestionerOutputV2', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);
    await fs.mkdir(path.join(root, 'repo/packages/kernel/src/multi-agent'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'repo/packages/kernel/src/multi-agent/workflow-store.ts'),
      'export function questionerContextFixture() { return "fresh"; }\n',
      'utf-8',
    );
    const stdoutArtifact = path.join(root, '.tik/multi-agent/workflows/wf-questioner-run-v2/evaluations/eval-pass/stdout.log');
    await fs.mkdir(path.dirname(stdoutArtifact), { recursive: true });
    await fs.writeFile(stdoutArtifact, 'PASS multi-agent evaluator\ncoverage gap: none\n', 'utf-8');

    await createV1Workflow(server, 'wf-questioner-run-v2', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-run-v2');
    await createAcceptedContract(server, 'wf-questioner-run-v2');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/evidence',
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
    await moveSubtaskToQuestioningEvidence(server, 'wf-questioner-run-v2', 'st-api');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
      },
    });
    await recordPassingEvaluation(server, 'wf-questioner-run-v2', 'eval-pass', {
      commandResults: [
        {
          commandId: 'cmd-test',
          command: 'pnpm --filter @tik/kernel test',
          status: 'passed',
          exitCode: 0,
          stdoutArtifactId: '.tik/multi-agent/workflows/wf-questioner-run-v2/evaluations/eval-pass/stdout.log',
          summary: 'Kernel tests passed.',
        },
      ],
    });
    await createCompletedInvocation(server, 'wf-questioner-run-v2', {
      id: 'inv-builder-v2',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-v2',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-questioner-run-v2', {
      id: 'inv-evaluator-v2',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-v2',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/questioner-runs',
      payload: {
        id: 'qr-v2',
        invocationId: 'inv-questioner-v2',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-pass',
        headSha: 'head-1',
        start: true,
        runtimeAudit: { gitStatusBefore: '' },
      },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      questionerRunId: 'qr-v2',
      invocationId: 'inv-questioner-v2',
      contextHash: expect.stringMatching(/^sha256:/),
      token: expect.any(String),
    });

    const context = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/questioner-runs/qr-v2/context',
      headers: {
        authorization: `Bearer ${run.json().token}`,
      },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      context: {
        schemaVersion: 'questioner-context.v1',
        run: {
          questionerRunId: 'qr-v2',
          invocationId: 'inv-questioner-v2',
          contextHash: run.json().contextHash,
        },
        contract: {
          id: 'contract-st-api-v1',
        },
        evaluation: {
          id: 'eval-pass',
          readonly: true,
        },
      },
    });
    expect(context.json().context.diff.files).toContainEqual({
      path: 'packages/kernel/src/multi-agent/workflow-store.ts',
      changeType: 'modified',
    });
    expect(context.json().context.diff.excerpts.length).toBeGreaterThan(0);
    expect(context.json().context.relevantFiles).toEqual([
      expect.objectContaining({
        path: 'packages/kernel/src/multi-agent/workflow-store.ts',
        sha256: expect.stringMatching(/^sha256:/),
        excerpt: expect.stringContaining('questionerContextFixture'),
      }),
    ]);
    expect(context.json().context.evaluation.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactRef: '.tik/multi-agent/workflows/wf-questioner-run-v2/evaluations/eval-pass/stdout.log',
          excerpt: expect.stringContaining('PASS multi-agent evaluator'),
        }),
      ]),
    );
    expect(context.json().context.evaluation.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: '.tik/multi-agent/workflows/wf-questioner-run-v2/evaluations/eval-pass/stdout.log',
          summary: expect.stringContaining('sha256:'),
        }),
      ]),
    );

    const output = buildQuestionerOutputV2({
      id: 'q-v2-clear',
      runResponse: run.json(),
      workflowId: 'wf-questioner-run-v2',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      verdict: 'evidence_sufficient',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: ['eval-pass:criteria:ac-1', 'cmd-test'],
          comment: 'Evaluator criterion and command evidence cover the contract must criterion.',
        },
      ],
    });
    const submitted = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/questioner-runs/qr-v2/output',
      headers: {
        authorization: `Bearer ${run.json().token}`,
      },
      payload: { output, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      questionerRun: {
        id: 'qr-v2',
        status: 'validated',
        outputHash: output.attestation.outputHash,
      },
      questionerOutput: {
        id: 'q-v2-clear',
        schemaVersion: 'questioner-output.v2',
        questionerRunId: 'qr-v2',
      },
      invocation: {
        id: 'inv-questioner-v2',
        status: 'completed',
      },
    });

    const complete = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-v2/decisions/preflight',
      payload: {
        decision: buildDecision('wf-questioner-run-v2', {
          id: 'dec-complete-v2',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Strict QuestionerOutputV2 covers the current evaluation evidence.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().guard).toMatchObject({ accepted: true, code: 'ok' });
  });

  it('rejects QuestionerOutputV2 with missing required coverage before it can satisfy the gate', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-run-coverage', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-run-coverage');
    await createAcceptedContract(server, 'wf-questioner-run-coverage');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-coverage/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
      },
    });
    await recordPassingEvaluation(server, 'wf-questioner-run-coverage', 'eval-pass');

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-coverage/questioner-runs',
      payload: {
        id: 'qr-missing-coverage',
        invocationId: 'inv-questioner-missing-coverage',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-pass',
        headSha: 'head-1',
        start: true,
        runtimeAudit: { gitStatusBefore: '' },
      },
    });
    expect(run.statusCode).toBe(200);

    const output = buildQuestionerOutputV2({
      id: 'q-missing-coverage',
      runResponse: run.json(),
      workflowId: 'wf-questioner-run-coverage',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      verdict: 'evidence_sufficient',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'missing',
          evidenceRefs: [],
          comment: 'No evidence cited.',
        },
      ],
    });
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-coverage/questioner-runs/qr-missing-coverage/output',
      headers: {
        authorization: `Bearer ${run.json().token}`,
      },
      payload: { output, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: 'evaluation_evidence_insufficient',
    });

    const workflow = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-coverage',
    });
    expect(workflow.statusCode).toBe(200);
    expect(workflow.json().questionerRuns).toEqual([
      expect.objectContaining({
        id: 'qr-missing-coverage',
        status: 'rejected',
      }),
    ]);
  });

  it('rejects direct QuestionerOutputV2 POSTs with forged attestation hashes', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-run-attestation', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-run-attestation');
    await createAcceptedContract(server, 'wf-questioner-run-attestation');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-attestation/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
      },
    });
    await recordPassingEvaluation(server, 'wf-questioner-run-attestation', 'eval-pass');

    const createRun = async (id: string) => {
      const run = await server.inject({
        method: 'POST',
        url: '/api/v1/multi-agent/workflows/wf-questioner-run-attestation/questioner-runs',
        payload: {
          id,
          invocationId: `inv-${id}`,
          subtaskId: 'st-api',
          intent: 'question_evaluation',
          contractId: 'contract-st-api-v1',
          evaluationRunId: 'eval-pass',
          headSha: 'head-1',
          start: true,
          runtimeAudit: { gitStatusBefore: '' },
        },
      });
      expect(run.statusCode).toBe(200);
      return run;
    };
    const buildOutput = (run: Awaited<ReturnType<typeof createRun>>, id: string) => buildQuestionerOutputV2({
      id,
      runResponse: run.json(),
      workflowId: 'wf-questioner-run-attestation',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      verdict: 'evidence_sufficient',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: ['eval-pass:criteria:ac-1', 'cmd-test'],
          comment: 'Evaluator criterion and command evidence cover the contract must criterion.',
        },
      ],
    });

    const badOutputHashRun = await createRun('qr-bad-output-hash');
    const badOutputHash = buildOutput(badOutputHashRun, 'q-bad-output-hash');
    badOutputHash.attestation.outputHash = 'sha256:forged-output-hash';
    const rejectedOutputHash = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-attestation/questioner-runs/qr-bad-output-hash/output',
      headers: {
        authorization: `Bearer ${badOutputHashRun.json().token}`,
      },
      payload: { output: badOutputHash, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(rejectedOutputHash.statusCode).toBe(409);
    expect(rejectedOutputHash.json().error).toMatchObject({
      code: 'missing_evidence',
      message: expect.stringContaining('canonical JSON payload'),
    });

    const badContextHashRun = await createRun('qr-bad-context-hash');
    const badContextHash = buildOutput(badContextHashRun, 'q-bad-context-hash');
    badContextHash.attestation.contextHash = 'sha256:forged-context-hash';
    badContextHash.attestation.outputHash = canonicalQuestionerOutputHash(badContextHash);
    const rejectedContextHash = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-run-attestation/questioner-runs/qr-bad-context-hash/output',
      headers: {
        authorization: `Bearer ${badContextHashRun.json().token}`,
      },
      payload: { output: badContextHash, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(rejectedContextHash.statusCode).toBe(409);
    expect(rejectedContextHash.json().error).toMatchObject({
      code: 'missing_evidence',
      message: expect.stringContaining('context attestation'),
    });
  });

  it('requires a validated contract QuestionerRun before accepting a contract when policy demands it', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-contract-questioner-hard-gate', root);
    await putSingleSubtaskGraph(server, 'wf-contract-questioner-hard-gate');
    const policy = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate',
      payload: {
        policy: {
          requireQuestionerBeforeBuild: true,
        },
      },
    });
    expect(policy.statusCode).toBe(200);
    await createDraftContract(server, 'wf-contract-questioner-hard-gate');

    const directAccept = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/subtasks/st-api/contracts/contract-st-api-v1/accept',
      payload: {
        acceptedBy: 'codex-workflow-plugin',
        headShaAtAcceptance: 'head-1',
      },
    });
    expect(directAccept.statusCode).toBe(409);
    expect(directAccept.json().error).toMatchObject({
      code: 'missing_evidence',
    });
    const questioning = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/subtasks/st-api',
      payload: {
        status: 'contract_drafting',
      },
    });
    expect(questioning.statusCode).toBe(200);

    const preflight = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/decisions/preflight',
      payload: {
        decision: buildDecision('wf-contract-questioner-hard-gate', {
          id: 'dec-accept-contract-before-questioner',
          action: 'accept_contract',
          subtaskId: 'st-api',
          reason: 'Policy requires contract Questioner output.',
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_evidence',
    });

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/questioner-runs',
      payload: {
        id: 'qr-contract-blocking',
        invocationId: 'inv-contract-blocking',
        subtaskId: 'st-api',
        intent: 'question_contract',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        start: true,
        runtimeAudit: { gitStatusBefore: '' },
      },
    });
    expect(run.statusCode).toBe(200);
    const blockingOutput = buildQuestionerOutputV2({
      id: 'q-contract-blocking',
      runResponse: run.json(),
      workflowId: 'wf-contract-questioner-hard-gate',
      subtaskId: 'st-api',
      intent: 'question_contract',
      headSha: 'head-1',
      contractId: 'contract-st-api-v1',
      verdict: 'questions_blocking',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: ['contract-st-api-v1:ac-1'],
          comment: 'Contract criterion is present, but a blocking ambiguity remains.',
        },
      ],
      questions: [
        {
          id: 'q-contract-ambiguity',
          priority: 'blocking',
          category: 'contract_gap',
          claim: 'The contract does not say how failure responses are verified.',
          evidenceRefs: ['contract-st-api-v1'],
          requestedFix: 'Clarify failure response coverage in the contract or record why it is out of scope.',
          status: 'open',
        },
      ],
    });
    const blockingSubmitted = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/questioner-runs/qr-contract-blocking/output',
      headers: {
        authorization: `Bearer ${run.json().token}`,
      },
      payload: { output: blockingOutput, runtimeAudit: { gitStatusAfter: '' } },
    });
    expect(blockingSubmitted.statusCode).toBe(200);

    const stillBlocked = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/subtasks/st-api/contracts/contract-st-api-v1/accept',
      payload: {
        acceptedBy: 'codex-workflow-plugin',
        headShaAtAcceptance: 'head-1',
      },
    });
    expect(stillBlocked.statusCode).toBe(409);

    const resolution = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/question-resolutions',
      payload: {
        id: 'qres-contract-ambiguity',
        questionerOutputId: 'q-contract-blocking',
        questionId: 'q-contract-ambiguity',
        status: 'resolved',
        resolvedByInvocationId: 'inv-contract-revision',
        evidenceRefs: ['contract-st-api-v1'],
        explanation: 'Failure response verification is handled by the required cmd-test contract command.',
      },
    });
    expect(resolution.statusCode).toBe(200);

    const accepted = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-contract-questioner-hard-gate/subtasks/st-api/contracts/contract-st-api-v1/accept',
      payload: {
        acceptedBy: 'codex-workflow-plugin',
        headShaAtAcceptance: 'head-1',
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().contract).toMatchObject({
      id: 'contract-st-api-v1',
      status: 'accepted',
    });
  });

  it('rejects QuestionerRun output when readonly audit observes forbidden writes', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-readonly-audit', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-readonly-audit');
    await createAcceptedContract(server, 'wf-questioner-readonly-audit');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-readonly-audit/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
      },
    });
    await recordPassingEvaluation(server, 'wf-questioner-readonly-audit', 'eval-pass');

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-readonly-audit/questioner-runs',
      payload: {
        id: 'qr-readonly-violation',
        invocationId: 'inv-questioner-readonly-violation',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-pass',
        headSha: 'head-1',
        start: true,
        runtimeAudit: { gitStatusBefore: '' },
      },
    });
    expect(run.statusCode).toBe(200);
    const output = buildQuestionerOutputV2({
      id: 'q-readonly-violation',
      runResponse: run.json(),
      workflowId: 'wf-questioner-readonly-audit',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      verdict: 'evidence_sufficient',
      coverageMatrix: [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: ['eval-pass', 'ac-1'],
          comment: 'Evaluator evidence covers the must criterion.',
        },
      ],
    });
    const rejected = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-readonly-audit/questioner-runs/qr-readonly-violation/output',
      headers: {
        authorization: `Bearer ${run.json().token}`,
      },
      payload: {
        output,
        runtimeAudit: {
          gitStatusAfter: ' M packages/kernel/src/multi-agent/guard.ts\n',
        },
      },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toMatchObject({
      code: 'readonly_policy_violated',
    });

    const bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-questioner-readonly-audit',
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.json().questionerRuns).toEqual([
      expect.objectContaining({
        id: 'qr-readonly-violation',
        status: 'rejected',
        readonlyAudit: expect.objectContaining({
          violations: ['packages/kernel/src/multi-agent/guard.ts'],
        }),
      }),
    ]);
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

    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-builder-missing-nonce',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-missing-nonce',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-evaluator-missing-nonce',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-missing-nonce',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });
    const invocationsFile = path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-subagent-isolation', 'invocations.jsonl');
    const invocations = (await fs.readFile(invocationsFile, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    await fs.writeFile(
      invocationsFile,
      invocations.map((invocation) => {
        if (invocation.id === 'inv-builder-missing-nonce' || invocation.id === 'inv-evaluator-missing-nonce') {
          const runtimeAttestation = { ...invocation.runtimeAttestation };
          delete runtimeAttestation.nonce;
          return JSON.stringify({ ...invocation, runtimeAttestation });
        }
        return JSON.stringify(invocation);
      }).join('\n') + '\n',
      'utf-8',
    );
    const missingNonce = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-subagent-isolation/decisions/preflight',
      payload: {
        decision: buildDecision('wf-subagent-isolation', {
          id: 'dec-complete-missing-nonce',
          action: 'complete_subtask',
          subtaskId: 'st-api',
          reason: 'Runtime attestation without nonce must not satisfy guard.',
          evidenceRefs: ['ev-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(missingNonce.statusCode).toBe(200);
    expect(missingNonce.json().guard).toMatchObject({
      accepted: false,
      code: 'missing_subagent_invocation',
    });

    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-builder-with-nonce',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-with-nonce',
      headSha: 'head-1',
      evidenceRefs: ['ev-impl'],
    });
    await createCompletedInvocation(server, 'wf-subagent-isolation', {
      id: 'inv-evaluator-with-nonce',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-with-nonce',
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

    const staleInvocationOutput = await server.inject({
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
    expect(staleInvocationOutput.statusCode).toBe(409);
    expect(staleInvocationOutput.json().error).toMatchObject({
      code: 'missing_subagent_invocation',
    });

    await createCompletedQuestionerInvocation(server, 'wf-questioner-provenance', {
      id: 'claude-q-wrong-eval',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-provenance',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://wrong-eval',
      outputId: 'q-wrong-eval',
      verdict: 'evidence_sufficient',
    });

    const mismatchedOutput = await server.inject({
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
    expect(mismatchedOutput.statusCode).toBe(409);
    expect(mismatchedOutput.json().error).toMatchObject({
      code: 'missing_evidence',
    });

    await createCompletedQuestionerInvocation(server, 'wf-questioner-provenance', {
      id: 'claude-q-question-mismatch',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-provenance',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://question-mismatch',
      outputId: 'q-question-mismatch',
      verdict: 'evidence_sufficient',
      questions: [
        {
          id: 'q-blocker',
          priority: 'blocking',
          question: 'Where is the failing-path evidence?',
          whyItMatters: 'The completed invocation result marked this as blocking.',
          expectedAnswerType: 'evidence',
        },
      ],
    });

    const changedQuestions = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/questioner-outputs',
      payload: {
        id: 'q-question-mismatch',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-question-mismatch' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-provenance',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://question-mismatch',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });
    expect(changedQuestions.statusCode).toBe(409);
    expect(changedQuestions.json().error).toMatchObject({
      code: 'missing_evidence',
    });

    await createCompletedQuestionerInvocation(server, 'wf-questioner-provenance', {
      id: 'claude-q-wrong-eval-recordable',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-other',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://wrong-eval-recordable',
      outputId: 'q-wrong-eval-recordable',
      verdict: 'evidence_sufficient',
    });

    const wrongEvaluationOutput = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-provenance/questioner-outputs',
      payload: {
        id: 'q-wrong-eval-recordable',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-wrong-eval-recordable' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-other',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://wrong-eval-recordable',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });
    expect(wrongEvaluationOutput.statusCode).toBe(200);

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

  it('adopts the Claude invocation result id for API-recorded Questioner output', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-result-id', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-result-id');
    await createAcceptedContract(server, 'wf-questioner-result-id');

    await createCompletedQuestionerInvocation(server, 'wf-questioner-result-id', {
      id: 'claude-q-result-id-only',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://result-id-only',
      outputId: 'q-result-id-only',
      verdict: 'evidence_sufficient',
    });

    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-result-id/questioner-outputs',
      payload: {
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-result-id-only' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-pass',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://result-id-only',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().questionerOutput).toMatchObject({
      id: 'q-result-id-only',
      actor: { invocationId: 'claude-q-result-id-only' },
    });

    await createCompletedQuestionerInvocation(server, 'wf-questioner-result-id', {
      id: 'claude-q-missing-output-id',
      subtaskId: 'st-api',
      intent: 'question_evaluation',
      headSha: 'head-1',
      evaluationRunId: 'eval-pass',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://missing-output-id',
      verdict: 'evidence_sufficient',
    });

    const missingId = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-result-id/questioner-outputs',
      payload: {
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-missing-output-id' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-pass',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://missing-output-id',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });

    expect(missingId.statusCode).toBe(409);
    expect(missingId.json().error).toMatchObject({
      code: 'missing_evidence',
    });
  });

  it('ignores non-record artifact json files in the Questioner storage directory', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-questioner-artifact-noise', root);
    await putSingleSubtaskGraph(server, 'wf-questioner-artifact-noise');
    await createAcceptedContract(server, 'wf-questioner-artifact-noise');
    await createCompletedQuestionerInvocation(server, 'wf-questioner-artifact-noise', {
      id: 'claude-q-artifact-noise',
      subtaskId: 'st-api',
      intent: 'question_contract',
      headSha: 'head-1',
      contractId: 'contract-st-api-v1',
      artifactRef: 'questioner://artifact-noise',
      outputId: 'q-artifact-noise',
      verdict: 'evidence_sufficient',
    });
    const recorded = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-questioner-artifact-noise/questioner-outputs',
      payload: {
        id: 'q-artifact-noise',
        subtaskId: 'st-api',
        intent: 'question_contract',
        actor: { kind: 'claude-code-questioner', invocationId: 'claude-q-artifact-noise' },
        source: 'claude-plugin',
        headSha: 'head-1',
        contractId: 'contract-st-api-v1',
        artifactRef: 'questioner://artifact-noise',
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
      },
    });
    expect(recorded.statusCode).toBe(200);

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
        nonce: 'nonce-forged',
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
          nonce: 'nonce-forged',
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

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/evidence',
      payload: {
        id: 'ev-action-guard-impl',
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
    const executing = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: { status: 'executing' },
    });
    expect(executing.statusCode).toBe(200);
    const implemented = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: {
        status: 'implemented',
        implementationHeadSha: 'head-1',
        evidenceRefs: ['ev-action-guard-impl'],
      },
    });
    expect(implemented.statusCode).toBe(200);
    const validated = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: {
        status: 'validated',
        implementationHeadSha: 'head-1',
        lastValidatedHeadSha: 'head-1',
        evidenceRefs: ['ev-action-guard-impl'],
      },
    });
    expect(validated.statusCode).toBe(200);
    const evaluatorAfterValidation = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/decisions/preflight',
      payload: {
        decision: buildDecision('wf-action-guards', {
          id: 'dec-run-evaluator-after-validation',
          action: 'run_codex_evaluator',
          subtaskId: 'st-api',
          reason: 'The documented validate -> evaluator path should remain legal in v1 mode.',
          evidenceRefs: ['ev-action-guard-impl'],
          inputs: { currentHeadSha: 'head-1' },
        }),
      },
    });
    expect(evaluatorAfterValidation.statusCode).toBe(200);
    expect(evaluatorAfterValidation.json().guard).toMatchObject({
      accepted: true,
      code: 'ok',
    });
    const evaluating = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: { status: 'evaluating' },
    });
    expect(evaluating.statusCode).toBe(200);
    const evaluationFailed = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: { status: 'evaluation_failed' },
    });
    expect(evaluationFailed.statusCode).toBe(200);
    const reEvaluating = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-action-guards/subtasks/st-api',
      payload: { status: 'evaluating' },
    });
    expect(reEvaluating.statusCode).toBe(200);

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

  it('serves v1 next-action from the kernel planner with action metadata and strict questioner gates', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-next-action-v1', root);
    await putSingleSubtaskGraph(server, 'wf-next-action-v1');

    let next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'draft_contract',
      phase: 'contract',
      reasonCode: 'missing_contract',
      subtaskId: 'st-api',
      actionDefinition: {
        id: 'draft_contract',
        handler: 'contract.draft',
      },
    });

    await createAcceptedContract(server, 'wf-next-action-v1');
    next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'execute_subtask',
      phase: 'building',
      reasonCode: 'missing_implementation_evidence',
      inputs: {
        contractId: 'contract-st-api-v1',
      },
      actionDefinition: {
        runner: 'codex',
        role: 'executor',
      },
    });

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/evidence',
      payload: {
        id: 'ev-next-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/workflow-engine/planner.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-next-action-v1', 'st-api', 'ev-next-impl');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-next-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-next-session' },
      },
    });
    await recordPassingEvaluation(server, 'wf-next-action-v1', 'eval-next-pass');

    next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'ask_claude_question_evaluation',
      phase: 'evaluation_questioning',
      reasonCode: 'blocking_question_unresolved',
      inputs: {
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-next-pass',
      },
      actionDefinition: {
        runner: 'claude-code',
        intent: 'question_evaluation',
        strictOutput: 'QuestionerOutputV2',
      },
    });

    await recordClearQuestioner(server, 'wf-next-action-v1', 'q-next-clear', {
      evaluationRunId: 'eval-next-pass',
    });

    next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'request_human_review',
      phase: 'human_review',
      reasonCode: 'missing_subagent_invocation',
    });

    await createCompletedInvocation(server, 'wf-next-action-v1', {
      id: 'inv-next-builder',
      subtaskId: 'st-api',
      role: 'executor',
      runner: 'codex',
      promptContract: 'codex-builder.v1',
      threadId: 'builder-thread-next',
      headSha: 'head-1',
      evidenceRefs: ['ev-next-impl'],
    });
    await createCompletedInvocation(server, 'wf-next-action-v1', {
      id: 'inv-next-evaluator',
      subtaskId: 'st-api',
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      threadId: 'evaluator-thread-next',
      headSha: 'head-1',
      evaluationRunId: 'eval-next-pass',
      readonlyPolicy: { enforced: true, violations: [] },
    });

    next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-v1/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 'complete_subtask',
      phase: 'completion',
      reasonCode: 'ok',
      inputs: {
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-next-pass',
        questionerOutputId: 'q-next-clear',
      },
    });
  });

  it('routes stale v1 evaluation evidence back to evaluator before starting Questioner runs', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-next-action-stale-head', root);
    await putSingleSubtaskGraph(server, 'wf-next-action-stale-head');
    await createAcceptedContract(server, 'wf-next-action-stale-head');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-next-action-stale-head/evidence',
      payload: {
        id: 'ev-stale-head-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/workflow-engine/planner.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-next-action-stale-head', 'st-api', 'ev-stale-head-impl');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-next-action-stale-head/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-stale-head-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-stale-head-session' },
      },
    });
    await recordPassingEvaluation(server, 'wf-next-action-stale-head', 'eval-stale-head-pass');

    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/v1/multi-agent/workflows/wf-next-action-stale-head',
      payload: { headSha: 'head-2' },
    });
    expect(patch.statusCode).toBe(200);

    const next = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-next-action-stale-head/next-action',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({
      action: 're_evaluate',
      reasonCode: 'head_sha_mismatch',
      inputs: {
        evaluationRunId: 'eval-stale-head-pass',
        expectedHeadSha: 'head-2',
        evaluationHeadSha: 'head-1',
      },
    });

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-next-action-stale-head/actions/ask_claude_question_evaluation/run',
      payload: {
        subtaskId: 'st-api',
        headSha: 'head-2',
      },
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().plannedAction.action).toBe('re_evaluate');
  });

  it('runs planned questioner actions through the generic action executor', async () => {
    const root = await makeTempWorkspace();
    const server = await createTestServer(root);
    servers.push(server);

    await createV1Workflow(server, 'wf-run-action-questioner', root);
    await putSingleSubtaskGraph(server, 'wf-run-action-questioner');
    await createAcceptedContract(server, 'wf-run-action-questioner');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-run-action-questioner/evidence',
      payload: {
        id: 'ev-run-action-impl',
        kind: 'implementation',
        title: 'Codex Builder implementation',
        subtaskId: 'st-api',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/workflow-engine/planner.ts', changeType: 'modified' },
          ],
        },
      },
    });
    await moveSubtaskToQuestioningEvidence(server, 'wf-run-action-questioner', 'st-api', 'ev-run-action-impl');
    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-run-action-questioner/subtasks/st-api/evaluations',
      payload: {
        id: 'eval-run-action-pass',
        contractId: 'contract-st-api-v1',
        headSha: 'head-1',
        evaluator: { kind: 'codex-evaluator', sessionId: 'eval-run-action-session' },
      },
    });
    await recordPassingEvaluation(server, 'wf-run-action-questioner', 'eval-run-action-pass');

    const wrongAction = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-run-action-questioner/actions/complete_subtask/run',
      payload: {
        subtaskId: 'st-api',
        headSha: 'head-1',
      },
    });
    expect(wrongAction.statusCode).toBe(409);
    expect(wrongAction.json().guard).toMatchObject({
      accepted: false,
      code: 'invalid_transition',
    });
    expect(wrongAction.json().plannedAction.action).toBe('ask_claude_question_evaluation');

    const run = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-run-action-questioner/actions/ask_claude_question_evaluation/run',
      payload: {
        subtaskId: 'st-api',
        headSha: 'head-1',
        options: {
          id: 'qr-run-action',
          invocationId: 'inv-run-action-questioner',
          runtimeAudit: {
            gitStatusBefore: '',
          },
        },
      },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      action: 'ask_claude_question_evaluation',
      created: {
        kind: 'questioner_run',
        id: 'qr-run-action',
      },
      invocationId: 'inv-run-action-questioner',
      plannedAction: {
        phase: 'evaluation_questioning',
        inputs: {
          contractId: 'contract-st-api-v1',
          evaluationRunId: 'eval-run-action-pass',
        },
      },
    });
    expect(run.json().token).toMatch(/^tqr_/);

    const bundle = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-run-action-questioner',
    });
    expect(bundle.json().questionerRuns[0]).toMatchObject({
      id: 'qr-run-action',
      intent: 'question_evaluation',
      contractId: 'contract-st-api-v1',
      evaluationRunId: 'eval-run-action-pass',
      headSha: 'head-1',
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

    await recordClearQuestioner(server, 'wf-final-v1', 'q-final-clear', {
      invocationId: 'claude-final-q',
      subtaskId: undefined,
      intent: 'question_final_evidence',
      finalEvaluationRunId: 'eval-final-pass',
      contractId: undefined,
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
    await recordClearQuestioner(server, 'wf-final-thin-evidence', 'q-final-thin-clear', {
      invocationId: 'claude-final-thin-q',
      subtaskId: undefined,
      intent: 'question_final_evidence',
      evaluationRunId: 'eval-final-thin',
      contractId: undefined,
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
  await createDraftContract(server, workflowId, options);

  return server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/subtasks/st-api/contracts/contract-st-api-v1/accept`,
    payload: {
      acceptedBy: 'codex-workflow-plugin',
      headShaAtAcceptance: 'head-1',
    },
  });
}

async function createDraftContract(
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
  return contract;
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
  options: {
    commandResults?: any[];
  } = {},
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
        commandResults: options.commandResults || [
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
    invocationId?: string;
    evaluationRunId?: string;
    finalEvaluationRunId?: string;
    contractId?: string;
    headSha?: string;
    subtaskId?: string;
    intent?: 'question_evaluation' | 'question_final_evidence' | 'question_contract';
  } = {},
) {
  const intent = options.intent || 'question_evaluation';
  const subtaskId = Object.hasOwn(options, 'subtaskId')
    ? options.subtaskId
    : intent === 'question_final_evidence'
    ? undefined
    : 'st-api';
  const invocationId = options.invocationId || `inv-${questionerId}`;
  const finalEvaluationRunId = intent === 'question_final_evidence'
    ? options.finalEvaluationRunId || options.evaluationRunId || 'eval-final-pass'
    : undefined;
  const evaluationRunId = Object.hasOwn(options, 'evaluationRunId')
    ? (intent === 'question_final_evidence' ? undefined : options.evaluationRunId)
    : finalEvaluationRunId
      ? undefined
      : 'eval-pass';
  const contractId = Object.hasOwn(options, 'contractId')
    ? options.contractId
    : intent === 'question_final_evidence' ? undefined : 'contract-st-api-v1';
  const createdRun = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/questioner-runs`,
    payload: {
      id: `qr-${questionerId}`,
      invocationId,
      subtaskId,
      intent,
      contractId,
      evaluationRunId,
      finalEvaluationRunId,
      headSha: options.headSha || 'head-1',
      start: true,
      runtimeAudit: { gitStatusBefore: '' },
    },
  });
  expect(createdRun.statusCode).toBe(200);
  const output = buildQuestionerOutputV2({
    id: questionerId,
    runResponse: createdRun.json(),
    workflowId,
    subtaskId,
    intent,
    headSha: options.headSha || 'head-1',
    evaluationRunId,
    finalEvaluationRunId,
    contractId,
    verdict: 'evidence_sufficient',
    coverageMatrix: intent === 'question_final_evidence'
      ? [
        {
          criterionId: 'global-ac-1',
          criterionText: 'Workflow global acceptance criterion is covered.',
          required: true,
          status: 'covered',
          evidenceRefs: [finalEvaluationRunId || evaluationRunId || 'eval-final-pass'],
          comment: 'Final evaluation evidence covers the global criterion.',
        },
      ]
      : [
        {
          criterionId: 'ac-1',
          criterionText: 'API responds with expected payload.',
          required: true,
          status: 'covered',
          evidenceRefs: [evaluationRunId || 'eval-pass', 'ac-1'],
          comment: 'Evaluator criteria result and command evidence cover the must criterion.',
        },
      ],
  });
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/multi-agent/workflows/${workflowId}/questioner-runs/${createdRun.json().questionerRunId}/output`,
    headers: {
      authorization: `Bearer ${createdRun.json().token}`,
    },
    payload: { output, runtimeAudit: { gitStatusAfter: '' } },
  });
  expect(response.statusCode).toBe(200);
}

async function createCompletedQuestionerInvocation(
  server: { inject: (input: any) => Promise<any> },
  workflowId: string,
  input: {
    id: string;
    subtaskId?: string;
    intent: 'question_contract' | 'question_evaluation' | 'question_final_evidence';
    headSha: string;
    evaluationRunId?: string;
    finalEvaluationRunId?: string;
    contractId?: string;
    artifactRef: string;
    outputId?: string;
    verdict: 'need_clarification' | 'evidence_sufficient' | 'no_blocking_questions';
    questions?: Array<{
      id: string;
      priority: 'blocking' | 'important' | 'optional';
      question: string;
      whyItMatters: string;
      expectedAnswerType: 'test_case' | 'evidence';
    }>;
  },
) {
  const created = await createInvocationRecord(server, workflowId, {
    id: input.id,
    subtaskId: input.subtaskId,
    role: 'questioner',
    runner: 'claude-code',
    promptContract: 'claude-questioner.v1',
    input: {
      intent: input.intent,
      headSha: input.headSha,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
      contractId: input.contractId,
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
      headSha: input.headSha,
      evaluationRunId: input.evaluationRunId || input.finalEvaluationRunId,
      result: {
        questionerOutput: {
          ...(input.outputId ? { id: input.outputId } : {}),
          subtaskId: input.subtaskId,
          intent: input.intent,
          actor: { kind: 'claude-code-questioner', invocationId: input.id },
          source: 'claude-plugin',
          headSha: input.headSha,
          evaluationRunId: input.evaluationRunId,
          finalEvaluationRunId: input.finalEvaluationRunId,
          contractId: input.contractId,
          artifactRef: input.artifactRef,
          verdict: input.verdict,
          questions: input.questions || [],
          risks: [],
          missingTests: [],
          suggestedContractChanges: [],
        },
      },
    },
  });
  expect(completed.statusCode).toBe(200);
}

function buildQuestionerOutputV2(input: {
  id: string;
  runResponse: any;
  workflowId: string;
  subtaskId?: string;
  intent: 'question_contract' | 'question_evaluation' | 'question_final_evidence';
  headSha: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  contractId?: string;
  verdict: 'questions_blocking' | 'evidence_needed' | 'risk_found' | 'no_blocking_questions' | 'evidence_sufficient';
  coverageMatrix: Array<{
    criterionId: string;
    criterionText: string;
    required: boolean;
    status: 'covered' | 'partially_covered' | 'missing' | 'not_applicable';
    evidenceRefs: string[];
    comment: string;
  }>;
  questions?: Array<{
    id: string;
    priority: 'blocking' | 'evidence_needed' | 'advisory';
    category: 'ambiguous_requirement' | 'contract_gap' | 'coverage_gap' | 'missing_test' | 'weak_evidence' | 'head_mismatch' | 'artifact_gap';
    claim: string;
    evidenceRefs: string[];
    requestedFix?: string;
    requestedEvidence?: string;
    status: 'open';
  }>;
}) {
  const output = {
    schemaVersion: 'questioner-output.v2',
    id: input.id,
    questionerRunId: input.runResponse.questionerRunId,
    workflowId: input.workflowId,
    subtaskId: input.subtaskId,
    intent: input.intent,
    source: 'claude-plugin',
    actor: {
      kind: 'claude-code-questioner',
      invocationId: input.runResponse.invocationId,
      pluginName: 'agent-loop-claude-review',
      skillName: 'question-tik-agent-loop',
    },
    attestation: {
      headSha: input.headSha,
      contextArtifactRef: input.runResponse.contextArtifactRef,
      contextHash: input.runResponse.contextHash,
      outputArtifactRef: input.runResponse.expectedOutputArtifactRef,
      outputHash: '',
      generatedAt: '2026-07-01T00:02:00.000Z',
    },
    references: {
      contractId: input.contractId,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
    },
    verdict: input.verdict,
    coverageMatrix: input.coverageMatrix,
    questions: input.questions || [],
    risks: [],
    missingTests: [],
    advisoryNotes: [],
  };
  output.attestation.outputHash = canonicalQuestionerOutputHash(output);
  return output;
}

function canonicalQuestionerOutputHash(output: any): string {
  return `sha256:${createHash('sha256').update(stableStringify({
    ...output,
    attestation: {
      ...output.attestation,
      outputHash: '',
    },
    createdAt: undefined,
  })).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
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
      nonce: `nonce-${input.id}`,
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
