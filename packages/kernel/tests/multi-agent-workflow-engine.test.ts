import { describe, expect, it } from 'vitest';
import type { MultiAgentWorkflowBundle, WorkflowDecisionAction } from '@tik/shared';
import { tikV1Actions } from '../src/multi-agent/workflow-engine/action-registry.js';
import { planNextAction } from '../src/multi-agent/workflow-engine/planner.js';

describe('multi-agent workflow engine', () => {
  it('keeps v1 action registry metadata complete for runnable actions', () => {
    const actionIds = Object.keys(tikV1Actions) as WorkflowDecisionAction[];
    expect(actionIds).toContain('ask_claude_question_evaluation');
    expect(actionIds).toContain('complete_subtask');

    for (const actionId of actionIds) {
      const action = tikV1Actions[actionId];
      expect(action?.id).toBe(actionId);
      expect(action?.phase).toBeTruthy();
      expect(action?.handler).toBeTruthy();
      if (action?.kind === 'agent_invocation') {
        expect(action.runner).toBeTruthy();
      }
      if (actionId.startsWith('ask_claude_question_')) {
        expect(action?.intent).toBeTruthy();
        expect(action?.strictOutput).toBe('QuestionerOutputV2');
      }
    }
  });

  it('plans next v1 actions from shared strict predicates', () => {
    const bundle = buildBundle({
      contracts: [{
        id: 'contract-st-api-v1',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        version: 1,
        status: 'accepted',
        goal: 'Implement API',
        scope: { allowedPaths: ['packages/kernel/src'], blockedPaths: [] },
        deliverables: [],
        acceptanceCriteria: [],
        verificationPlan: { commands: [] },
        questionerOutputRefs: [],
        acceptedBy: 'codex-workflow-plugin',
        acceptedAt: '2026-07-03T00:00:00.000Z',
        headShaAtAcceptance: 'head-1',
      }],
      evidence: [{
        id: 'ev-impl',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        kind: 'implementation',
        title: 'Implementation',
        headSha: 'head-1',
        payload: {
          changedFiles: [
            { path: 'packages/kernel/src/multi-agent/workflow-engine/planner.ts', changeType: 'modified' },
          ],
        },
        createdAt: '2026-07-03T00:01:00.000Z',
      }],
      evaluationRuns: [{
        id: 'eval-pass',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        contractId: 'contract-st-api-v1',
        evaluator: { kind: 'codex-evaluator' },
        status: 'passed',
        headSha: 'head-1',
        readonlyPolicy: { enforced: true, allowedWritePaths: [], forbiddenWritePaths: [], violations: [] },
        artifactRefs: [],
        startedAt: '2026-07-03T00:02:00.000Z',
        result: {
          workflowId: 'wf-engine',
          subtaskId: 'st-api',
          contractId: 'contract-st-api-v1',
          evaluatorRunId: 'eval-pass',
          headSha: 'head-1',
          verdict: 'pass',
          criteriaResults: [],
          commandResults: [{
            command: 'pnpm --filter @tik/kernel test',
            status: 'passed',
            exitCode: 0,
            summary: 'Kernel tests passed.',
          }],
          runtimeFindings: [],
          coverageGaps: [],
          confidence: 0.9,
        },
      }],
    });

    expect(planNextAction({ bundle })).toMatchObject({
      action: 'ask_claude_question_evaluation',
      phase: 'evaluation_questioning',
      reasonCode: 'blocking_question_unresolved',
    });

    const strictBundle = buildBundle({
      ...bundle,
      questionerRuns: [{
        id: 'qr-clear',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        status: 'validated',
        invocationId: 'inv-q-clear',
        runner: 'claude-code',
        pluginSkill: 'question-tik-agent-loop',
        contractId: 'contract-st-api-v1',
        evaluationRunId: 'eval-pass',
        headSha: 'head-1',
        contextArtifactRef: 'context://qr-clear',
        contextHash: 'sha256:ctx-clear',
        expectedOutputArtifactRef: 'output://qr-clear',
        outputHash: 'sha256:out-clear',
        outputArtifactRef: 'output://qr-clear',
        tokenId: 'tok-clear',
        tokenHash: 'sha256:token-clear',
        tokenExpiresAt: '2026-07-03T01:00:00.000Z',
        runtimePolicy: { filesystem: 'read-only', network: 'tik-api-only', shell: 'read-only', permissionMode: 'dontAsk' },
        readonlyAudit: { enforced: true, allowedWritePaths: [], forbiddenWritePaths: [], violations: [] },
        createdAt: '2026-07-03T00:02:30.000Z',
        completedAt: '2026-07-03T00:03:00.000Z',
      }],
      invocations: [{
        id: 'inv-q-clear',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        role: 'questioner',
        runner: 'claude-code',
        promptContract: 'claude-questioner.v2',
        status: 'completed',
        headSha: 'head-1',
        evidenceRefs: [],
        readonlyPolicy: { enforced: true, allowedWritePaths: [], forbiddenWritePaths: [], violations: [] },
        createdAt: '2026-07-03T00:02:30.000Z',
        updatedAt: '2026-07-03T00:03:00.000Z',
      }],
      questionerOutputs: [{
        schemaVersion: 'questioner-output.v2',
        id: 'q-clear',
        questionerRunId: 'qr-clear',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        intent: 'question_evaluation',
        actor: { kind: 'claude-code-questioner', invocationId: 'inv-q-clear' },
        source: 'claude-plugin',
        headSha: 'head-1',
        evaluationRunId: 'eval-pass',
        contractId: 'contract-st-api-v1',
        artifactRef: 'output://qr-clear',
        attestation: {
          headSha: 'head-1',
          contextArtifactRef: 'context://qr-clear',
          contextHash: 'sha256:ctx-clear',
          outputArtifactRef: 'output://qr-clear',
          outputHash: 'sha256:out-clear',
          generatedAt: '2026-07-03T00:03:00.000Z',
        },
        references: {
          contractId: 'contract-st-api-v1',
          evaluationRunId: 'eval-pass',
        },
        coverageMatrix: [{
          criterionId: 'ac-1',
          criterionText: 'API works',
          required: true,
          status: 'covered',
          evidenceRefs: ['eval-pass'],
          comment: 'Covered by evaluator.',
        }],
        verdict: 'evidence_sufficient',
        questions: [],
        risks: [],
        missingTests: [],
        suggestedContractChanges: [],
        createdAt: '2026-07-03T00:03:00.000Z',
      }],
    });

    expect(planNextAction({ bundle: strictBundle })).toMatchObject({
      action: 'request_human_review',
      phase: 'human_review',
      reasonCode: 'missing_subagent_invocation',
    });

    const guardedBundle = buildBundle({
      ...strictBundle,
      invocations: [
        {
          ...(strictBundle.invocations || [])[0],
          result: {
            questionerOutput: strictBundle.questionerOutputs?.[0],
          },
        },
        {
          id: 'inv-builder',
          workflowId: 'wf-engine',
          subtaskId: 'st-api',
          role: 'executor',
          runner: 'codex',
          promptContract: 'codex-builder.v1',
          status: 'completed',
          headSha: 'head-1',
          evidenceRefs: ['ev-impl'],
          threadId: 'builder-thread',
          parentThreadId: 'workflow-parent-thread',
          actualSubagentThreadId: 'builder-thread',
          hookAttested: true,
          runtimeAttestation: {
            source: 'codex-plugin-hook',
            role: 'executor',
            nonce: 'nonce-builder',
            parentThreadId: 'workflow-parent-thread',
            actualSubagentThreadId: 'builder-thread',
            startedAt: '2026-07-03T00:01:00.000Z',
            stoppedAt: '2026-07-03T00:01:30.000Z',
          },
          createdAt: '2026-07-03T00:01:00.000Z',
          updatedAt: '2026-07-03T00:01:30.000Z',
          completedAt: '2026-07-03T00:01:30.000Z',
        },
        {
          id: 'inv-evaluator',
          workflowId: 'wf-engine',
          subtaskId: 'st-api',
          role: 'evaluator',
          runner: 'codex-evaluator',
          promptContract: 'codex-evaluator.v1',
          status: 'completed',
          headSha: 'head-1',
          evaluationRunId: 'eval-pass',
          readonlyPolicy: { enforced: true, allowedWritePaths: [], forbiddenWritePaths: [], violations: [] },
          threadId: 'evaluator-thread',
          parentThreadId: 'workflow-parent-thread',
          actualSubagentThreadId: 'evaluator-thread',
          hookAttested: true,
          runtimeAttestation: {
            source: 'codex-plugin-hook',
            role: 'evaluator',
            nonce: 'nonce-evaluator',
            parentThreadId: 'workflow-parent-thread',
            actualSubagentThreadId: 'evaluator-thread',
            startedAt: '2026-07-03T00:02:00.000Z',
            stoppedAt: '2026-07-03T00:02:30.000Z',
          },
          createdAt: '2026-07-03T00:02:00.000Z',
          updatedAt: '2026-07-03T00:02:30.000Z',
          completedAt: '2026-07-03T00:02:30.000Z',
        },
      ],
    });

    expect(planNextAction({ bundle: guardedBundle })).toMatchObject({
      action: 'complete_subtask',
      phase: 'completion',
      reasonCode: 'ok',
      inputs: {
        evaluationRunId: 'eval-pass',
        questionerOutputId: 'q-clear',
      },
    });
  });
});

