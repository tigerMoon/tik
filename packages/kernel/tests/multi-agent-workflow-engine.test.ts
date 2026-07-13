import { describe, expect, it } from 'vitest';
import type { MultiAgentWorkflowBundle, WorkflowDecisionAction } from '@tik/shared';
import { tikV1Actions } from '../src/multi-agent/workflow-engine/action-registry.js';
import { planNextAction } from '../src/multi-agent/workflow-engine/planner.js';
import { decideNextAction } from '../../../codex-skill/tik-multi-agent-workflow/lib/loop-gate.mjs';

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

  it('plans readonly review workflows without contracts or builder execution', () => {
    const reviewBundle = buildBundle({
      workflow: {
        ...buildBundle().workflow,
        mode: 'review',
        goal: 'Review the pinned merge request',
        policy: {
          ...buildBundle().workflow.policy!,
          requireAcceptedContract: false,
        },
      } as MultiAgentWorkflowBundle['workflow'],
      taskGraph: {
        ...buildBundle().taskGraph!,
        subtasks: [{
          ...buildBundle().taskGraph!.subtasks[0],
          kind: 'review',
          goal: 'Review API changes',
          expectedChangedFiles: undefined,
          assignedReviewer: 'codex',
        }],
      },
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'ready',
          validationRunIds: [],
          evidenceRefs: [],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
      contracts: [],
      evidence: [],
      evaluationRuns: [],
      questionerOutputs: [],
    });

    const first = planNextAction({ bundle: reviewBundle });
    expect(first).toMatchObject({
      action: 'run_readonly_reviewer',
      phase: 'review',
      subtaskId: 'st-api',
    });
    expect(first.action).not.toBe('draft_contract');
    expect(first.action).not.toBe('execute_subtask');

    const reviewed = buildBundle({
      ...reviewBundle,
      subtasks: {
        'st-api': {
          ...reviewBundle.subtasks['st-api'],
          status: 'reviewed',
          evidenceRefs: ['ev-review'],
        },
      },
      evidence: [{
        id: 'ev-review',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        kind: 'review',
        title: 'Readonly review candidates',
        headSha: 'head-1',
        payload: { findings: [] },
        createdAt: '2026-07-03T00:01:00.000Z',
      }],
    });
    expect(planNextAction({ bundle: reviewed })).toMatchObject({
      action: 'run_codex_evaluator',
      phase: 'evaluation',
      subtaskId: 'st-api',
      inputs: { reviewEvidenceId: 'ev-review' },
    });

    const completed = buildBundle({
      ...reviewBundle,
      subtasks: {
        'st-api': {
          ...reviewBundle.subtasks['st-api'],
          status: 'done',
          evidenceRefs: ['ev-review'],
        },
      },
      evidence: reviewed.evidence,
    });
    expect(planNextAction({ bundle: completed })).toMatchObject({
      action: 'synthesize_review',
      phase: 'synthesis',
    });
    const synthesized = buildBundle({
      ...completed,
      evidence: [
        ...completed.evidence,
        {
          id: 'ev-synthesis',
          workflowId: 'wf-engine',
          kind: 'synthesis',
          title: 'Review synthesis',
          headSha: 'head-1',
          createdAt: '2026-07-03T00:05:00.000Z',
        },
      ],
    });
    expect(planNextAction({ bundle: synthesized })).toMatchObject({
      action: 'complete_workflow',
      phase: 'workflow_completion',
      inputs: { synthesisEvidenceId: 'ev-synthesis' },
    });
  });

  it('waits for an in-flight native Builder instead of planning a duplicate launch', () => {
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
      invocations: [{
        id: 'inv-builder-running',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        status: 'started',
        evidenceRefs: [],
        createdAt: '2026-07-03T00:01:00.000Z',
        updatedAt: '2026-07-03T00:01:00.000Z',
      }],
      evidence: [],
      evaluationRuns: [],
    });

    expect(planNextAction({ bundle })).toMatchObject({
      action: 'execute_subtask',
      reasonCode: 'awaiting_native_runtime',
      inputs: { invocationId: 'inv-builder-running' },
    });
  });

  it('keeps the Codex skill offline fallback aligned with canonical Kernel planning fixtures', () => {
    const draftContract = buildBundle({
      contracts: [],
      evaluationRuns: [],
      evidence: [],
      questionerOutputs: [],
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'ready',
          validationRunIds: [],
          evidenceRefs: [],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
    });
    const acceptContract = buildBundle({
      contracts: [{
        id: 'contract-st-api-v1',
        workflowId: 'wf-engine',
        subtaskId: 'st-api',
        version: 1,
        status: 'draft',
        goal: 'Implement API',
        scope: { allowedPaths: ['packages/kernel/src'], blockedPaths: [] },
        deliverables: [],
        acceptanceCriteria: [],
        verificationPlan: { commands: [] },
        questionerOutputRefs: [],
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
      }],
      evaluationRuns: [],
      evidence: [],
      questionerOutputs: [],
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'contract_drafting',
          validationRunIds: [],
          evidenceRefs: [],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
    });
    const runEvaluator = buildBundle({
      contracts: [acceptedContractFixture()],
      evaluationRuns: [],
      evidence: [implementationEvidenceFixture()],
      questionerOutputs: [],
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'implemented',
          validationRunIds: [],
          evidenceRefs: ['ev-impl'],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
    });
    const askQuestioner = buildBundle({
      contracts: [acceptedContractFixture()],
      evaluationRuns: [passingEvaluationFixture()],
      evidence: [implementationEvidenceFixture()],
      questionerOutputs: [],
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'evaluation_passed',
          validationRunIds: [],
          evidenceRefs: ['ev-impl'],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
    });
    const finalEvaluation = buildBundle({
      contracts: [acceptedContractFixture()],
      evaluationRuns: [],
      evidence: [implementationEvidenceFixture()],
      questionerOutputs: [],
      subtasks: {
        'st-api': {
          subtaskId: 'st-api',
          status: 'done',
          validationRunIds: [],
          evidenceRefs: ['ev-impl'],
          blockerFindingIds: [],
          fixRound: 0,
        },
      },
    });

    for (const [name, bundle] of [
      ['draft contract', draftContract],
      ['accept contract', acceptContract],
      ['run evaluator', runEvaluator],
      ['ask questioner', askQuestioner],
      ['final evaluation', finalEvaluation],
    ] satisfies Array<[string, MultiAgentWorkflowBundle]>) {
      const planned = planNextAction({ bundle });
      const fallback = decideNextAction(bundle);
      expect(projectNextAction(fallback), name).toEqual(projectNextAction(planned));
    }
  });
});

