import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateId,
  type AgentInvocationRecord,
  type CodexEvaluationResult,
  type CreateMultiAgentWorkflowInput,
  type EvaluationRun,
  type GuardResult,
  type HumanOverrideRecord,
  type MultiAgentInvocationStatus,
  type MultiAgentWorkflowBundle,
  type MultiAgentWorkflowEvent,
  type MultiAgentWorkflowEventType,
  type MultiAgentWorkflowEvidence,
  type MultiAgentWorkflowRecord,
  type QuestionerOutput,
  type SprintContract,
  type SubtaskRunState,
  type SubtaskRunStatus,
  type TaskGraph,
  type WorkflowContextSnapshot,
  type WorkflowDecision,
  type WorkflowPolicy,
} from '@tik/shared';

const SUBTASK_TRANSITIONS: Record<SubtaskRunStatus, SubtaskRunStatus[]> = {
  pending: ['ready', 'blocked', 'human_review_required'],
  ready: ['contract_drafting', 'executing', 'blocked', 'human_review_required'],
  contract_drafting: ['contract_questioning', 'contract_accepted', 'blocked', 'human_review_required'],
  contract_questioning: ['contract_drafting', 'contract_accepted', 'blocked', 'human_review_required'],
  contract_accepted: ['building', 'executing', 'blocked', 'human_review_required'],
  building: ['implemented', 'validation_failed', 'blocked', 'human_review_required'],
  executing: ['implemented', 'validation_failed', 'blocked', 'human_review_required'],
  implemented: ['evaluating', 'validating', 'validated', 'approved', 'reviewing', 'validation_failed', 'blocked', 'human_review_required'],
  evaluating: ['evaluation_failed', 'evaluation_passed', 'validation_failed', 'validated', 'blocked', 'human_review_required'],
  evaluation_failed: ['needs_fix', 'fixing', 'building', 'executing', 'implemented', 'blocked', 'human_review_required'],
  evaluation_passed: ['questioning_evidence', 'reviewing', 'done', 'blocked', 'human_review_required'],
  validating: ['validated', 'approved', 'validation_failed', 'blocked', 'human_review_required'],
  validated: ['reviewing', 'questioning_evidence', 'done', 'blocked', 'human_review_required'],
  validation_failed: ['executing', 'implemented', 'blocked', 'human_review_required'],
  questioning_evidence: ['needs_fix', 'evaluating', 'evaluation_failed', 'done', 'blocked', 'human_review_required'],
  reviewing: ['implemented', 'needs_fix', 'review_approved', 'approved', 'done', 'blocked', 'human_review_required'],
  needs_fix: ['fixing', 'executing', 'implemented', 'blocked', 'human_review_required'],
  fixing: ['implemented', 'reviewing', 'blocked', 'human_review_required'],
  review_approved: ['done', 'blocked', 'human_review_required'],
  approved: ['reviewing', 'done', 'blocked', 'human_review_required'],
  done: ['human_review_required'],
  blocked: ['ready', 'executing', 'human_review_required'],
  human_review_required: [],
};

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  maxFixRoundsPerSubtask: 3,
  maxEvaluationRoundsPerSubtask: 3,
  requireQuestionerBeforeBuild: false,
  requireQuestionerAfterEvaluation: false,
  requireAcceptedContract: false,
  requireEvaluationPassForComplete: false,
  requireSameHeadShaForEvidence: true,
  allowClaudeFinalReview: true,
  allowHumanOverride: false,
};

const DEFAULT_SNAPSHOT_MAX_CHARS: Record<WorkflowContextSnapshot['target'], number> = {
  main: 4000,
  builder: 6000,
  evaluator: 8000,
  questioner: 6000,
};

const INVOCATION_TRANSITIONS: Record<MultiAgentInvocationStatus, MultiAgentInvocationStatus[]> = {
  created: ['started', 'cancelled'],
  started: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class MultiAgentCoordinationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MultiAgentCoordinationError';
  }
}

interface CreateAgentInvocationInput {
  id?: string;
  workflowId?: string;
  subtaskId?: string;
  role: AgentInvocationRecord['role'];
  runner: AgentInvocationRecord['runner'];
  promptContract: string;
  input?: Record<string, unknown>;
  allowedPaths?: string[];
  validationCommands?: string[];
  threadId?: string;
  actualSubagentThreadId?: string;
  parentThreadId?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
}

interface HookStartInvocationInput {
  attestationToken: string;
  parentThreadId: string;
  actualSubagentThreadId: string;
  role: AgentInvocationRecord['role'];
  startedAt?: string;
}

interface HookStopInvocationInput {
  attestationToken: string;
  stoppedAt?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
  result?: Record<string, unknown>;
  status?: Extract<MultiAgentInvocationStatus, 'completed' | 'failed' | 'cancelled'>;
  error?: string;
}

export class FileMultiAgentWorkflowStore {
  constructor(private readonly rootPath: string) {}

  async createWorkflow(input: CreateMultiAgentWorkflowInput): Promise<MultiAgentWorkflowRecord> {
    if (!input.goal?.trim()) {
      throw new MultiAgentCoordinationError('invalid_workflow', 'Workflow goal is required.');
    }

    const id = this.normalizeId(input.id || `wf_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${generateId().slice(0, 8)}`);
    const existing = await this.readWorkflow(id);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const workflow: MultiAgentWorkflowRecord = {
      id,
      driver: 'codex-workflow',
      status: 'active',
      goal: input.goal,
      rootTaskId: input.rootTaskId || id,
      repo: input.repo,
      baseRef: input.baseRef,
      headRef: input.headRef,
      currentHeadSha: input.headSha,
      maxRounds: input.maxRounds ?? 3,
      policy: {
        ...DEFAULT_WORKFLOW_POLICY,
        maxFixRoundsPerSubtask: input.maxRounds ?? DEFAULT_WORKFLOW_POLICY.maxFixRoundsPerSubtask,
        ...input.policy,
      },
      workspaceBinding: input.workspaceBinding,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
    await this.writeWorkflow(workflow);
    await this.appendEvent(workflow.id, 'workflow.created', 'tik', { workflowId: workflow.id });
    return workflow;
  }

  async readWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord | null> {
    return this.readJsonFile<MultiAgentWorkflowRecord>(this.workflowFile(this.normalizeId(workflowId)));
  }

  async updateWorkflow(
    workflowId: string,
    patch: Partial<Pick<MultiAgentWorkflowRecord, 'status' | 'currentHeadSha' | 'metadata' | 'pauseReason'>> & {
      policy?: Partial<WorkflowPolicy>;
    },
  ): Promise<MultiAgentWorkflowRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.requireWorkflow(id);
    if (
      patch.status
      && (patch.status === 'blocked' || patch.status === 'human_review_required')
      && existing.status !== patch.status
    ) {
      throw new MultiAgentCoordinationError(
        'invalid_transition',
        `Workflow status ${patch.status} must be produced by a guard, stalled invocation, or human-review action.`,
      );
    }
    const now = new Date().toISOString();
    const workflow: MultiAgentWorkflowRecord = {
      ...existing,
      status: patch.status ?? existing.status,
      currentHeadSha: patch.currentHeadSha ?? existing.currentHeadSha,
      pauseReason: patch.pauseReason ?? existing.pauseReason,
      metadata: patch.metadata ?? existing.metadata,
      policy: patch.policy
        ? {
          ...(existing.policy || DEFAULT_WORKFLOW_POLICY),
          ...patch.policy,
          loopContract: patch.policy.loopContract
            ? normalizeLoopContract(id, patch.policy.loopContract)
            : existing.policy?.loopContract,
          snapshotMaxChars: patch.policy.snapshotMaxChars
            ? {
              ...(existing.policy?.snapshotMaxChars || {}),
              ...patch.policy.snapshotMaxChars,
            }
            : existing.policy?.snapshotMaxChars,
        }
        : existing.policy,
      updatedAt: now,
      completedAt: patch.status === 'completed' ? now : existing.completedAt,
      abortedAt: patch.status === 'aborted' ? now : existing.abortedAt,
    };
    assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
    await this.writeWorkflow(workflow);
    if (patch.status === 'completed') {
      await this.appendEvent(id, 'workflow.completed', 'tik', { workflowId: id });
    } else if (patch.status === 'aborted') {
      await this.appendEvent(id, 'workflow.aborted', 'tik', { workflowId: id });
    }
    if (patch.policy) {
      await this.appendEvent(id, 'workflow.policy.updated', 'tik', {
        workflowId: id,
        hasLoopContract: Boolean(workflow.policy?.loopContract),
      });
    }
    return workflow;
  }

  async readBundle(workflowId: string): Promise<MultiAgentWorkflowBundle | null> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.readWorkflow(id);
    if (!workflow) {
      return null;
    }