function buildBundle(overrides: Partial<MultiAgentWorkflowBundle> = {}): MultiAgentWorkflowBundle {
  const base: MultiAgentWorkflowBundle = {
    workflow: {
      id: 'wf-engine',
      driver: 'codex-workflow',
      status: 'active',
      goal: 'Implement API',
      rootTaskId: 'root-wf-engine',
      currentHeadSha: 'head-1',
      maxRounds: 3,
      policy: {
        maxFixRoundsPerSubtask: 3,
        maxEvaluationRoundsPerSubtask: 3,
        requireQuestionerBeforeBuild: false,
        requireQuestionerAfterEvaluation: true,
        requireAcceptedContract: true,
        requireEvaluationPassForComplete: true,
        requireSameHeadShaForEvidence: true,
        allowHumanOverride: false,
      },
      createdAt: '2026-07-03T00:00:00.000Z',
      updatedAt: '2026-07-03T00:00:00.000Z',
    },
    taskGraph: {
      workflowId: 'wf-engine',
      version: 1,
      createdBy: 'codex-workflow',
      risks: [],
      globalAcceptanceCriteria: [],
      finalValidationCommands: [],
      subtasks: [{
        id: 'st-api',
        title: 'API',
        goal: 'Implement API',
        dependsOn: [],
        allowedPaths: ['packages/kernel/src'],
        acceptanceCriteria: ['API works'],
        validationCommands: [],
        reviewFocus: [],
        assignedExecutor: 'codex',
        assignedReviewer: 'claude-code',
      }],
    },
    subtasks: {
      'st-api': {
        subtaskId: 'st-api',
        status: 'questioning_evidence',
        validationRunIds: [],
        evidenceRefs: ['ev-impl'],
        blockerFindingIds: [],
        fixRound: 0,
      },
    },
    contracts: [],
    evaluationRuns: [],
    questionerRuns: [],
    questionerOutputs: [],
    questionResolutions: [],
    decisions: [],
    evidence: [],
    invocations: [],
    events: [],
  };
  return {
    ...base,
    ...overrides,
    workflow: overrides.workflow || base.workflow,
    taskGraph: overrides.taskGraph === undefined ? base.taskGraph : overrides.taskGraph,
    subtasks: overrides.subtasks || base.subtasks,
    contracts: overrides.contracts || base.contracts,
    evaluationRuns: overrides.evaluationRuns || base.evaluationRuns,
    questionerRuns: overrides.questionerRuns || base.questionerRuns,
    questionerOutputs: overrides.questionerOutputs || base.questionerOutputs,
    questionResolutions: overrides.questionResolutions || base.questionResolutions,
    decisions: overrides.decisions || base.decisions,
    evidence: overrides.evidence || base.evidence,
    invocations: overrides.invocations || base.invocations,
    events: overrides.events || base.events,
  };
}