function projectNextAction(action: {
  action: string;
  subtaskId?: string;
  evidenceRefs?: string[];
  inputs?: Record<string, unknown>;
}) {
  return {
    action: action.action,
    subtaskId: action.subtaskId,
    evidenceRefs: action.evidenceRefs || [],
    inputs: Object.fromEntries(
      Object.entries(action.inputs || {})
        .filter(([key]) => [
          'contractId',
          'evaluationRunId',
          'implementationEvidenceId',
          'taskGraphVersion',
          'title',
        ].includes(key))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function acceptedContractFixture() {
  return {
    id: 'contract-st-api-v1',
    workflowId: 'wf-engine',
    subtaskId: 'st-api',
    version: 1,
    status: 'accepted' as const,
    goal: 'Implement API',
    scope: { allowedPaths: ['packages/kernel/src'], blockedPaths: [] },
    deliverables: [],
    acceptanceCriteria: [],
    verificationPlan: { commands: [] },
    questionerOutputRefs: [],
    acceptedBy: 'codex-workflow-plugin',
    acceptedAt: '2026-07-03T00:00:00.000Z',
    headShaAtAcceptance: 'head-1',
  };
}

function implementationEvidenceFixture() {
  return {
    id: 'ev-impl',
    workflowId: 'wf-engine',
    subtaskId: 'st-api',
    kind: 'implementation' as const,
    title: 'Implementation',
    headSha: 'head-1',
    payload: {
      changedFiles: [
        { path: 'packages/kernel/src/multi-agent/workflow-engine/planner.ts', changeType: 'modified' },
      ],
    },
    createdAt: '2026-07-03T00:01:00.000Z',
  };
}

function passingEvaluationFixture() {
  return {
    id: 'eval-pass',
    workflowId: 'wf-engine',
    subtaskId: 'st-api',
    contractId: 'contract-st-api-v1',
    evaluator: { kind: 'codex-evaluator' as const },
    status: 'passed' as const,
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
      verdict: 'pass' as const,
      criteriaResults: [],
      commandResults: [{
        command: 'pnpm --filter @tik/kernel test',
        status: 'passed' as const,
        exitCode: 0,
        summary: 'Kernel tests passed.',
      }],
      runtimeFindings: [],
      coverageGaps: [],
      confidence: 0.9,
    },
  };
}

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