    return {
      workflow,
      taskGraph: await this.readTaskGraphForWorkflow(workflow),
      subtasks: await this.readSubtasks(id),
      contracts: await this.readContracts(id),
      evaluationRuns: await this.readEvaluationRuns(id),
      questionerOutputs: await this.readQuestionerOutputs(id),
      decisions: await this.readJsonLines<WorkflowDecision>(this.decisionsFile(id)),
      evidence: await this.readEvidence(id),
      invocations: await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(id)),
      events: await this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(id)),
    };
  }

  async putTaskGraph(workflowId: string, graph: TaskGraph): Promise<{ graph: TaskGraph; subtasks: Record<string, SubtaskRunState> }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    if (graph.workflowId !== id) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `TaskGraph workflowId ${graph.workflowId} does not match workflow ${id}.`);
    }
    if (!Number.isFinite(graph.version) || graph.version < 1) {
      throw new MultiAgentCoordinationError('invalid_task_graph', 'TaskGraph version must be a positive number.');
    }
    if (!Array.isArray(graph.subtasks) || graph.subtasks.length === 0) {
      throw new MultiAgentCoordinationError('invalid_task_graph', 'TaskGraph must contain at least one subtask.');
    }

    const duplicate = findDuplicate(graph.subtasks.map((subtask) => subtask.id));
    if (duplicate) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `Duplicate subtask id: ${duplicate}.`);
    }

    const existingSubtasks = await this.readSubtasks(id);
    const subtasks = buildSubtaskStatesForGraph(graph, existingSubtasks);
    await this.writeJsonFileAtomic(this.taskGraphFile(id, graph.version), graph);
    await this.writeJsonFileAtomic(this.subtasksFile(id), subtasks);
    await this.writeWorkflow({
      ...workflow,
      taskGraphVersion: graph.version,
      updatedAt: new Date().toISOString(),
    });
    await this.appendEvent(id, 'task_graph.created', 'tik', {
      version: graph.version,
      subtaskCount: graph.subtasks.length,
    });

    return { graph, subtasks };
  }

  async updateSubtask(
    workflowId: string,
    subtaskId: string,
    patch: Partial<SubtaskRunState>,
  ): Promise<SubtaskRunState> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    const subtasks = await this.readSubtasks(id);
    const existing = subtasks[subtaskId];
    if (!existing) {
      throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${subtaskId}.`);
    }

    const nextStatus = patch.status ?? existing.status;
    assertSubtaskTransition(existing.status, nextStatus);

    const updated: SubtaskRunState = {
      ...existing,
      ...patch,
      subtaskId,
      reviewRoundIds: mergeUnique(existing.reviewRoundIds, patch.reviewRoundIds),
      validationRunIds: mergeUnique(existing.validationRunIds, patch.validationRunIds),
      evidenceRefs: mergeUnique(existing.evidenceRefs, patch.evidenceRefs),
      blockerFindingIds: mergeUnique(existing.blockerFindingIds, patch.blockerFindingIds),
      fixRound: patch.fixRound ?? existing.fixRound,
    };
    subtasks[subtaskId] = updated;
    await this.writeJsonFileAtomic(this.subtasksFile(id), subtasks);
    await this.writeWorkflow({
      ...workflow,
      updatedAt: new Date().toISOString(),
    });
    await this.appendEvent(id, 'subtask.updated', 'codex-workflow', {
      subtaskId,
      status: updated.status,
    });
    return updated;
  }

  async recordDecision(workflowId: string, decision: WorkflowDecision): Promise<WorkflowDecision> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    await fs.mkdir(this.workflowDir(id), { recursive: true });
    await fs.appendFile(this.decisionsFile(id), `${JSON.stringify(decision)}\n`, 'utf-8');

    const now = new Date().toISOString();
    const nextWorkflow: MultiAgentWorkflowRecord = {
      ...workflow,
      lastDecisionId: decision.id,
      status: decision.action === 'complete_workflow'
        ? 'completed'
        : decision.action === 'abort_workflow'
          ? 'aborted'
          : workflow.status,
      updatedAt: now,
      completedAt: decision.action === 'complete_workflow' ? now : workflow.completedAt,
      abortedAt: decision.action === 'abort_workflow' ? now : workflow.abortedAt,
    };
    await this.writeWorkflow(nextWorkflow);
    await this.appendEvent(id, 'decision.recorded', 'codex-workflow', {
      decisionId: decision.id,
      action: decision.action,
      subtaskId: decision.subtaskId,
    });
    if (decision.action === 'complete_workflow') {
      await this.appendEvent(id, 'workflow.completed', 'codex-workflow', {
        decisionId: decision.id,
      });
    } else if (decision.action === 'abort_workflow') {
      await this.appendEvent(id, 'workflow.aborted', 'codex-workflow', {
        decisionId: decision.id,
      });
    }
    return decision;
  }

  async recordDecisionIfMatch(
    workflowId: string,
    decision: WorkflowDecision,
    expectedLastDecisionId?: string,
  ): Promise<{ decision?: WorkflowDecision; workflow: MultiAgentWorkflowRecord; guard: GuardResult }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    if (!lastDecisionMatches(workflow.lastDecisionId, expectedLastDecisionId)) {
      return {
        workflow,
        guard: {
          accepted: false,
          code: 'invalid_transition',
          message: `Decision history changed; expected ${expectedLastDecisionId || 'no last decision'}, current ${workflow.lastDecisionId || 'none'}.`,
          currentState: {
            expectedLastDecisionId,
            lastDecisionId: workflow.lastDecisionId,
          },
        },
      };
    }
    const recorded = await this.recordDecision(id, decision);
    return {
      decision: recorded,
      workflow: await this.requireWorkflow(id),
      guard: { accepted: true, code: 'ok' },
    };
  }

  async recordEvidence(
    workflowId: string,
    input: Omit<Partial<MultiAgentWorkflowEvidence>, 'workflowId' | 'createdAt'> & {
      kind: MultiAgentWorkflowEvidence['kind'];
      title: string;
    },
  ): Promise<MultiAgentWorkflowEvidence> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    const now = new Date().toISOString();
    const evidence: MultiAgentWorkflowEvidence = {
      id: this.normalizeId(input.id || `ev_${generateId()}`),
      workflowId: id,
      subtaskId: input.subtaskId,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      command: input.command,
      passed: input.passed,
      artifactRef: input.artifactRef,
      headSha: input.headSha,
      payload: input.payload,
      createdAt: now,
    };

    await fs.mkdir(this.evidenceDir(id), { recursive: true });
    await this.writeJsonFileAtomic(this.evidenceFile(id, evidence.id), evidence);
    if (evidence.headSha) {
      const workflow = await this.requireWorkflow(id);
      await this.writeWorkflow({
        ...workflow,
        currentHeadSha: evidence.headSha,
        updatedAt: now,
      });
    }
    await this.appendEvent(id, 'evidence.recorded', 'codex-workflow', {
      evidenceId: evidence.id,
      subtaskId: evidence.subtaskId,
      kind: evidence.kind,
    });
    return evidence;
  }

  async createContract(
    workflowId: string,
    subtaskId: string,
    input: Omit<Partial<SprintContract>, 'workflowId' | 'subtaskId'> & {
      goal: string;
      scope: SprintContract['scope'];
      deliverables: SprintContract['deliverables'];
      acceptanceCriteria: SprintContract['acceptanceCriteria'];
      verificationPlan: SprintContract['verificationPlan'];
      headShaAtAcceptance?: string;
    },
  ): Promise<SprintContract> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    await this.requireSubtask(id, subtaskId);
    const version = input.version ?? (await this.nextContractVersion(id, subtaskId));
    const contract: SprintContract = {
      id: this.normalizeId(input.id || `contract-${subtaskId}-v${version}`),
      workflowId: id,
      subtaskId,
      version,
      status: input.status || 'draft',
      goal: input.goal,
      scope: {
        allowedPaths: input.scope.allowedPaths || [],
        blockedPaths: input.scope.blockedPaths || [],
      },
      deliverables: input.deliverables || [],
      acceptanceCriteria: input.acceptanceCriteria || [],
      verificationPlan: {
        commands: input.verificationPlan.commands || [],
        playwrightScenarios: input.verificationPlan.playwrightScenarios,
        apiChecks: input.verificationPlan.apiChecks,
        dbChecks: input.verificationPlan.dbChecks,
        negativeChecks: input.verificationPlan.negativeChecks,
      },
      questionerOutputRefs: input.questionerOutputRefs || [],
      acceptedBy: input.acceptedBy,
      acceptedAt: input.acceptedAt,
      headShaAtAcceptance: input.headShaAtAcceptance || workflow.currentHeadSha || '',
    };

    await this.writeJsonFileAtomic(this.contractFile(id, subtaskId, contract.id), contract);
    await this.appendEvent(id, 'contract.created', 'codex-workflow', {
      contractId: contract.id,
      subtaskId,
      version: contract.version,
    });
    return contract;
  }

  async acceptContract(
    workflowId: string,
    subtaskId: string,
    contractId: string,
    input: {
      acceptedBy?: SprintContract['acceptedBy'];
      headShaAtAcceptance?: string;
      questionerOutputRefs?: string[];
    } = {},
  ): Promise<SprintContract> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    const contract = await this.requireContract(id, subtaskId, contractId);
    const now = new Date().toISOString();
    const accepted: SprintContract = {
      ...contract,
      status: 'accepted',
      acceptedBy: input.acceptedBy || 'codex-workflow-plugin',
      acceptedAt: now,
      headShaAtAcceptance: input.headShaAtAcceptance || contract.headShaAtAcceptance,
      questionerOutputRefs: mergeUnique(contract.questionerOutputRefs, input.questionerOutputRefs),
    };
    await this.writeJsonFileAtomic(this.contractFile(id, subtaskId, accepted.id), accepted);
    await this.appendEvent(id, 'contract.accepted', 'codex-workflow', {
      contractId: accepted.id,
      subtaskId,
      version: accepted.version,
    });
    return accepted;
  }

  async staleContract(workflowId: string, subtaskId: string, contractId: string): Promise<SprintContract> {
    const id = this.normalizeId(workflowId);
    const contract = await this.requireContract(id, subtaskId, contractId);
    const stale: SprintContract = {
      ...contract,
      status: 'stale',
    };
    await this.writeJsonFileAtomic(this.contractFile(id, subtaskId, stale.id), stale);
    await this.appendEvent(id, 'contract.staled', 'codex-workflow', {
      contractId: stale.id,
      subtaskId,
    });
    return stale;
  }

  async readLatestContract(workflowId: string, subtaskId: string): Promise<SprintContract | null> {
    const id = this.normalizeId(workflowId);
    const contracts = await this.readContracts(id, subtaskId);
    return contracts.sort((left, right) => right.version - left.version || right.id.localeCompare(left.id))[0] ?? null;
  }

  async createEvaluationRun(
    workflowId: string,
    subtaskId: string,
    input: Omit<Partial<EvaluationRun>, 'workflowId' | 'subtaskId' | 'startedAt'> & {
      contractId: string;
      headSha: string;
      evaluator?: EvaluationRun['evaluator'];
    },
  ): Promise<EvaluationRun> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    if (!isFinalEvaluationSubtask(subtaskId)) {
      await this.requireSubtask(id, subtaskId);
      await this.requireContract(id, subtaskId, input.contractId);
    }
    const runId = this.normalizeId(input.id || `eval-${subtaskId}-${generateId().slice(0, 8)}`);
    const run: EvaluationRun = {
      id: runId,
      workflowId: id,
      subtaskId,
      contractId: input.contractId,
      evaluator: input.evaluator || { kind: 'codex-evaluator' },
      status: input.status || 'created',
      headSha: input.headSha,
      readonlyPolicy: input.readonlyPolicy || defaultReadonlyPolicy(),
      result: input.result,
      artifactRefs: input.artifactRefs || [],
      startedAt: new Date().toISOString(),
      completedAt: input.completedAt,
    };
    await this.writeJsonFileAtomic(this.evaluationRunFile(id, subtaskId, run.id), run);
    await this.appendEvent(id, 'evaluation.created', 'codex-workflow', {
      evaluationRunId: run.id,
      subtaskId,
      contractId: run.contractId,
    });
    return run;
  }

  async updateEvaluationRun(
    workflowId: string,
    subtaskId: string,
    evaluationRunId: string,
    patch: Omit<Partial<EvaluationRun>, 'readonlyPolicy'> & {
      readonlyPolicy?: Partial<EvaluationRun['readonlyPolicy']>;
    },
  ): Promise<EvaluationRun> {
    const id = this.normalizeId(workflowId);
    const existing = await this.requireEvaluationRun(id, subtaskId, evaluationRunId);
    const updated: EvaluationRun = {
      ...existing,
      ...patch,
      readonlyPolicy: {
        ...existing.readonlyPolicy,
        ...patch.readonlyPolicy,
      },
      artifactRefs: mergeUnique(existing.artifactRefs, patch.artifactRefs),
      completedAt: patch.status && patch.status !== 'created' && patch.status !== 'running'
        ? patch.completedAt || new Date().toISOString()
        : patch.completedAt ?? existing.completedAt,
    };
    await this.writeJsonFileAtomic(this.evaluationRunFile(id, subtaskId, updated.id), updated);
    await this.appendEvent(id, 'evaluation.updated', 'codex-workflow', {
      evaluationRunId: updated.id,
      subtaskId,
      status: updated.status,
    });
    return updated;
  }

  async recordEvaluationResult(
    workflowId: string,
    subtaskId: string,
    evaluationRunId: string,
    result: CodexEvaluationResult,
  ): Promise<EvaluationRun> {
    const id = this.normalizeId(workflowId);
    const existing = await this.requireEvaluationRun(id, subtaskId, evaluationRunId);
    if (
      result.workflowId !== id
      || result.subtaskId !== subtaskId
      || result.evaluatorRunId !== evaluationRunId
      || result.contractId !== existing.contractId
    ) {
      throw new MultiAgentCoordinationError('invalid_evaluation_result', 'Evaluation result identity does not match the evaluation run.');
    }
    const normalizedResult = await this.normalizeEvaluationResultEvidence(id, subtaskId, existing, result);
    const resultStatus: EvaluationRun['status'] = normalizedResult.verdict === 'pass'
      ? 'passed'
      : normalizedResult.verdict === 'fail'
        ? 'failed'
        : normalizedResult.verdict === 'inconclusive'
          ? 'inconclusive'
          : 'failed';
    const status: EvaluationRun['status'] = existing.status === 'invalidated'
      || (existing.readonlyPolicy.violations?.length || 0) > 0
      ? 'invalidated'
      : resultStatus;
    const updated = await this.updateEvaluationRun(id, subtaskId, evaluationRunId, {
      status,
      result: normalizedResult,
      headSha: normalizedResult.headSha,
    });
    await this.appendEvent(id, 'evaluation.result.recorded', 'codex-workflow', {
      evaluationRunId,
      subtaskId,
      verdict: normalizedResult.verdict,
    });
    return updated;
  }

  private async normalizeEvaluationResultEvidence(
    workflowId: string,
    subtaskId: string,
    run: EvaluationRun,
    result: CodexEvaluationResult,
  ): Promise<CodexEvaluationResult> {
    const contract = isFinalEvaluationSubtask(subtaskId)
      ? null
      : await this.readJsonFile<SprintContract>(this.contractFile(workflowId, subtaskId, run.contractId));
    const mustCriteria = contract?.acceptanceCriteria.filter((criterion) => criterion.priority === 'must') || [];
    const criteriaResults = Array.isArray(result.criteriaResults) ? result.criteriaResults : [];
    const commandResults = Array.isArray(result.commandResults) ? result.commandResults : [];
    const runtimeFindings = Array.isArray(result.runtimeFindings) ? result.runtimeFindings : [];
    const coverageGaps = Array.isArray(result.coverageGaps) ? result.coverageGaps : [];
    const hasCommandEvidence = commandResults.some((command) => command.status !== 'skipped');
    const hasStructuredCriteriaEvidence = criteriaResults.some((criterion) =>
      criterion.status === 'pass'
        || criterion.status === 'fail'
        || (criterion.artifactRefs?.length || 0) > 0
        || (criterion.reproductionSteps?.length || 0) > 0
    );
    const hasArtifactEvidence = run.artifactRefs.length > 0
      || criteriaResults.some((criterion) => (criterion.artifactRefs?.length || 0) > 0)
      || commandResults.some((command) => Boolean(command.stdoutArtifactId || command.stderrArtifactId));
    const hasReproductionEvidence = criteriaResults.some((criterion) => (criterion.reproductionSteps?.length || 0) > 0)
      || runtimeFindings.some((finding) => finding.reproductionSteps.length > 0);
    const resultsByCriterion = new Map(criteriaResults.map((criterionResult) => [criterionResult.criterionId, criterionResult]));
    const missingMustCriteria = mustCriteria
      .filter((criterion) => resultsByCriterion.get(criterion.id)?.status !== 'pass')
      .map((criterion) => criterion.id);
    const insufficient = !hasCommandEvidence && !hasStructuredCriteriaEvidence && !hasArtifactEvidence && !hasReproductionEvidence;
    const missingEvidence = insufficient
      ? [{
        criterionId: 'all',
        description: 'Evaluator did not provide command, criteria, artifact, or reproduction evidence.',
        reason: 'No evaluator command, criteria result, or artifact evidence was provided.',
      }]
      : [];
    const missingCriteriaGaps = missingMustCriteria.map((criterionId) => ({
      criterionId,
      description: `Must acceptance criterion ${criterionId} was not proven by the evaluator.`,
      reason: 'Missing passing criteriaResult for a must acceptance criterion.',
    }));
    const nextCoverageGaps = mergeCoverageGaps(coverageGaps, [...missingEvidence, ...missingCriteriaGaps]);
    if (result.verdict === 'pass' && (nextCoverageGaps.length > 0 || missingMustCriteria.length > 0)) {
      return {
        ...result,
        verdict: 'inconclusive',
        criteriaResults,
        commandResults,
        runtimeFindings,
        coverageGaps: nextCoverageGaps,
        confidence: Math.min(result.confidence, 0.25),
      };
    }
    return {
      ...result,
      criteriaResults,
      commandResults,
      runtimeFindings,
      coverageGaps: nextCoverageGaps,
    };
  }

  async validateEvaluationReadonly(
    workflowId: string,
    subtaskId: string,
    evaluationRunId: string,
    input: {
      gitStatusBefore?: string;
      gitStatusAfter?: string;
      allowedWritePaths?: string[];
      forbiddenWritePaths?: string[];
    },
  ): Promise<{ evaluationRun: EvaluationRun; guard: GuardResult }> {
    const id = this.normalizeId(workflowId);
    const run = await this.requireEvaluationRun(id, subtaskId, evaluationRunId);
    const allowedWritePaths = input.allowedWritePaths || run.readonlyPolicy.allowedWritePaths || defaultReadonlyPolicy().allowedWritePaths;
    const forbiddenWritePaths = input.forbiddenWritePaths || run.readonlyPolicy.forbiddenWritePaths || defaultReadonlyPolicy().forbiddenWritePaths;
    const violations = detectReadonlyViolations(input.gitStatusBefore || '', input.gitStatusAfter || '', allowedWritePaths, forbiddenWritePaths);
    const readonlyPolicy: EvaluationRun['readonlyPolicy'] = {
      ...run.readonlyPolicy,
      enforced: true,
      allowedWritePaths,
      forbiddenWritePaths,
      violations,
      gitStatusBefore: input.gitStatusBefore,
      gitStatusAfter: input.gitStatusAfter,
    };
    const evaluationRun = await this.updateEvaluationRun(id, subtaskId, evaluationRunId, {
      status: violations.length > 0 ? 'invalidated' : run.status,
      readonlyPolicy,
    });
    await this.appendEvent(id, 'evaluation.readonly_validated', 'codex-workflow', {
      evaluationRunId,
      subtaskId,
      violationCount: violations.length,
    });
    return {
      evaluationRun,
      guard: violations.length > 0
        ? {
          accepted: false,
          code: 'readonly_policy_violated',
          message: `Evaluator wrote forbidden paths: ${violations.join(', ')}`,
          currentState: { violations },
        }
        : { accepted: true, code: 'ok' },
    };
  }

  async readLatestEvaluationRun(workflowId: string, subtaskId: string): Promise<EvaluationRun | null> {
    const id = this.normalizeId(workflowId);
    const runs = await this.readEvaluationRuns(id, subtaskId);
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
  }

  async recordQuestionerOutput(
    workflowId: string,
    input: Omit<Partial<QuestionerOutput>, 'workflowId' | 'createdAt'> & {
      intent: QuestionerOutput['intent'];
      actor: QuestionerOutput['actor'];
      source: QuestionerOutput['source'];
      headSha: string;
      evaluationRunId?: string;
      finalEvaluationRunId?: string;
      contractId?: string;
      artifactRef?: string;
      verdict: QuestionerOutput['verdict'];
      questions?: QuestionerOutput['questions'];
      risks?: QuestionerOutput['risks'];
      missingTests?: QuestionerOutput['missingTests'];
      suggestedContractChanges?: QuestionerOutput['suggestedContractChanges'];
    },
  ): Promise<QuestionerOutput> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    if (input.subtaskId) {
      await this.requireSubtask(id, input.subtaskId);
    }
    assertQuestionerRuntimeSource(input);
    const output: QuestionerOutput = {
      id: this.normalizeId(input.id || `q_${generateId()}`),
      workflowId: id,
      subtaskId: input.subtaskId,
      intent: input.intent,
      actor: input.actor,
      source: input.source,
      headSha: input.headSha,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
      contractId: input.contractId,
      artifactRef: input.artifactRef,
      verdict: input.verdict,
      questions: input.questions || [],
      risks: input.risks || [],
      missingTests: input.missingTests || [],
      suggestedContractChanges: input.suggestedContractChanges || [],
      createdAt: new Date().toISOString(),
    };
    await this.writeJsonFileAtomic(this.questionerOutputFile(id, output), output);
    await this.appendEvent(id, 'questioner.output.recorded', 'claude-code', {
      questionerOutputId: output.id,
      subtaskId: output.subtaskId,
      intent: output.intent,
      verdict: output.verdict,
    });
    return output;
  }

  async readLatestQuestionerOutput(
    workflowId: string,
    input: { subtaskId?: string; intent?: QuestionerOutput['intent'] },
  ): Promise<QuestionerOutput | null> {
    const id = this.normalizeId(workflowId);
    const outputs = await this.readQuestionerOutputs(id);
    return outputs
      .filter((output) => input.subtaskId === undefined || output.subtaskId === input.subtaskId)
      .filter((output) => input.intent === undefined || output.intent === input.intent)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  async createInvocation(workflowId: string, input: CreateAgentInvocationInput): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    const now = new Date().toISOString();
    const invocation: AgentInvocationRecord = {
      id: this.normalizeId(input.id || `inv_${generateId()}`),
      workflowId: id,
      subtaskId: input.subtaskId,
      role: input.role,
      runner: input.runner,
      promptContract: input.promptContract,
      input: input.input,
      allowedPaths: input.allowedPaths,
      validationCommands: input.validationCommands,
      threadId: input.threadId,
      actualSubagentThreadId: input.actualSubagentThreadId,
      parentThreadId: input.parentThreadId,
      headSha: input.headSha,
      evidenceRefs: input.evidenceRefs || [],
      evaluationRunId: input.evaluationRunId,
      readonlyPolicy: input.readonlyPolicy,
      attestationToken: requiresRuntimeAttestationInput(input) ? `att_${generateId()}` : undefined,
      hookAttested: requiresRuntimeAttestationInput(input) ? false : undefined,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
    await this.upsertInvocation(invocation);
    await this.appendEvent(id, 'agent_invocation.created', 'tik', {
      invocationId: invocation.id,
      role: invocation.role,
      runner: invocation.runner,
    });
    return invocation;
  }

  async saveContextSnapshot(
    workflowId: string,
    snapshot: Omit<Partial<WorkflowContextSnapshot>, 'workflowId'> & {
      workflowId?: string;
      headSha: string;
      target: WorkflowContextSnapshot['target'];
      objectiveSummary: string;
      completedSubtasks?: string[];
      unresolvedBlockers?: string[];
      artifactRefs?: string[];
      maxChars?: number;
    },
    expectedEtag?: string,
  ): Promise<{ snapshot: WorkflowContextSnapshot; guard: GuardResult }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    if (snapshot.workflowId && snapshot.workflowId !== id) {
      throw new MultiAgentCoordinationError('invalid_transition', `Snapshot workflowId ${snapshot.workflowId} does not match workflow ${id}.`);
    }
    const current = await this.readContextSnapshot(id, snapshot.target);
    if (expectedEtag && current?.etag && expectedEtag !== current.etag) {
      return {
        snapshot: current,
        guard: {
          accepted: false,
          code: 'invalid_transition',
          message: `Context snapshot ${snapshot.target} changed; expected etag ${expectedEtag}.`,
          currentState: {
            expectedEtag,
            etag: current.etag,
          },
        },
      };
    }

    const now = new Date().toISOString();
    const next: WorkflowContextSnapshot = {
      workflowId: id,
      headSha: snapshot.headSha,
      activeSubtaskId: snapshot.activeSubtaskId,
      target: snapshot.target,
      objectiveSummary: snapshot.objectiveSummary,
      completedSubtasks: snapshot.completedSubtasks || [],
      currentContractSummary: snapshot.currentContractSummary,
      latestImplementationSummary: snapshot.latestImplementationSummary,
      latestEvaluationSummary: snapshot.latestEvaluationSummary,
      latestQuestionerSummary: snapshot.latestQuestionerSummary,
      unresolvedBlockers: snapshot.unresolvedBlockers || [],
      nextActionHint: snapshot.nextActionHint,
      artifactRefs: snapshot.artifactRefs || [],
      markdownArtifactRef: snapshot.markdownArtifactRef,
      maxChars: snapshot.maxChars
        || workflow.policy?.snapshotMaxChars?.[snapshot.target]
        || DEFAULT_SNAPSHOT_MAX_CHARS[snapshot.target],
      createdAt: current?.createdAt || now,
      updatedAt: now,
      etag: `sn_${Date.now()}_${generateId().slice(0, 8)}`,
      renderedMarkdown: '',
    };
    next.renderedMarkdown = renderContextSnapshotMarkdown(next);

    await this.writeJsonFileAtomic(this.contextSnapshotFile(id, next.target), next);
    await this.writeLocalContextSnapshotMarkdown(id, next.target, next.renderedMarkdown);
    if (isSubstantiveSnapshotChange(current, next)) {
      await this.appendEvent(id, 'context_snapshot.recorded', 'codex-workflow', {
        target: next.target,
        etag: next.etag,
        headSha: next.headSha,
      });
    }
    return {
      snapshot: next,
      guard: { accepted: true, code: 'ok' },
    };
  }

  async readContextSnapshot(workflowId: string, target: WorkflowContextSnapshot['target']): Promise<WorkflowContextSnapshot | null> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    return this.readJsonFile<WorkflowContextSnapshot>(this.contextSnapshotFile(id, target));
  }

  async reconcileStalledInvocations(
    workflowId: string,
    input: { now?: string } = {},
  ): Promise<{
    workflow: MultiAgentWorkflowRecord;
    subtasks: Record<string, SubtaskRunState>;
    stalled: AgentInvocationRecord[];
  }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    const timeoutMs = workflow.policy?.stalledInvocationTimeoutMs ?? 30 * 60 * 1000;
    const nowMs = Date.parse(input.now || new Date().toISOString());
    const invocations = await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(id));
    const stalled: AgentInvocationRecord[] = [];
    for (const invocation of invocations) {
      if (invocation.status !== 'started') continue;
      const startedAt = Date.parse(invocation.startedAt || invocation.updatedAt || invocation.createdAt);
      if (!Number.isFinite(startedAt) || nowMs - startedAt <= timeoutMs) continue;
      const updated: AgentInvocationRecord = {
        ...invocation,
        status: 'failed',
        error: 'stalled',
        updatedAt: new Date(nowMs).toISOString(),
        completedAt: new Date(nowMs).toISOString(),
      };
      await this.upsertInvocation(updated);
      stalled.push(updated);
      await this.appendEvent(id, 'invocation.stalled', 'tik', {
        invocationId: updated.id,
        subtaskId: updated.subtaskId,
        role: updated.role,
      });
      if (updated.subtaskId) {
        const subtasks = await this.readSubtasks(id);
        const existing = subtasks[updated.subtaskId];
        if (existing) {
          const nextStatus: SubtaskRunStatus = updated.role === 'evaluator'
            ? 'human_review_required'
            : 'needs_fix';
          subtasks[updated.subtaskId] = {
            ...existing,
            status: nextStatus,
          };
          await this.writeJsonFileAtomic(this.subtasksFile(id), subtasks);
          await this.appendEvent(id, 'subtask.updated', 'tik', {
            subtaskId: updated.subtaskId,
            status: nextStatus,
            reason: 'stalled_invocation',
          });
        }
      }
    }

    let nextWorkflow = await this.requireWorkflow(id);
    if (stalled.length > 0) {
      const metadata = {
        ...(nextWorkflow.metadata || {}),
        stalledInvocationIds: stalled.map((item) => item.id),
      };
      const now = new Date(nowMs).toISOString();
      nextWorkflow = {
        ...nextWorkflow,
        status: 'blocked',
        pauseReason: 'awaiting_subagent',
        metadata,
        updatedAt: now,
      };
      await this.writeWorkflow(nextWorkflow);
    }
    return {
      workflow: nextWorkflow,
      subtasks: await this.readSubtasks(id),
      stalled,
    };
  }

  async recordHumanOverride(
    workflowId: string,
    input: {
      reason: string;
      approver: string;
      unblockAction: HumanOverrideRecord['unblockAction'];
      subtaskId?: string;
      note?: string;
    },
  ): Promise<{ workflow: MultiAgentWorkflowRecord; override: HumanOverrideRecord }> {
    const id = this.normalizeId(workflowId);
    const workflow = await this.requireWorkflow(id);
    if (!input.reason?.trim() || !input.approver?.trim()) {
      throw new MultiAgentCoordinationError('invalid_transition', 'Human override requires reason and approver.');
    }
    if (workflow.status !== 'blocked' && workflow.status !== 'human_review_required') {
      throw new MultiAgentCoordinationError(
        'invalid_transition',
        `Human override requires workflow status blocked or human_review_required; current status is ${workflow.status}.`,
      );
    }
    if (!workflow.policy?.allowHumanOverride) {
      throw new MultiAgentCoordinationError('requires_human_approval', 'Workflow policy does not allow human overrides.');
    }
    const guardRejection = readGuardRejectionFromMetadata(workflow.metadata);
    if (!guardRejection) {
      throw new MultiAgentCoordinationError('invalid_transition', 'Human override requires guard rejection audit context.');
    }
    let forcedSubtasks: Record<string, SubtaskRunState> | null = null;
    if (input.unblockAction === 'force_complete_subtask') {
      if (!input.subtaskId) {
        throw new MultiAgentCoordinationError('invalid_transition', 'force_complete_subtask requires subtaskId.');
      }
      const subtasks = await this.readSubtasks(id);
      const subtask = subtasks[input.subtaskId];
      if (!subtask) {
        throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${input.subtaskId}.`);
      }
      forcedSubtasks = {
        ...subtasks,
        [input.subtaskId]: {
          ...subtask,
          status: 'done',
          blockerFindingIds: [],
        },
      };
    }
    const now = new Date().toISOString();
    const override: HumanOverrideRecord = {
      id: `override_${generateId()}`,
      workflowId: id,
      reason: input.reason,
      approver: input.approver,
      unblockAction: input.unblockAction,
      subtaskId: input.subtaskId,
      note: input.note,
      guardRejection,
      createdAt: now,
    };
    await fs.mkdir(this.humanOverridesDir(id), { recursive: true });
    await this.writeJsonFileAtomic(this.humanOverrideFile(id, override.id), override);

    let nextStatus: MultiAgentWorkflowRecord['status'] = workflow.status;
    if (input.unblockAction === 'resume') nextStatus = 'active';
    if (input.unblockAction === 'abort') nextStatus = 'aborted';
    if (input.unblockAction === 'force_complete_subtask') nextStatus = 'active';
    if (input.unblockAction === 'force_complete_workflow') nextStatus = 'completed';

    if (input.unblockAction === 'force_complete_subtask') {
      await this.writeJsonFileAtomic(this.subtasksFile(id), forcedSubtasks!);
      await this.appendEvent(id, 'subtask.updated', 'human', {
        subtaskId: input.subtaskId,
        status: 'done',
        reason: 'human_override',
      });
    }

    const nextWorkflow: MultiAgentWorkflowRecord = {
      ...workflow,
      status: nextStatus,
      pauseReason: nextStatus === 'active' ? undefined : readPauseReason(workflow),
      metadata: {
        ...(workflow.metadata || {}),
        lastHumanOverrideId: override.id,
      },
      updatedAt: now,
      completedAt: input.unblockAction === 'force_complete_workflow' ? now : workflow.completedAt,
      abortedAt: input.unblockAction === 'abort' ? now : workflow.abortedAt,
    };
    await this.writeWorkflow(nextWorkflow);
    await this.appendEvent(id, 'workflow.human_override', 'human', {
      overrideId: override.id,
      approver: override.approver,
      unblockAction: override.unblockAction,
      subtaskId: override.subtaskId,
      guardRejection: override.guardRejection,
    });
    return {
      workflow: nextWorkflow,
      override,
    };
  }

  async readInvocation(workflowId: string, invocationId: string): Promise<AgentInvocationRecord | null> {
    const id = this.normalizeId(workflowId);
    const invocation = this.normalizeId(invocationId);
    const invocations = await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(id));
    return invocations.find((item) => item.id === invocation) ?? null;
  }

  async updateInvocation(
    workflowId: string,
    invocationId: string,
    patch: {
      status: MultiAgentInvocationStatus;
      result?: Record<string, unknown>;
      error?: string;
      threadId?: string;
      actualSubagentThreadId?: string;
      parentThreadId?: string;
      headSha?: string;
      evidenceRefs?: string[];
      evaluationRunId?: string;
      readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
    },
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.readInvocation(id, invocationId);
    if (!existing) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    assertInvocationTransition(existing.status, patch.status);
    if (requiresRuntimeAttestation(existing) && patch.status !== 'cancelled') {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} must be updated by hook attestation endpoints.`,
      );
    }

    const now = new Date().toISOString();
    const updated: AgentInvocationRecord = {
      ...existing,
      status: patch.status,
      result: patch.result ?? existing.result,
      error: patch.error ?? existing.error,
      threadId: patch.threadId
        ?? readStringFromRecord(patch.result, 'threadId')
        ?? existing.threadId,
      actualSubagentThreadId: patch.actualSubagentThreadId
        ?? readStringFromRecord(patch.result, 'actualSubagentThreadId')
        ?? existing.actualSubagentThreadId,
      parentThreadId: patch.parentThreadId
        ?? readStringFromRecord(patch.result, 'parentThreadId')
        ?? existing.parentThreadId,
      headSha: patch.headSha ?? readStringFromRecord(patch.result, 'headSha') ?? existing.headSha,
      evidenceRefs: mergeUnique(existing.evidenceRefs, patch.evidenceRefs ?? readStringArrayFromRecord(patch.result, 'evidenceRefs')),
      evaluationRunId: patch.evaluationRunId ?? readStringFromRecord(patch.result, 'evaluationRunId') ?? existing.evaluationRunId,
      readonlyPolicy: patch.readonlyPolicy ?? readReadonlyPolicyFromRecord(patch.result) ?? existing.readonlyPolicy,
      updatedAt: now,
      startedAt: patch.status === 'started' ? now : existing.startedAt,
      completedAt: patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled'
        ? now
        : existing.completedAt,
    };
    await this.upsertInvocation(updated);
    await this.appendEvent(
      id,
      patch.status === 'started' ? 'agent_invocation.started' : 'agent_invocation.completed',
      'tik',
      {
        invocationId: updated.id,
        status: updated.status,
      },
    );
    return updated;
  }

  async attestInvocationStart(
    workflowId: string,
    invocationId: string,
    input: HookStartInvocationInput,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.readInvocation(id, invocationId);
    if (!existing) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    if (!requiresRuntimeAttestation(existing)) {
      throw new MultiAgentCoordinationError('invalid_invocation_status', `Invocation ${invocationId} does not require hook attestation.`);
    }
    assertInvocationTransition(existing.status, 'started');
    assertValidAttestationToken(existing, input.attestationToken);
    if (input.role !== existing.role) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} runtime role ${input.role} does not match ${existing.role}.`,
      );
    }
    if (!input.parentThreadId || !input.actualSubagentThreadId) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} hook attestation must include parentThreadId and actualSubagentThreadId.`,
      );
    }

    const now = new Date().toISOString();
    const startedAt = input.startedAt || now;
    const runtimeAttestation: AgentInvocationRecord['runtimeAttestation'] = {
      source: 'codex-plugin-hook',
      parentThreadId: input.parentThreadId,
      actualSubagentThreadId: input.actualSubagentThreadId,
      role: existing.role,
      startedAt,
    };
    const updated: AgentInvocationRecord = {
      ...existing,
      status: 'started',
      threadId: input.actualSubagentThreadId,
      actualSubagentThreadId: input.actualSubagentThreadId,
      parentThreadId: input.parentThreadId,
      runtimeAttestation,
      hookAttested: true,
      attestationStartedAt: startedAt,
      startedAt: now,
      updatedAt: now,
    };
    await this.upsertInvocation(updated);
    await this.appendEvent(id, 'agent_invocation.started', 'tik', {
      invocationId: updated.id,
      status: updated.status,
      hookAttested: true,
    });
    return updated;
  }

  async attestInvocationStop(
    workflowId: string,
    invocationId: string,
    input: HookStopInvocationInput,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    const existing = await this.readInvocation(id, invocationId);
    if (!existing) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    if (!requiresRuntimeAttestation(existing)) {
      throw new MultiAgentCoordinationError('invalid_invocation_status', `Invocation ${invocationId} does not require hook attestation.`);
    }
    const status = input.status || 'completed';
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      throw new MultiAgentCoordinationError('invalid_invocation_status', 'Hook stop status must be completed, failed, or cancelled.');
    }
    assertInvocationTransition(existing.status, status);
    assertValidAttestationToken(existing, input.attestationToken);
    if (!existing.hookAttested || !existing.runtimeAttestation) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} must be started by a hook before stop attestation.`,
      );
    }

    const now = new Date().toISOString();
    const stoppedAt = input.stoppedAt || now;
    const readonlyPolicy = input.readonlyPolicy ?? readReadonlyPolicyFromRecord(input.result) ?? existing.readonlyPolicy;
    const evidenceRefs = mergeUnique(existing.evidenceRefs, input.evidenceRefs ?? readStringArrayFromRecord(input.result, 'evidenceRefs'));
    const runtimeAttestation: AgentInvocationRecord['runtimeAttestation'] = {
      ...existing.runtimeAttestation,
      stoppedAt,
      headSha: input.headSha ?? readStringFromRecord(input.result, 'headSha') ?? existing.headSha,
      evidenceRefs,
      readonlyPolicy,
    };
    const updated: AgentInvocationRecord = {
      ...existing,
      status,
      result: input.result ?? existing.result,
      error: input.error ?? existing.error,
      headSha: runtimeAttestation.headSha,
      evidenceRefs,
      evaluationRunId: input.evaluationRunId ?? readStringFromRecord(input.result, 'evaluationRunId') ?? existing.evaluationRunId,
      readonlyPolicy,
      runtimeAttestation,
      hookAttested: true,
      attestationStoppedAt: stoppedAt,
      attestationToken: undefined,
      updatedAt: now,
      completedAt: now,
    };
    await this.upsertInvocation(updated);
    await this.appendEvent(id, 'agent_invocation.completed', 'tik', {
      invocationId: updated.id,
      status: updated.status,
      hookAttested: true,
    });
    return updated;
  }

  async readTimeline(workflowId: string): Promise<MultiAgentWorkflowEvent[]> {
    const id = this.normalizeId(workflowId);
    await this.requireWorkflow(id);
    return this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(id));
  }

  private async requireWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord> {
    const workflow = await this.readWorkflow(workflowId);
    if (!workflow) {
      throw new MultiAgentCoordinationError('workflow_not_found', `Multi-agent workflow not found: ${workflowId}.`);
    }
    return workflow;
  }

  private async readTaskGraphForWorkflow(workflow: MultiAgentWorkflowRecord): Promise<TaskGraph | null> {
    if (!workflow.taskGraphVersion) {
      return null;
    }
    return this.readJsonFile<TaskGraph>(this.taskGraphFile(workflow.id, workflow.taskGraphVersion));
  }

  private async readSubtasks(workflowId: string): Promise<Record<string, SubtaskRunState>> {
    return (await this.readJsonFile<Record<string, SubtaskRunState>>(this.subtasksFile(workflowId))) ?? {};
  }

  private async requireSubtask(workflowId: string, subtaskId: string): Promise<SubtaskRunState> {
    const subtasks = await this.readSubtasks(workflowId);
    const subtask = subtasks[subtaskId];
    if (!subtask) {
      throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${subtaskId}.`);
    }
    return subtask;
  }

  private async readEvidence(workflowId: string): Promise<MultiAgentWorkflowEvidence[]> {
    try {
      const entries = await fs.readdir(this.evidenceDir(workflowId));
      const records = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readJsonFile<MultiAgentWorkflowEvidence>(path.join(this.evidenceDir(workflowId), entry))));
      return records
        .filter((item): item is MultiAgentWorkflowEvidence => Boolean(item))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async nextContractVersion(workflowId: string, subtaskId: string): Promise<number> {
    const latest = await this.readLatestContract(workflowId, subtaskId);
    return latest ? latest.version + 1 : 1;
  }

  private async requireContract(workflowId: string, subtaskId: string, contractId: string): Promise<SprintContract> {
    const normalized = this.normalizeId(contractId);
    const contract = await this.readJsonFile<SprintContract>(this.contractFile(workflowId, subtaskId, normalized));
    if (!contract) {
      throw new MultiAgentCoordinationError('contract_not_found', `SprintContract not found: ${contractId}.`);
    }
    return contract;
  }

  private async readContracts(workflowId: string, subtaskId?: string): Promise<SprintContract[]> {
    const rootDir = subtaskId ? this.contractsDir(workflowId, subtaskId) : this.workflowDir(workflowId);
    try {
      if (subtaskId) {
        const entries = await fs.readdir(rootDir);
        const records = await Promise.all(entries
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => this.readJsonFile<SprintContract>(path.join(rootDir, entry))));
        return records
          .filter((item): item is SprintContract => Boolean(item))
          .sort((left, right) => left.subtaskId.localeCompare(right.subtaskId) || left.version - right.version);
      }

      const subtaskDirs = await fs.readdir(this.contractsRootDir(workflowId), { withFileTypes: true });
      const nested = await Promise.all(subtaskDirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readContracts(workflowId, entry.name)));
      return nested.flat().sort((left, right) => left.subtaskId.localeCompare(right.subtaskId) || left.version - right.version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async requireEvaluationRun(workflowId: string, subtaskId: string, evaluationRunId: string): Promise<EvaluationRun> {
    const normalized = this.normalizeId(evaluationRunId);
    const run = await this.readJsonFile<EvaluationRun>(this.evaluationRunFile(workflowId, subtaskId, normalized));
    if (!run) {
      throw new MultiAgentCoordinationError('evaluation_not_found', `EvaluationRun not found: ${evaluationRunId}.`);
    }
    return run;
  }

  private async readEvaluationRuns(workflowId: string, subtaskId?: string): Promise<EvaluationRun[]> {
    try {
      if (subtaskId) {
        const entries = await fs.readdir(this.evaluationsDir(workflowId, subtaskId));
        const records = await Promise.all(entries
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => this.readJsonFile<EvaluationRun>(path.join(this.evaluationsDir(workflowId, subtaskId), entry))));
        return records
          .filter((item): item is EvaluationRun => Boolean(item))
          .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      }

      const subtaskDirs = await fs.readdir(this.evaluationsRootDir(workflowId), { withFileTypes: true });
      const nested = await Promise.all(subtaskDirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readEvaluationRuns(workflowId, entry.name)));
      return nested.flat().sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readQuestionerOutputs(workflowId: string): Promise<QuestionerOutput[]> {
    try {
      const entries = await fs.readdir(this.questionerOutputsDir(workflowId));
      const records = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readJsonFile<QuestionerOutput>(path.join(this.questionerOutputsDir(workflowId), entry))));
      return records
        .filter(isStoredQuestionerOutput)
        .sort((left, right) => safeIsoTime(left.createdAt).localeCompare(safeIsoTime(right.createdAt)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async upsertInvocation(invocation: AgentInvocationRecord): Promise<void> {
    const invocations = await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(invocation.workflowId));
    const next = [
      ...invocations.filter((item) => item.id !== invocation.id),
      invocation,
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    await fs.mkdir(this.workflowDir(invocation.workflowId), { recursive: true });
    await fs.writeFile(
      this.invocationsFile(invocation.workflowId),
      next.map((item) => JSON.stringify(item)).join('\n') + (next.length > 0 ? '\n' : ''),
      'utf-8',
    );
  }

  private async writeWorkflow(workflow: MultiAgentWorkflowRecord): Promise<void> {
    await this.writeJsonFileAtomic(this.workflowFile(workflow.id), workflow);
  }

  private async appendEvent(
    workflowId: string,
    type: MultiAgentWorkflowEventType,
    actor: MultiAgentWorkflowEvent['actor'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: MultiAgentWorkflowEvent = {
      id: generateId(),
      workflowId,
      type,
      actor,
      timestamp: new Date().toISOString(),
      payload,
    };
    await fs.mkdir(this.workflowDir(workflowId), { recursive: true });
    await fs.appendFile(this.eventsFile(workflowId), `${JSON.stringify(event)}\n`, 'utf-8');
  }

  private normalizeId(id: string): string {
    const normalized = id.trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new MultiAgentCoordinationError('invalid_id', `Invalid multi-agent workflow id: ${id}.`);
    }
    return normalized;
  }

  private rootDir(): string {
    return path.join(this.rootPath, '.tik', 'multi-agent', 'workflows');
  }

  private workflowDir(workflowId: string): string {
    return path.join(this.rootDir(), workflowId);
  }

  private workflowFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'workflow.json');
  }

  private taskGraphFile(workflowId: string, version: number): string {
    return path.join(this.workflowDir(workflowId), `task-graph.v${version}.json`);
  }

  private subtasksFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'subtasks.json');
  }

  private decisionsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'decisions.jsonl');
  }

  private invocationsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'invocations.jsonl');
  }

  private eventsFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'events.jsonl');
  }

  private evidenceDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'evidence');
  }

  private evidenceFile(workflowId: string, evidenceId: string): string {
    return path.join(this.evidenceDir(workflowId), `${evidenceId}.json`);
  }

  private contractsRootDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'contracts');
  }

  private contractsDir(workflowId: string, subtaskId: string): string {
    return path.join(this.contractsRootDir(workflowId), subtaskId);
  }

  private contractFile(workflowId: string, subtaskId: string, contractId: string): string {
    return path.join(this.contractsDir(workflowId, subtaskId), `${contractId}.json`);
  }

  private evaluationsRootDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'evaluations');
  }

  private evaluationsDir(workflowId: string, subtaskId: string): string {
    return path.join(this.evaluationsRootDir(workflowId), subtaskId);
  }

  private evaluationRunFile(workflowId: string, subtaskId: string, evaluationRunId: string): string {
    return path.join(this.evaluationsDir(workflowId, subtaskId), `${evaluationRunId}.json`);
  }

  private questionerOutputsDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'questioner');
  }

  private questionerOutputFile(workflowId: string, output: Pick<QuestionerOutput, 'id' | 'subtaskId' | 'intent'>): string {
    const prefix = output.subtaskId ? `${output.subtaskId}.` : '';
    return path.join(this.questionerOutputsDir(workflowId), `${prefix}${output.intent}.${output.id}.json`);
  }

  private contextDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'context');
  }

  private contextSnapshotFile(workflowId: string, target: WorkflowContextSnapshot['target']): string {
    return path.join(this.contextDir(workflowId), `${target}.snapshot.json`);
  }

  private localContextSnapshotMarkdownFile(workflowId: string, target: WorkflowContextSnapshot['target']): string {
    return path.join(this.contextDir(workflowId), `${target}.snapshot.md`);
  }

  private async writeLocalContextSnapshotMarkdown(
    workflowId: string,
    target: WorkflowContextSnapshot['target'],
    markdown: string,
  ): Promise<void> {
    await fs.mkdir(this.contextDir(workflowId), { recursive: true });
    await fs.writeFile(this.localContextSnapshotMarkdownFile(workflowId, target), markdown, 'utf-8');
  }

  private humanOverridesDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'human-overrides');
  }

  private humanOverrideFile(workflowId: string, overrideId: string): string {
    return path.join(this.humanOverridesDir(workflowId), `${overrideId}.json`);
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async readJsonLines<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }
}

function buildSubtaskStatesForGraph(
  graph: TaskGraph,
  existing: Record<string, SubtaskRunState>,
): Record<string, SubtaskRunState> {
  const states: Record<string, SubtaskRunState> = {};
  for (const subtask of graph.subtasks) {
    const status: SubtaskRunStatus = subtask.dependsOn.length === 0 ? 'ready' : 'pending';
    states[subtask.id] = existing[subtask.id] || {
      subtaskId: subtask.id,
      status,
      reviewRoundIds: [],
      validationRunIds: [],
      evidenceRefs: [],
      blockerFindingIds: [],
      fixRound: 0,
    };
  }
  return states;
}

function assertSubtaskTransition(from: SubtaskRunStatus, to: SubtaskRunStatus): void {
  if (from === to) {
    return;
  }
  if (SUBTASK_TRANSITIONS[from]?.includes(to)) {
    return;
  }
  throw new MultiAgentCoordinationError(
    'invalid_transition',
    `Cannot transition subtask from ${from} to ${to}.`,
  );
}

function assertInvocationTransition(from: MultiAgentInvocationStatus, to: MultiAgentInvocationStatus): void {
  if (from === to) {
    return;
  }
  if (INVOCATION_TRANSITIONS[from]?.includes(to)) {
    return;
  }
  throw new MultiAgentCoordinationError(
    'invalid_transition',
    `Cannot transition agent invocation from ${from} to ${to}.`,
  );
}

function requiresRuntimeAttestation(invocation: AgentInvocationRecord): boolean {
  return invocation.runner === 'codex' || invocation.runner === 'codex-evaluator';
}

function requiresRuntimeAttestationInput(input: CreateAgentInvocationInput): boolean {
  return input.runner === 'codex' || input.runner === 'codex-evaluator';
}

function assertValidAttestationToken(invocation: AgentInvocationRecord, token: string): void {
  if (!token || !invocation.attestationToken || token !== invocation.attestationToken) {
    throw new MultiAgentCoordinationError(
      'missing_subagent_invocation',
      `Codex invocation ${invocation.id} hook attestation token is missing, invalid, or already consumed.`,
    );
  }
}

function assertQuestionerRuntimeSource(input: {
  intent: QuestionerOutput['intent'];
  actor: QuestionerOutput['actor'];
  source: QuestionerOutput['source'];
  headSha: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  contractId?: string;
  artifactRef?: string;
}): void {
  if (input.source !== 'claude-plugin' || !input.actor?.invocationId || !input.headSha || !input.artifactRef) {
    throw new MultiAgentCoordinationError(
      'missing_evidence',
      'Questioner output must come from the Claude plugin and include invocationId, headSha, and artifactRef.',
    );
  }
  if ((input.intent === 'question_evaluation' || input.intent === 'question_final_evidence') && !input.evaluationRunId) {
    throw new MultiAgentCoordinationError(
      'missing_evaluation_result',
      'Evaluation Questioner output must reference an evaluationRunId.',
    );
  }
  if ((input.intent === 'question_contract' || input.intent === 'question_evaluation') && !input.contractId) {
    throw new MultiAgentCoordinationError(
      'missing_contract',
      'Contract or evaluation Questioner output must reference a contractId.',
    );
  }
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function mergeUnique<T>(left: T[] | undefined, right: T[] | undefined): T[] {
  return Array.from(new Set([...(left || []), ...(right || [])]));
}

function mergeCoverageGaps(
  left: CodexEvaluationResult['coverageGaps'],
  right: CodexEvaluationResult['coverageGaps'],
): CodexEvaluationResult['coverageGaps'] {
  const seen = new Set<string>();
  const merged: CodexEvaluationResult['coverageGaps'] = [];
  for (const gap of [...left, ...right]) {
    const key = `${gap.criterionId || ''}:${gap.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(gap);
  }
  return merged;
}

function isStoredQuestionerOutput(item: QuestionerOutput | null): item is QuestionerOutput {
  return Boolean(
    item
      && typeof item.id === 'string'
      && typeof item.workflowId === 'string'
      && typeof item.intent === 'string'
      && typeof item.createdAt === 'string'
      && Array.isArray(item.questions),
  );
}

function safeIsoTime(value: string | undefined): string {
  return typeof value === 'string' ? value : '';
}

function lastDecisionMatches(current: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  if (expected === '*') {
    return true;
  }
  return current === expected;
}

function normalizeLoopContract(workflowId: string, value: WorkflowPolicy['loopContract']): WorkflowPolicy['loopContract'] {
  if (!value) {
    return undefined;
  }
  return {
    ...value,
    workflowId,
    scope: {
      allowedPaths: value.scope?.allowedPaths || [],
      blockedPaths: value.scope?.blockedPaths || [],
    },
    budget: {
      maxRounds: value.budget?.maxRounds ?? 3,
      maxRuntimeMs: value.budget?.maxRuntimeMs ?? 30 * 60 * 1000,
      maxConsecutiveFailures: value.budget?.maxConsecutiveFailures ?? 3,
      maxSubagentRuns: value.budget?.maxSubagentRuns,
      maxEvaluatorRuns: value.budget?.maxEvaluatorRuns,
    },
    stop: value.stop || [],
    refresh: value.refresh || [],
    report: {
      destination: value.report?.destination || 'tik_timeline',
      fields: value.report?.fields || [],
    },
  };
}

function renderContextSnapshotMarkdown(snapshot: WorkflowContextSnapshot): string {
  const rendered = [
    '# Workflow Snapshot',
    '',
    '## Goal',
    snapshot.objectiveSummary || '(none)',
    '',
    '## Current Head',
    snapshot.headSha || '(unknown)',
    '',
    '## Active Subtask',
    snapshot.activeSubtaskId || '(none)',
    '',
    '## Contract Summary',
    snapshot.currentContractSummary || '(none)',
    '',
    '## Latest Implementation',
    snapshot.latestImplementationSummary || '(none)',
    '',
    '## Latest Evaluation',
    snapshot.latestEvaluationSummary || '(none)',
    '',
    '## Latest Claude Questioner Output',
    snapshot.latestQuestionerSummary || '(none)',
    '',
    '## Unresolved Blockers',
    ...renderMarkdownList(snapshot.unresolvedBlockers),
    '',
    '## Next Action Hint',
    snapshot.nextActionHint || '(none)',
    '',
    '## Artifact Refs',
    ...renderMarkdownList(snapshot.artifactRefs),
    '',
  ].join('\n');
  return truncateMarkdown(rendered, snapshot.maxChars);
}

function truncateMarkdown(markdown: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || markdown.length <= maxChars) {
    return markdown;
  }
  const suffix = '\n\n...(truncated, see artifactRefs)';
  if (maxChars <= suffix.length) {
    return markdown.slice(0, maxChars);
  }
  const limit = maxChars - suffix.length;
  const lastBreak = markdown.lastIndexOf('\n', limit);
  const cutAt = lastBreak > 0 ? lastBreak : limit;
  return `${markdown.slice(0, cutAt)}${suffix}`;
}

function isSubstantiveSnapshotChange(
  current: WorkflowContextSnapshot | null,
  next: WorkflowContextSnapshot,
): boolean {
  if (!current) {
    return true;
  }
  return current.headSha !== next.headSha
    || current.activeSubtaskId !== next.activeSubtaskId
    || current.objectiveSummary !== next.objectiveSummary;
}

function readPauseReason(workflow: MultiAgentWorkflowRecord): string | undefined {
  const value = workflow.pauseReason ?? workflow.metadata?.pauseReason;
  return typeof value === 'string' ? value : undefined;
}

function renderMarkdownList(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ['- (none)'];
}

function readGuardRejectionFromMetadata(metadata: Record<string, unknown> | undefined): GuardResult | undefined {
  const value = metadata?.lastGuardRejection || metadata?.guardRejection;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    accepted: false,
    code: typeof record.code === 'string' ? record.code as GuardResult['code'] : 'unknown_error',
    message: typeof record.message === 'string' ? record.message : undefined,
    currentState: record.currentState,
  };
}

function readStringFromRecord(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArrayFromRecord(record: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function readReadonlyPolicyFromRecord(
  record: Record<string, unknown> | undefined,
): AgentInvocationRecord['readonlyPolicy'] | undefined {
  const value = record?.readonlyPolicy;
  if (!value || typeof value !== 'object') return undefined;
  const policy = value as Record<string, unknown>;
  return {
    enforced: policy.enforced === true,
    allowedWritePaths: readStringArrayFromRecord(policy, 'allowedWritePaths'),
    forbiddenWritePaths: readStringArrayFromRecord(policy, 'forbiddenWritePaths'),
    violations: readStringArrayFromRecord(policy, 'violations') || [],
  };
}

function assertWorkspaceBindingInsideRoot(binding: MultiAgentWorkflowRecord['workspaceBinding']): void {
  if (!binding?.workspaceRoot || !binding.effectiveProjectPath) {
    return;
  }

  const root = path.resolve(binding.workspaceRoot);
  const target = path.resolve(binding.effectiveProjectPath);
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return;
  }

  throw new MultiAgentCoordinationError(
    'worktree_out_of_scope',
    `Workflow worktree is outside workspace root: ${target}`,
  );
}

function defaultReadonlyPolicy(): EvaluationRun['readonlyPolicy'] {
  return {
    enforced: true,
    allowedWritePaths: [
      '.tik/multi-agent/',
      'test-results/',
      'playwright-report/',
      'coverage/',
      '.tmp/evaluation/',
    ],
    forbiddenWritePaths: [
      'src/',
      'app/',
      'packages/',
      'server/',
      'client/',
      'tests/',
      'package.json',
      'pnpm-lock.yaml',
    ],
  };
}

function detectReadonlyViolations(
  before: string,
  after: string,
  allowedWritePaths: string[],
  forbiddenWritePaths: string[],
): string[] {
  const beforeEntries = parseGitStatusPaths(before);
  const afterEntries = parseGitStatusPaths(after);
  const changedAfter = Array.from(afterEntries).filter((entry) => !beforeEntries.has(entry));
  return changedAfter.filter((entry) => {
    const normalized = normalizeGitStatusPath(entry);
    if (matchesAnyPath(normalized, allowedWritePaths)) {
      return false;
    }
    return matchesAnyPath(normalized, forbiddenWritePaths) || !matchesAnyPath(normalized, allowedWritePaths);
  });
}

function parseGitStatusPaths(status: string): Set<string> {
  const paths = new Set<string>();
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const pathPart = parseGitStatusPath(line);
    if (!pathPart) continue;
    const renamed = pathPart.includes(' -> ')
      ? pathPart.split(' -> ').at(-1) || pathPart
      : pathPart;
    paths.add(renamed.replace(/^"|"$/g, ''));
  }
  return paths;
}

function parseGitStatusPath(line: string): string {
  if (line.length >= 4 && /^[ MADRCU?!][ MADRCU?!] /.test(line.slice(0, 3))) {
    return line.slice(3).trim();
  }
  const trimmed = line.trim();
  if (trimmed.length >= 3 && /^[MADRCU?!][ MADRCU?!] /.test(trimmed.slice(0, 3))) {
    return trimmed.slice(3).trim();
  }
  const firstSpace = trimmed.indexOf(' ');
  return firstSpace >= 0 ? trimmed.slice(firstSpace + 1).trim() : trimmed;
}

function normalizeGitStatusPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function matchesAnyPath(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeGitStatusPath(pattern);
    if (normalizedPattern.includes('*')) {
      return globPathToRegExp(normalizedPattern).test(filePath);
    }
    return normalizedPattern.endsWith('/')
      ? filePath === normalizedPattern.slice(0, -1) || filePath.startsWith(normalizedPattern)
      : filePath === normalizedPattern || filePath.startsWith(`${normalizedPattern}/`);
  });
}

function globPathToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/(\*\*)/g)
    .map((part) => {
      if (part === '**') return '.*';
      return part
        .split('*')
        .map(escapeRegExp)
        .join('[^/]*');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function isFinalEvaluationSubtask(subtaskId: string): boolean {
  return subtaskId === '__final__';
}
