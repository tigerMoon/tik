import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  generateId,
  type AgentInvocationRecord,
  type AgentRuntimePolicy,
  type CodexEvaluationResult,
  type CreateMultiAgentWorkflowInput,
  type EvaluationCheckpoint,
  type EvaluationFailureClass,
  type EvaluationRun,
  type GuardResult,
  type HumanOverrideRecord,
  type MultiAgentInvocationStatus,
  type MultiAgentWorkflowBundle,
  type MultiAgentWorkflowEvent,
  type MultiAgentWorkflowEventType,
  type MultiAgentWorkflowEvidence,
  type MultiAgentWorkflowRecord,
  type QuestionerContextV1,
  type QuestionerIntent,
  type QuestionerOutput,
  type QuestionerOutputV2,
  type QuestionResolution,
  type QuestionerRun,
  type SprintContract,
  type SubtaskRunState,
  type SubtaskRunStatus,
  type TaskGraph,
  type WorkflowContextSnapshot,
  type WorkflowDecision,
  type WorkflowPolicy,
} from '@tik/shared';
import { buildQuestionerContext, estimateContextTokens, slimQuestionerContext } from './questioner-context.js';

/**
 * Hard budget for a Questioner ContextBundle before the kernel rejects the
 * launch with context_budget_exceeded. Keep this in sync with the tighter
 * budgets in `native-context-bundle.ts:ROLE_TOKEN_BUDGETS.questioner`; the
 * bundle path is separate but we don't want the two to drift apart.
 */
const QUESTIONER_CONTEXT_TOKEN_BUDGET = 12_000;
import { evaluateWorkflowDecisionGuard } from './guard.js';
import {
  hashQuestionerToken,
  normalizeQuestionerOutputV2,
  validateQuestionerOutputV2,
  validateQuestionerRunToken,
} from './questioner-validation.js';

const SUBTASK_TRANSITIONS: Record<SubtaskRunStatus, SubtaskRunStatus[]> = {
  pending: ['ready', 'blocked', 'human_review_required'],
  ready: ['contract_drafting', 'executing', 'reviewing', 'reviewed', 'blocked', 'human_review_required'],
  contract_drafting: ['contract_questioning', 'contract_accepted', 'blocked', 'human_review_required'],
  contract_questioning: ['contract_drafting', 'contract_accepted', 'blocked', 'human_review_required'],
  contract_accepted: ['building', 'executing', 'implemented', 'blocked', 'human_review_required'],
  reviewing: ['reviewed', 'blocked', 'human_review_required'],
  reviewed: ['reviewing', 'evaluating', 'blocked', 'human_review_required'],
  building: ['implemented', 'validation_failed', 'blocked', 'human_review_required'],
  executing: ['implemented', 'validation_failed', 'blocked', 'human_review_required'],
  implemented: ['evaluating', 'validating', 'validated', 'validation_failed', 'blocked', 'human_review_required'],
  evaluating: ['evaluation_failed', 'evaluation_passed', 'validation_failed', 'validated', 'blocked', 'human_review_required'],
  evaluation_failed: ['needs_fix', 'fixing', 'building', 'executing', 'implemented', 'reviewing', 'reviewed', 'evaluating', 'blocked', 'human_review_required'],
  evaluation_passed: ['questioning_evidence', 'done', 'blocked', 'human_review_required'],
  validating: ['validated', 'validation_failed', 'blocked', 'human_review_required'],
  validated: ['evaluating', 'questioning_evidence', 'done', 'blocked', 'human_review_required'],
  validation_failed: ['executing', 'implemented', 'blocked', 'human_review_required'],
  questioning_evidence: ['needs_fix', 'evaluating', 'evaluation_failed', 'done', 'blocked', 'human_review_required'],
  synthesizing: ['synthesized', 'blocked', 'human_review_required'],
  synthesized: ['done', 'blocked', 'human_review_required'],
  needs_fix: ['fixing', 'executing', 'implemented', 'blocked', 'human_review_required'],
  fixing: ['implemented', 'blocked', 'human_review_required'],
  done: ['human_review_required'],
  blocked: ['ready', 'executing', 'human_review_required'],
  human_review_required: [],
};

export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = {
  maxFixRoundsPerSubtask: 3,
  maxEvaluationRoundsPerSubtask: 3,
  requireQuestionerBeforeBuild: false,
  requireQuestionerAfterEvaluation: true,
  requireAcceptedContract: true,
  requireEvaluationPassForComplete: true,
  requireSameHeadShaForEvidence: true,
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

export interface CreateAgentInvocationInput {
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
  nativeRuntimeOwned?: boolean;
  contextBundleHash?: string;
  estimatedContextTokens?: number;
  contextTokenBudget?: number;
  cleanContext?: boolean;
}

interface CreateQuestionerRunInput {
  id?: string;
  invocationId?: string;
  intent: QuestionerIntent;
  subtaskId?: string;
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  headSha: string;
  start?: boolean;
  tokenTtlMs?: number;
  nativeRuntimeOwned?: boolean;
  runtimeAudit?: {
    gitStatusBefore?: string;
    workspaceFingerprintBefore?: string;
    allowedWritePaths?: string[];
    forbiddenWritePaths?: string[];
  };
}

interface SubmitQuestionerRunOutputInput {
  token?: string;
  output: QuestionerOutputV2;
  now?: string;
  runtimeAudit?: {
    gitStatusAfter?: string;
    workspaceFingerprintAfter?: string;
    allowedWritePaths?: string[];
    forbiddenWritePaths?: string[];
  };
}

interface HookStartInvocationInput {
  attestationToken: string;
  nonce: string;
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

type AttestedEvidenceInvocationInput = Omit<HookStopInvocationInput, 'attestationToken'> & {
  attestationToken?: string;
};

export interface NativeInvocationStartInput {
  parentThreadId: string;
  actualSubagentThreadId: string;
  role: AgentInvocationRecord['role'];
  nonce: string;
  startedAt?: string;
}

export interface NativeInvocationCompletionInput {
  status: Extract<MultiAgentInvocationStatus, 'completed' | 'failed' | 'cancelled'>;
  stoppedAt?: string;
  headSha?: string;
  evidenceRefs?: string[];
  evaluationRunId?: string;
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
  result?: Record<string, unknown>;
  error?: string;
}

export interface AcceptContractsBatchItem {
  subtaskId: string;
  contractId: string;
  decision: WorkflowDecision;
  acceptance?: {
    acceptedBy?: SprintContract['acceptedBy'];
    headShaAtAcceptance?: string;
    questionerOutputRefs?: string[];
  };
}

export class FileMultiAgentWorkflowStore {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  private readonly mutationContext = new AsyncLocalStorage<Set<string>>();

  constructor(private readonly rootPath: string) {}

  async createWorkflow(input: CreateMultiAgentWorkflowInput): Promise<MultiAgentWorkflowRecord> {
    if (!input.goal?.trim()) {
      throw new MultiAgentCoordinationError('invalid_workflow', 'Workflow goal is required.');
    }
    // Lite is only meaningful for implementation-mode workflows. Review mode
    // has its own audit rules that lite would silently disable.
    if (input.mode === 'review' && input.kind === 'lite') {
      throw new MultiAgentCoordinationError(
        'invalid_workflow',
        'kind=lite is incompatible with mode=review; review workflows must keep the full Questioner audit.',
      );
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
      revision: 0,
      status: 'active',
      mode: input.mode || 'implementation',
      kind: input.kind || 'standard',
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
        // Lite workflows skip the Claude Questioner gate by default. Contract
        // acceptance and evaluator pass still remain mandatory. Applied AFTER
        // `...input.policy` so an explicit `undefined` in input.policy cannot
        // clobber the computed default — the ?? here still lets a caller
        // supply an explicit boolean to override lite behavior.
        requireQuestionerAfterEvaluation: input.kind === 'lite'
          ? input.policy?.requireQuestionerAfterEvaluation ?? false
          : input.policy?.requireQuestionerAfterEvaluation ?? DEFAULT_WORKFLOW_POLICY.requireQuestionerAfterEvaluation,
        requireAcceptedContract: input.mode === 'review'
          ? false
          : input.policy?.requireAcceptedContract ?? DEFAULT_WORKFLOW_POLICY.requireAcceptedContract,
      },
      workspaceBinding: input.workspaceBinding,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
    await this.writeWorkflow(workflow);
    await this.appendEvent(workflow.id, 'workflow.created', 'tik', { workflowId: workflow.id });
    return this.requireWorkflow(workflow.id);
  }

  async readWorkflow(workflowId: string): Promise<MultiAgentWorkflowRecord | null> {
    return this.readJsonFile<MultiAgentWorkflowRecord>(this.workflowFile(this.normalizeId(workflowId)));
  }

  async listWorkflowRecords(): Promise<MultiAgentWorkflowRecord[]> {
    return this.listWorkflows();
  }

  async findBundleByRootTaskId(rootTaskId: string): Promise<MultiAgentWorkflowBundle | null> {
    const workflows = await this.listWorkflows();
    const candidates = workflows
      .filter((workflow) => workflow.rootTaskId === rootTaskId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = candidates[0];
    return latest ? this.readBundle(latest.id) : null;
  }

  async findBundleByWorkflowOrRootTaskId(id: string): Promise<MultiAgentWorkflowBundle | null> {
    const direct = await this.readBundle(id).catch((error) => {
      if (error instanceof MultiAgentCoordinationError && error.code === 'invalid_id') {
        return null;
      }
      throw error;
    });
    return direct ?? this.findBundleByRootTaskId(id);
  }

  async updateWorkflow(
    workflowId: string,
    patch: Partial<Pick<MultiAgentWorkflowRecord, 'status' | 'currentHeadSha' | 'metadata' | 'pauseReason' | 'rootTaskId'>> & {
      policy?: Partial<WorkflowPolicy>;
    },
  ): Promise<MultiAgentWorkflowRecord> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.updateWorkflow(id, patch));
    }
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
      rootTaskId: patch.rootTaskId ?? existing.rootTaskId,
      currentHeadSha: patch.currentHeadSha ?? existing.currentHeadSha,
      pauseReason: patch.pauseReason ?? existing.pauseReason,
      // Shallow-merge metadata so concurrent writers (e.g. the CLI's
      // pauseWorkflow and the in-process stale-detector) don't clobber each
      // other's fields. Callers that need to remove a key should send it as
      // `null` explicitly; the merge below preserves undefined values from
      // `existing` rather than dropping them.
      metadata: patch.metadata
        ? mergeWorkflowMetadata(existing.metadata, patch.metadata)
        : existing.metadata,
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
    await assertWorkspaceBindingInsideRoot(workflow.workspaceBinding);
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
    const lockBefore = await pathExists(this.workflowMutationLockDir(id));
    const transactionBefore = await pathExists(this.workflowTransactionFile(id));
    if (!lockBefore && !transactionBefore) {
      const snapshot = await this.readBundleSnapshot(id);
      const [lockAfter, transactionAfter, workflowAfter] = await Promise.all([
        pathExists(this.workflowMutationLockDir(id)),
        pathExists(this.workflowTransactionFile(id)),
        this.readWorkflow(id),
      ]);
      if (
        !lockAfter
        && !transactionAfter
        && (!snapshot || (workflowAfter?.revision ?? snapshot.events.length) === snapshot.workflow.revision)
      ) {
        return snapshot;
      }
    }
    return this.withWorkflowMutation(id, async () => {
      await this.recoverWorkflowTransaction(id);
      return this.readBundleSnapshot(id);
    });
  }

  private async readBundleSnapshot(workflowId: string): Promise<MultiAgentWorkflowBundle | null> {
    const workflow = await this.readWorkflow(workflowId);
    if (!workflow) return null;
    const events = await this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(workflowId));
    return {
      workflow: { ...workflow, revision: workflow.revision ?? events.length },
      taskGraph: await this.readTaskGraphForWorkflow(workflow),
      subtasks: await this.readSubtasks(workflowId),
      contracts: await this.readContracts(workflowId),
      evaluationRuns: await this.readEvaluationRuns(workflowId),
      questionerRuns: await this.readQuestionerRuns(workflowId),
      questionerOutputs: await this.readQuestionerOutputs(workflowId),
      questionResolutions: await this.readQuestionResolutions(workflowId),
      decisions: await this.readJsonLines<WorkflowDecision>(this.decisionsFile(workflowId)),
      evidence: await this.readEvidence(workflowId),
      invocations: await this.readJsonLines<AgentInvocationRecord>(this.invocationsFile(workflowId)),
      events,
    };
  }

  async putTaskGraph(workflowId: string, graph: TaskGraph): Promise<{ graph: TaskGraph; subtasks: Record<string, SubtaskRunState> }> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.putTaskGraph(id, graph));
    }
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

    validateTaskGraph(workflow, graph);

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
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.updateSubtask(id, subtaskId, patch));
    }
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
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.recordDecision(id, decision));
    }
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
    return this.withWorkflowMutation(id, async () => {
      const workflow = await this.requireWorkflow(id);
      if (!lastDecisionMatches(workflow.lastDecisionId, expectedLastDecisionId)) {
        return {
          workflow,
          guard: {
            accepted: false,
            code: 'version_conflict',
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
    });
  }

  /**
   * Record a decision AND patch a subtask under a single workflow mutation
   * lock. Guarantees the pair is atomic w.r.t. concurrent mutations: the
   * subtask transition is validated (via assertSubtaskTransition) BEFORE
   * the decision is appended, so a raced status change causes both writes
   * to abort. Prevents the dangling-decision failure mode that plain
   * recordDecisionIfMatch + updateSubtask exhibits from a route without a
   * shared lock.
   *
   * Limitation — NOT atomic w.r.t. disk faults. `recordDecision` appends
   * to decisions.jsonl and bumps lastDecisionId before `updateSubtask`
   * runs. If updateSubtask throws mid-flight (ENOSPC on the atomic rename,
   * EIO on writeWorkflow, appendEvent failure), the decision is already
   * on disk permanently and there is no rollback — the append-only
   * journal has no undo. Callers who need disk-fault atomicity must go
   * through recoverWorkflowTransaction's prepare/commit shape; this
   * helper is scoped to protect against concurrency races only.
   */
  async recordDecisionAndUpdateSubtaskIfMatch(
    workflowId: string,
    decision: WorkflowDecision,
    subtaskPatch: { subtaskId: string; patch: Partial<SubtaskRunState> },
    expectedLastDecisionId?: string,
  ): Promise<{
    decision?: WorkflowDecision;
    workflow: MultiAgentWorkflowRecord;
    subtask?: SubtaskRunState;
    guard: GuardResult;
  }> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const workflow = await this.requireWorkflow(id);
      if (!lastDecisionMatches(workflow.lastDecisionId, expectedLastDecisionId)) {
        return {
          workflow,
          guard: {
            accepted: false,
            code: 'version_conflict',
            message: `Decision history changed; expected ${expectedLastDecisionId || 'no last decision'}, current ${workflow.lastDecisionId || 'none'}.`,
            currentState: {
              expectedLastDecisionId,
              lastDecisionId: workflow.lastDecisionId,
            },
          },
        };
      }
      // Verify the subtask transition is legal BEFORE writing the decision.
      // If we discover the transition is illegal after the decision landed,
      // we cannot roll back the append-only decisions journal cleanly.
      const subtasks = await this.readSubtasks(id);
      const existing = subtasks[subtaskPatch.subtaskId];
      if (!existing) {
        return {
          workflow,
          guard: {
            accepted: false,
            code: 'invalid_transition',
            message: `Subtask not found: ${subtaskPatch.subtaskId}.`,
          },
        };
      }
      const nextStatus = subtaskPatch.patch.status ?? existing.status;
      try {
        assertSubtaskTransition(existing.status, nextStatus);
      } catch (error) {
        return {
          workflow,
          guard: {
            accepted: false,
            code: 'invalid_transition',
            message: (error as Error).message,
            currentState: { subtaskId: subtaskPatch.subtaskId, status: existing.status },
          },
        };
      }
      const recorded = await this.recordDecision(id, decision);
      const patchedSubtask = await this.updateSubtask(
        id,
        subtaskPatch.subtaskId,
        subtaskPatch.patch,
      );
      return {
        decision: recorded,
        workflow: await this.requireWorkflow(id),
        subtask: patchedSubtask,
        guard: { accepted: true, code: 'ok' },
      };
    });
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

  async recordAttestedEvidenceAtomically(
    workflowId: string,
    input: {
      subtaskId: string;
      evidence: Omit<Partial<MultiAgentWorkflowEvidence>, 'workflowId' | 'createdAt'> & {
        id: string;
        kind: 'implementation' | 'review';
        title: string;
      };
      decision: WorkflowDecision;
      invocationId: string;
      invocationStop: AttestedEvidenceInvocationInput;
      finalStatus: 'implemented' | 'reviewed';
      expectedLastDecisionId?: string;
    },
  ): Promise<{
    evidence: MultiAgentWorkflowEvidence;
    decision: WorkflowDecision;
    invocation: AgentInvocationRecord;
    subtask: SubtaskRunState;
    workflow: MultiAgentWorkflowRecord;
  }> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      await this.assertWorkflowVersion(id, input.expectedLastDecisionId);
      const currentInvocation = await this.readInvocation(id, input.invocationId);
      if (!currentInvocation) {
        throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${input.invocationId}.`);
      }
      const expectedRole = input.evidence.kind === 'implementation' ? 'executor' : 'reviewer';
      if (currentInvocation.subtaskId !== input.subtaskId || currentInvocation.role !== expectedRole) {
        throw new MultiAgentCoordinationError(
          'missing_subagent_invocation',
          `Invocation ${currentInvocation.id} must be the ${expectedRole} invocation for subtask ${input.subtaskId}.`,
        );
      }
      const nativeCompleted = currentInvocation.status === 'completed'
        && currentInvocation.runtimeAttestation?.source === 'codex-subagent-runtime';
      if (!nativeCompleted) {
        await this.prepareInvocationStop(id, input.invocationId, input.invocationStop as HookStopInvocationInput);
      }
      const existingSubtask = await this.requireSubtask(id, input.subtaskId);
      assertSubtaskTransition(existingSubtask.status, input.finalStatus);
      const evidenceId = this.normalizeId(input.evidence.id);
      const snapshotPaths = [
        this.workflowFile(id),
        this.subtasksFile(id),
        this.decisionsFile(id),
        this.invocationsFile(id),
        this.eventsFile(id),
        this.evidenceFile(id, evidenceId),
      ];
      const snapshots = await this.snapshotFiles(snapshotPaths);
      try {
        const evidence = await this.recordEvidence(id, { ...input.evidence, id: evidenceId });
        let invocation: AgentInvocationRecord;
        if (nativeCompleted) {
          const evidenceRefs = mergeUnique(currentInvocation.evidenceRefs, [evidence.id]);
          invocation = {
            ...currentInvocation,
            evidenceRefs,
            runtimeAttestation: {
              ...currentInvocation.runtimeAttestation!,
              evidenceRefs,
            },
            result: {
              ...(currentInvocation.result || {}),
              ...(input.invocationStop.result || {}),
              evidenceRefs,
            },
            updatedAt: new Date().toISOString(),
          };
          await this.upsertInvocation(invocation);
        } else {
          invocation = await this.attestInvocationStop(id, input.invocationId, {
            ...(input.invocationStop as HookStopInvocationInput),
            evidenceRefs: mergeUnique(input.invocationStop.evidenceRefs, [evidence.id]),
          });
        }
        const decision = await this.recordDecision(id, {
          ...input.decision,
          evidenceRefs: mergeUnique(input.decision.evidenceRefs, [evidence.id]),
        });
        const subtask = await this.updateSubtask(id, input.subtaskId, {
          status: input.finalStatus,
          implementationHeadSha: input.finalStatus === 'implemented' ? evidence.headSha : existingSubtask.implementationHeadSha,
          evidenceRefs: [evidence.id],
        });
        return {
          evidence,
          decision,
          invocation,
          subtask,
          workflow: await this.requireWorkflow(id),
        };
      } catch (error) {
        await this.restoreFiles(snapshots);
        throw error;
      }
    });
  }

  async recordEvidenceAndDecisionAtomically(
    workflowId: string,
    input: {
      evidence: Omit<Partial<MultiAgentWorkflowEvidence>, 'workflowId' | 'createdAt'> & {
        id: string;
        kind: MultiAgentWorkflowEvidence['kind'];
        title: string;
      };
      decision: WorkflowDecision;
      expectedLastDecisionId?: string;
    },
  ): Promise<{
    evidence: MultiAgentWorkflowEvidence;
    decision: WorkflowDecision;
    workflow: MultiAgentWorkflowRecord;
  }> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      await this.assertWorkflowVersion(id, input.expectedLastDecisionId);
      const evidenceId = this.normalizeId(input.evidence.id);
      const snapshots = await this.snapshotFiles([
        this.workflowFile(id),
        this.decisionsFile(id),
        this.eventsFile(id),
        this.evidenceFile(id, evidenceId),
      ]);
      try {
        const evidence = await this.recordEvidence(id, { ...input.evidence, id: evidenceId });
        const decision = await this.recordDecision(id, {
          ...input.decision,
          evidenceRefs: mergeUnique(input.decision.evidenceRefs, [evidence.id]),
        });
        return { evidence, decision, workflow: await this.requireWorkflow(id) };
      } catch (error) {
        await this.restoreFiles(snapshots);
        throw error;
      }
    });
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
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.createContract(id, subtaskId, input));
    }
    const workflow = await this.requireWorkflow(id);
    if (workflow.mode === 'review') {
      throw new MultiAgentCoordinationError('invalid_transition', 'Review workflows do not create SprintContracts.');
    }
    await this.requireSubtask(id, subtaskId);
    const contracts = await this.readContracts(id, subtaskId);
    const requestedVersion = input.version ?? (await this.nextContractVersion(id, subtaskId));
    const requestedId = this.normalizeId(input.id || `contract-${subtaskId}-v${requestedVersion}`);
    const usedVersions = new Set(contracts.map((contract) => contract.version));
    const usedIds = new Set(contracts.map((contract) => contract.id));
    let version = requestedVersion;
    let contractId = requestedId;
    if (usedVersions.has(version) || usedIds.has(contractId)) {
      version = Math.max(0, ...usedVersions) + 1;
      contractId = `contract-${subtaskId}-v${version}`;
      while (usedVersions.has(version) || usedIds.has(contractId)) {
        version += 1;
        contractId = `contract-${subtaskId}-v${version}`;
      }
    }
    const contract: SprintContract = {
      id: contractId,
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
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.acceptContract(id, subtaskId, contractId, input));
    }
    const accepted = await this.prepareAcceptedContract(id, subtaskId, contractId, input);
    await this.writeJsonFileAtomic(this.contractFile(id, subtaskId, accepted.id), accepted);
    await this.appendEvent(id, 'contract.accepted', 'codex-workflow', {
      contractId: accepted.id,
      subtaskId,
      version: accepted.version,
    });
    return accepted;
  }

  async acceptContractsAtomically(
    workflowId: string,
    items: AcceptContractsBatchItem[],
    expectedRevision?: string,
  ): Promise<{
    contracts: SprintContract[];
    decisions: WorkflowDecision[];
    subtasks: SubtaskRunState[];
    workflow: MultiAgentWorkflowRecord;
  }> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const bundle = await this.requireBundle(id);
      this.assertWorkflowRevision(bundle.workflow, expectedRevision);
      if (!Array.isArray(items) || items.length === 0) {
        throw new MultiAgentCoordinationError('invalid_transition', 'Batch Contract acceptance requires at least one item.');
      }
      const workflow = bundle.workflow;
      if (workflow.mode === 'review') {
        throw new MultiAgentCoordinationError('invalid_transition', 'Review workflows do not accept SprintContracts.');
      }
      const duplicateSubtask = findDuplicate(items.map((item) => item.subtaskId));
      if (duplicateSubtask) {
        throw new MultiAgentCoordinationError('invalid_transition', `Batch Contract acceptance contains duplicate subtask ${duplicateSubtask}.`);
      }
      const planned = await Promise.all(items.map(async (item) => {
        if (
          item.decision.workflowId !== id
          || item.decision.subtaskId !== item.subtaskId
          || item.decision.action !== 'accept_contract'
        ) {
          throw new MultiAgentCoordinationError(
            'invalid_transition',
            `Batch decision for ${item.subtaskId} must be accept_contract for workflow ${id}.`,
          );
        }
        const subtask = bundle.subtasks[item.subtaskId];
        if (!subtask) {
          throw new MultiAgentCoordinationError('subtask_not_found', `Subtask not found: ${item.subtaskId}.`);
        }
        assertSubtaskTransition(subtask.status, 'contract_accepted');
        const requested = bundle.contracts.find((contract) =>
          contract.subtaskId === item.subtaskId && contract.id === item.contractId
        );
        if (!requested) {
          throw new MultiAgentCoordinationError('contract_not_found', `SprintContract not found: ${item.contractId}.`);
        }
        const latest = latestContractForSubtask(bundle.contracts, item.subtaskId);
        if (!latest) {
          throw new MultiAgentCoordinationError('contract_not_found', `SprintContract not found: ${item.contractId}.`);
        }
        if (latest.id !== item.contractId) {
          throw new MultiAgentCoordinationError(
            'version_conflict',
            `Contract ${item.contractId} is stale; latest Contract for ${item.subtaskId} is ${latest.id}.`,
          );
        }
        const guard = evaluateWorkflowDecisionGuard(bundle, item.decision);
        if (!guard.accepted) {
          throw new MultiAgentCoordinationError(
            guard.code || 'invalid_transition',
            guard.message || `Contract ${item.contractId} failed its acceptance guard.`,
          );
        }
        const contract = await this.prepareAcceptedContract(id, item.subtaskId, item.contractId, item.acceptance || {});
        return {
          item,
          contract,
          subtask: {
            ...subtask,
            status: 'contract_accepted' as const,
          },
        };
      }));
      const snapshots = await this.snapshotFiles([
        this.workflowFile(id),
        this.subtasksFile(id),
        this.decisionsFile(id),
        this.eventsFile(id),
        ...planned.map(({ item, contract }) => this.contractFile(id, item.subtaskId, contract.id)),
      ]);
      await this.beginWorkflowTransaction(id, snapshots);
      try {
        const contracts = planned.map(({ contract }) => contract);
        const decisions = planned.map(({ item }) => item.decision);
        const subtasks = planned.map(({ subtask }) => subtask);
        const nextSubtasks = {
          ...bundle.subtasks,
          ...Object.fromEntries(planned.map(({ item, subtask }) => [item.subtaskId, subtask])),
        };
        for (const { item, contract } of planned) {
          await this.writeJsonFileAtomic(this.contractFile(id, item.subtaskId, contract.id), contract);
        }
        await this.writeJsonFileAtomic(this.subtasksFile(id), nextSubtasks);
        await fs.appendFile(
          this.decisionsFile(id),
          `${decisions.map((decision) => JSON.stringify(decision)).join('\n')}\n`,
          'utf-8',
        );
        const now = new Date().toISOString();
        await this.writeWorkflow({
          ...workflow,
          lastDecisionId: decisions[decisions.length - 1].id,
          updatedAt: now,
        });
        await this.appendEvents(id, planned.flatMap(({ item, contract }) => ([
          {
            type: 'contract.accepted' as const,
            actor: 'codex-workflow' as const,
            payload: {
              contractId: contract.id,
              subtaskId: item.subtaskId,
              version: contract.version,
              batch: true,
            },
          },
          {
            type: 'decision.recorded' as const,
            actor: 'codex-workflow' as const,
            payload: {
              decisionId: item.decision.id,
              action: item.decision.action,
              subtaskId: item.subtaskId,
              batch: true,
            },
          },
          {
            type: 'subtask.updated' as const,
            actor: 'codex-workflow' as const,
            payload: {
              subtaskId: item.subtaskId,
              status: 'contract_accepted',
              batch: true,
            },
          },
        ])));
        await this.commitWorkflowTransaction(id);
        return {
          contracts,
          decisions,
          subtasks,
          workflow: await this.requireWorkflow(id),
        };
      } catch (error) {
        await this.restoreFiles(snapshots);
        await fs.rm(this.workflowTransactionFile(id), { force: true });
        throw error;
      }
    });
  }

  async staleContract(workflowId: string, subtaskId: string, contractId: string): Promise<SprintContract> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.staleContract(id, subtaskId, contractId));
    }
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
    const workflow = await this.requireWorkflow(id);
    if (!isFinalEvaluationSubtask(subtaskId)) {
      await this.requireSubtask(id, subtaskId);
      if (workflow.mode !== 'review') {
        await this.requireContract(id, subtaskId, input.contractId);
      }
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
      semanticResult: input.semanticResult,
      semanticCacheKey: input.semanticCacheKey,
      retryOfEvaluationRunId: input.retryOfEvaluationRunId,
      resumeFromStage: input.resumeFromStage,
      failureClass: input.failureClass,
      checkpoints: input.checkpoints || [],
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
      failureClass: evaluationFailureClass(normalizedResult, status),
      resumeFromStage: status === 'passed' ? undefined : evaluationResumeStage(normalizedResult, status),
      checkpoints: upsertEvaluationCheckpoint(existing.checkpoints || [], {
        stage: 'verdict_merge',
        status: status === 'passed' ? 'passed' : 'failed',
        inputHash: existing.semanticCacheKey || `head:${existing.headSha}`,
        outputHash: `sha256:${createHash('sha256').update(JSON.stringify(normalizedResult)).digest('hex')}`,
        failureClass: status === 'passed' ? undefined : evaluationFailureClass(normalizedResult, status),
        startedAt: existing.startedAt,
        completedAt: new Date().toISOString(),
      }),
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
    const finalEvaluation = isFinalEvaluationSubtask(subtaskId);
    const contract = finalEvaluation
      ? null
      : await this.readJsonFile<SprintContract>(this.contractFile(workflowId, subtaskId, run.contractId));
    const taskGraph = finalEvaluation
      ? await this.readTaskGraphForWorkflow(await this.requireWorkflow(workflowId))
      : null;
    const mustCriteria = contract?.acceptanceCriteria.filter((criterion) => criterion.priority === 'must') || [];
    const criteriaResults = Array.isArray(result.criteriaResults) ? result.criteriaResults : [];
    const commandResults = Array.isArray(result.commandResults) ? result.commandResults : [];
    const runtimeFindings = Array.isArray(result.runtimeFindings) ? result.runtimeFindings : [];
    const coverageGaps = Array.isArray(result.coverageGaps) ? result.coverageGaps : [];
    const artifactGaps = await validateEvaluationArtifactRefs(
      this.rootPath,
      workflowId,
      run,
      criteriaResults,
      commandResults,
    );
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
    const requiredCommands = contract
      ? contract.verificationPlan.commands.filter((command) => command.required)
      : (taskGraph?.finalValidationCommands || []).map((command) => ({ id: command, command }));
    const requiredCommandChecks = requiredCommands.map((required) => ({
      required,
      result: commandResults.find((command) => command.commandId === required.id || command.command === required.command),
    }));
    const failedRequiredCommands = requiredCommandChecks.filter(({ result: command }) =>
      command?.status === 'failed' || command?.status === 'timeout'
    );
    const missingRequiredCommands = requiredCommandChecks.filter(({ result: command }) =>
      !command || command.status === 'skipped'
    );
    const commandGaps = [...failedRequiredCommands, ...missingRequiredCommands].map(({ required }) => ({
      criterionId: required.id,
      description: `Required evaluation command ${required.id} did not pass.`,
      reason: 'Required evaluation command did not pass.',
    }));
    const nextCoverageGaps = mergeCoverageGaps(coverageGaps, [
      ...missingEvidence,
      ...missingCriteriaGaps,
      ...commandGaps,
      ...artifactGaps,
    ]);
    if (result.verdict === 'pass' && failedRequiredCommands.length > 0) {
      return {
        ...result,
        verdict: 'fail',
        criteriaResults,
        commandResults,
        runtimeFindings,
        coverageGaps: nextCoverageGaps,
        confidence: Math.min(result.confidence, 0.25),
      };
    }
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

  async createQuestionerRun(
    workflowId: string,
    input: CreateQuestionerRunInput,
  ): Promise<{ run: QuestionerRun; invocation: AgentInvocationRecord; context: QuestionerContextV1; token: string }> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.createQuestionerRun(id, input));
    }
    const workflow = await this.requireWorkflow(id);
    if (input.subtaskId) {
      await this.requireSubtask(id, input.subtaskId);
    }
    const runId = this.normalizeId(input.id || `qr_${generateId().slice(0, 10)}`);
    const invocationId = this.normalizeId(input.invocationId || `inv_questioner_${generateId().slice(0, 10)}`);
    if (await this.readQuestionerRun(id, runId)) {
      throw new MultiAgentCoordinationError('version_conflict', `QuestionerRun already exists: ${runId}.`);
    }
    if (await this.readInvocation(id, invocationId)) {
      throw new MultiAgentCoordinationError('version_conflict', `Agent invocation already exists: ${invocationId}.`);
    }
    const token = `tqr_${randomBytes(24).toString('base64url')}`;
    const now = new Date().toISOString();
    const tokenExpiresAt = new Date(Date.parse(now) + (input.tokenTtlMs ?? 60 * 60 * 1000)).toISOString();
    const contextArtifactRef = `.tik/multi-agent/workflows/${id}/questioner-runs/${runId}/context.json`;
    const expectedOutputArtifactRef = `.tik/multi-agent/workflows/${id}/questioner-runs/${runId}/output.json`;
    const submitUrl = `/v1/multi-agent/workflows/${encodeURIComponent(id)}/questioner-runs/${encodeURIComponent(runId)}/output`;
    const invocation = await this.createInvocation(id, {
      id: invocationId,
      workflowId: id,
      subtaskId: input.subtaskId,
      role: 'questioner',
      runner: 'claude-code',
      promptContract: 'claude-questioner.v2',
      input: {
        goal: workflow.goal,
        intent: input.intent,
        subtaskId: input.subtaskId,
        contractId: input.contractId,
        evaluationRunId: input.finalEvaluationRunId ? undefined : input.evaluationRunId,
        finalEvaluationRunId: input.finalEvaluationRunId,
        headSha: input.headSha,
        questionerRunId: runId,
        contextArtifactRef,
        expectedOutputArtifactRef,
        contextUrl: `/v1/multi-agent/workflows/${encodeURIComponent(id)}/questioner-runs/${encodeURIComponent(runId)}/context`,
        submitUrl,
        runtimeEnv: {
          TIK_QUESTIONER_RUN_ID: runId,
          TIK_QUESTIONER_CONTEXT_URL: `/api${submitUrl.replace(/\/output$/, '/context')}`,
          TIK_QUESTIONER_SUBMIT_URL: `/api${submitUrl}`,
          TIK_EXPECTED_HEAD_SHA: input.headSha,
          TIK_QUESTIONER_OUTPUT_PATH: expectedOutputArtifactRef,
        },
        runtimePolicy: defaultQuestionerRuntimePolicy(),
      },
      headSha: input.headSha,
      evaluationRunId: input.evaluationRunId || input.finalEvaluationRunId,
      nativeRuntimeOwned: input.nativeRuntimeOwned,
      readonlyPolicy: {
        enforced: true,
        allowedWritePaths: input.runtimeAudit?.allowedWritePaths || defaultQuestionerReadonlyPolicy().allowedWritePaths,
        forbiddenWritePaths: input.runtimeAudit?.forbiddenWritePaths || defaultQuestionerReadonlyPolicy().forbiddenWritePaths,
        violations: [],
        gitStatusBefore: input.runtimeAudit?.gitStatusBefore,
      },
    });
    const context = await buildQuestionerContext(await this.requireBundle(id), {
      workflowId: id,
      questionerRunId: runId,
      invocationId: invocation.id,
      intent: input.intent,
      subtaskId: input.subtaskId,
      contractId: input.contractId,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
      headSha: input.headSha,
      submitUrl,
    });
    const rawEstimate = estimateContextTokens(context);
    // Try slimming before rejecting on budget — verbose stdout/stderr and
    // trailing coverage gaps blow past 12k on evaluations with a few
    // multi-command runs, even when the actual signal is small. The slim
    // pass truncates commandResults output but preserves verdict/counts.
    let finalContext = context;
    let finalEstimate = rawEstimate;
    if (rawEstimate > QUESTIONER_CONTEXT_TOKEN_BUDGET) {
      finalContext = slimQuestionerContext(context);
      finalEstimate = estimateContextTokens(finalContext);
    }
    if (finalEstimate > QUESTIONER_CONTEXT_TOKEN_BUDGET) {
      await this.updateInvocation(id, invocation.id, {
        status: 'cancelled',
        error: `context_budget_exceeded: estimated ${finalEstimate} tokens (raw ${rawEstimate}, after slim ${finalEstimate}), budget ${QUESTIONER_CONTEXT_TOKEN_BUDGET}.`,
      });
      throw new MultiAgentCoordinationError(
        'context_budget_exceeded',
        `Questioner context estimated ${finalEstimate} tokens exceeds budget ${QUESTIONER_CONTEXT_TOKEN_BUDGET}.`,
      );
    }
    const boundedInvocation = await this.updateInvocation(id, invocation.id, {
      status: 'created',
      contextBundleHash: finalContext.run.contextHash,
      estimatedContextTokens: finalEstimate,
      contextTokenBudget: QUESTIONER_CONTEXT_TOKEN_BUDGET,
      cleanContext: true,
    });
    const run: QuestionerRun = {
      id: runId,
      workflowId: id,
      subtaskId: input.subtaskId,
      intent: input.intent,
      status: input.start === false ? 'created' : 'started',
      invocationId: boundedInvocation.id,
      runner: 'claude-code',
      pluginSkill: 'question-tik-agent-loop',
      contractId: input.contractId,
      evaluationRunId: input.evaluationRunId,
      finalEvaluationRunId: input.finalEvaluationRunId,
      headSha: input.headSha,
      contextArtifactRef,
      contextHash: finalContext.run.contextHash,
      expectedOutputArtifactRef,
      tokenId: `tok_${generateId().slice(0, 10)}`,
      tokenHash: hashQuestionerToken(token),
      tokenExpiresAt,
      runtimePolicy: defaultQuestionerRuntimePolicy(),
      readonlyAudit: {
        enforced: true,
        allowedWritePaths: input.runtimeAudit?.allowedWritePaths || defaultQuestionerReadonlyPolicy().allowedWritePaths,
        forbiddenWritePaths: input.runtimeAudit?.forbiddenWritePaths || defaultQuestionerReadonlyPolicy().forbiddenWritePaths,
        violations: [],
        gitStatusBefore: input.runtimeAudit?.gitStatusBefore,
        workspaceFingerprintBefore: input.runtimeAudit?.workspaceFingerprintBefore,
      },
      createdAt: now,
      startedAt: input.start === false ? undefined : now,
    };
    await this.writeJsonFileAtomic(this.questionerRunFile(id, run.id), run);
    await this.writeJsonFileAtomic(this.questionerRunContextFile(id, run.id), finalContext);
    await this.appendEvent(id, 'questioner.run.created', 'tik', {
      questionerRunId: run.id,
      invocationId: invocation.id,
      intent: run.intent,
      subtaskId: run.subtaskId,
      contextHash: run.contextHash,
    });
    if (input.start !== false) {
      await this.updateInvocation(id, boundedInvocation.id, { status: 'started' });
      await this.appendEvent(id, 'questioner.run.started', 'tik', {
        questionerRunId: run.id,
        invocationId: invocation.id,
      });
      const startedInvocation = await this.readInvocation(id, boundedInvocation.id);
      return { run, invocation: startedInvocation || boundedInvocation, context: finalContext, token };
    }
    return { run, invocation: boundedInvocation, context: finalContext, token };
  }

  async readQuestionerRun(workflowId: string, runId: string): Promise<QuestionerRun | null> {
    const id = this.normalizeId(workflowId);
    return this.readJsonFile<QuestionerRun>(this.questionerRunFile(id, this.normalizeId(runId)));
  }

  async startQuestionerRunRuntime(
    workflowId: string,
    runId: string,
    runtimeRef: string,
  ): Promise<{ run: QuestionerRun; invocation: AgentInvocationRecord }> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const run = await this.requireQuestionerRun(id, runId);
      if (run.status !== 'created') {
        throw new MultiAgentCoordinationError('invalid_transition', `QuestionerRun ${run.id} is ${run.status}, expected created.`);
      }
      const invocation = await this.updateInvocation(id, run.invocationId, {
        status: 'started',
        threadId: runtimeRef,
        actualSubagentThreadId: runtimeRef,
      });
      const now = new Date().toISOString();
      const started: QuestionerRun = {
        ...run,
        status: 'started',
        startedAt: now,
      };
      await this.writeJsonFileAtomic(this.questionerRunFile(id, run.id), started);
      await this.appendEvent(id, 'questioner.run.started', 'tik', {
        questionerRunId: run.id,
        invocationId: invocation.id,
        runtimeRef,
      });
      return { run: started, invocation };
    });
  }

  async readQuestionerRunContext(
    workflowId: string,
    runId: string,
    token?: string,
  ): Promise<{ run: QuestionerRun; context: QuestionerContextV1 }> {
    const id = this.normalizeId(workflowId);
    const run = await this.requireQuestionerRun(id, runId);
    const tokenGuard = validateQuestionerRunToken(run, token);
    if (!tokenGuard.accepted) {
      throw new MultiAgentCoordinationError(tokenGuard.code || 'missing_evidence', tokenGuard.message || 'Invalid Questioner run token.');
    }
    const context = await this.readJsonFile<QuestionerContextV1>(this.questionerRunContextFile(id, run.id));
    if (!context) {
      throw new MultiAgentCoordinationError('missing_evidence', `QuestionerRun context not found: ${run.id}.`);
    }
    return { run, context };
  }

  async submitQuestionerRunOutput(
    workflowId: string,
    runId: string,
    input: SubmitQuestionerRunOutputInput,
  ): Promise<{ run: QuestionerRun; questionerOutput: QuestionerOutput; invocation: AgentInvocationRecord }> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.submitQuestionerRunOutput(id, runId, input));
    }
    const run = await this.requireQuestionerRun(id, runId);
    const tokenGuard = validateQuestionerRunToken(run, input.token, input.now);
    if (!tokenGuard.accepted) {
      await this.rejectQuestionerRun(id, run, tokenGuard.message || 'Invalid Questioner run token.');
      throw new MultiAgentCoordinationError(tokenGuard.code || 'missing_evidence', tokenGuard.message || 'Invalid Questioner run token.');
    }
    if (run.status !== 'created' && run.status !== 'started') {
      throw new MultiAgentCoordinationError(
        'invalid_transition',
        `QuestionerRun ${run.id} is ${run.status} and cannot accept another output.`,
      );
    }
    const context = await this.readJsonFile<QuestionerContextV1>(this.questionerRunContextFile(id, run.id));
    if (!context) {
      throw new MultiAgentCoordinationError('missing_evidence', `QuestionerRun context not found: ${run.id}.`);
    }
    const contract = run.contractId && run.subtaskId ? await this.requireContract(id, run.subtaskId, run.contractId) : undefined;
    const evaluation = run.evaluationRunId && run.subtaskId ? await this.requireEvaluationRun(id, run.subtaskId, run.evaluationRunId) : undefined;
    const finalEvaluation = run.finalEvaluationRunId
      ? await this.requireEvaluationRun(id, '__final__', run.finalEvaluationRunId)
      : undefined;
    const validation = validateQuestionerOutputV2({
      run,
      output: input.output,
      context,
      contract,
      evaluation,
      finalEvaluation,
    });
    if (!validation.accepted) {
      await this.rejectQuestionerRun(id, run, validation.message || 'Questioner output rejected.');
      await this.updateQuestionerCheckpointForRun(id, run, 'failed', 'invalid_output');
      throw new MultiAgentCoordinationError(validation.code || 'missing_evidence', validation.message || 'Questioner output rejected.');
    }

    const readonlyGuard = validateQuestionerReadonlyAudit(run, input.runtimeAudit);
    if (!readonlyGuard.accepted) {
      await this.rejectQuestionerRun(id, {
        ...run,
        readonlyAudit: readonlyGuard.audit,
      }, readonlyGuard.message || 'Questioner readonly audit failed.');
      await this.updateQuestionerCheckpointForRun(id, run, 'failed', 'readonly_violation');
      throw new MultiAgentCoordinationError(
        readonlyGuard.code || 'readonly_policy_violated',
        readonlyGuard.message || 'Questioner readonly audit failed.',
      );
    }

    await this.writeJsonFileAtomic(this.questionerRunOutputFile(id, run.id), input.output);
    const normalizedOutput = normalizeQuestionerOutputV2(input.output);
    const now = new Date().toISOString();
    const updatedRun: QuestionerRun = {
      ...run,
      status: 'validated',
      outputHash: input.output.attestation.outputHash,
      outputArtifactRef: input.output.attestation.outputArtifactRef,
      readonlyAudit: readonlyGuard.audit,
      completedAt: now,
    };
    await this.writeJsonFileAtomic(this.questionerRunFile(id, run.id), updatedRun);
    const invocation = await this.updateInvocation(id, run.invocationId, {
      status: 'completed',
      headSha: input.output.attestation.headSha,
      evaluationRunId: run.evaluationRunId || run.finalEvaluationRunId,
      readonlyPolicy: {
        enforced: true,
        allowedWritePaths: readonlyGuard.audit.allowedWritePaths,
        forbiddenWritePaths: readonlyGuard.audit.forbiddenWritePaths,
        violations: readonlyGuard.audit.violations,
        gitStatusBefore: readonlyGuard.audit.gitStatusBefore,
        gitStatusAfter: readonlyGuard.audit.gitStatusAfter,
      },
      result: {
        questionerRunId: run.id,
        evaluationRunId: run.evaluationRunId || run.finalEvaluationRunId,
        finalEvaluationRunId: run.finalEvaluationRunId,
        headSha: input.output.attestation.headSha,
        questionerOutput: normalizedOutput,
      },
    });
    const questionerOutput = await this.recordQuestionerOutput(id, normalizedOutput);
    await this.updateQuestionerCheckpointForRun(
      id,
      run,
      'passed',
      undefined,
      input.output.attestation.outputHash,
    );
    await this.appendEvent(id, 'questioner.run.output_received', 'claude-code', {
      questionerRunId: run.id,
      questionerOutputId: questionerOutput.id,
      outputHash: updatedRun.outputHash,
    });
    await this.appendEvent(id, 'questioner.run.validated', 'tik', {
      questionerRunId: run.id,
      questionerOutputId: questionerOutput.id,
    });
    return { run: updatedRun, questionerOutput, invocation };
  }

  async recordQuestionerOutput(
    workflowId: string,
    input: Omit<Partial<QuestionerOutput>, 'workflowId' | 'createdAt'> & {
      schemaVersion?: QuestionerOutput['schemaVersion'];
      questionerRunId?: string;
      intent: QuestionerOutput['intent'];
      actor: QuestionerOutput['actor'];
      source: QuestionerOutput['source'];
      headSha: string;
      evaluationRunId?: string;
      finalEvaluationRunId?: string;
      contractId?: string;
      artifactRef?: string;
      attestation?: QuestionerOutput['attestation'];
      references?: QuestionerOutput['references'];
      coverageMatrix?: QuestionerOutput['coverageMatrix'];
      verdict: QuestionerOutput['verdict'];
      questions?: QuestionerOutput['questions'];
      risks?: QuestionerOutput['risks'];
      missingTests?: QuestionerOutput['missingTests'];
      suggestedContractChanges?: QuestionerOutput['suggestedContractChanges'];
      advisoryNotes?: string[];
    },
  ): Promise<QuestionerOutput> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.recordQuestionerOutput(id, input));
    }
    await this.requireWorkflow(id);
    if (input.subtaskId) {
      await this.requireSubtask(id, input.subtaskId);
    }
    assertQuestionerRuntimeSource(input);
    if (!input.actor.invocationId) {
      throw new MultiAgentCoordinationError(
        'missing_evidence',
        'Questioner output must come from the Claude plugin and include invocationId, headSha, and artifactRef.',
      );
    }
    const invocationId = input.actor.invocationId;
    const invocation = await this.readInvocation(id, invocationId);
    const outputIdCandidate = input.id || readQuestionerOutputFromInvocationResult(
      invocation?.result,
    )?.id;
    if (invocation && !outputIdCandidate) {
      throw new MultiAgentCoordinationError(
        'missing_evidence',
        'Questioner output id must be provided by the Claude plugin invocation result.',
      );
    }
    const outputId = this.normalizeId(outputIdCandidate || '');
    const inputWithId = {
      ...input,
      id: outputId,
    };
    await this.assertQuestionerInvocationProvesOutput(id, inputWithId);
    const output: QuestionerOutput = {
      schemaVersion: input.schemaVersion,
      id: outputId,
      questionerRunId: input.questionerRunId,
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
      attestation: input.attestation,
      references: input.references,
      coverageMatrix: input.coverageMatrix,
      verdict: input.verdict,
      questions: input.questions || [],
      risks: input.risks || [],
      missingTests: input.missingTests || [],
      suggestedContractChanges: input.suggestedContractChanges || [],
      advisoryNotes: input.advisoryNotes || [],
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

  private async assertQuestionerInvocationProvesOutput(
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
    },
  ): Promise<void> {
    const invocationId = input.actor.invocationId;
    const invocation = invocationId ? await this.readInvocation(workflowId, invocationId) : null;
    if (!invocation) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        'Questioner output must reference a Tik-owned Claude Questioner invocation.',
      );
    }
    if (invocation.role !== 'questioner' || invocation.runner !== 'claude-code') {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Questioner output invocation ${invocation.id} must be role=questioner and runner=claude-code.`,
      );
    }
    if (invocation.status !== 'completed') {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Questioner output invocation ${invocation.id} must be completed before output can be recorded.`,
      );
    }
    if ((invocation.subtaskId || input.subtaskId) && invocation.subtaskId !== input.subtaskId) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Questioner output subtask ${input.subtaskId || '(none)'} does not match invocation subtask ${invocation.subtaskId || '(none)'}.`,
      );
    }
    if (invocation.headSha && invocation.headSha !== input.headSha) {
      throw new MultiAgentCoordinationError(
        'head_sha_mismatch',
        `Questioner output head ${input.headSha} does not match invocation head ${invocation.headSha}.`,
      );
    }
    const invocationEvaluationRunId = invocation.evaluationRunId || readStringFromRecord(invocation.result, 'evaluationRunId');
    const inputEvaluationRunId = input.evaluationRunId || input.finalEvaluationRunId;
    if (invocationEvaluationRunId && invocationEvaluationRunId !== inputEvaluationRunId) {
      throw new MultiAgentCoordinationError(
        'missing_evidence',
        `Questioner output evaluation ${inputEvaluationRunId || '(none)'} does not match invocation evaluation ${invocationEvaluationRunId}.`,
      );
    }
    const resultOutput = readQuestionerOutputFromInvocationResult(invocation.result);
    if (!resultOutput) {
      throw new MultiAgentCoordinationError(
        'missing_evidence',
        `Questioner invocation ${invocation.id} result must include questionerOutput.`,
      );
    }
    assertQuestionerResultFieldMatches(input, resultOutput, 'id');
    assertQuestionerResultFieldMatches(input, resultOutput, 'subtaskId');
    assertQuestionerResultFieldMatches(input, resultOutput, 'intent');
    assertQuestionerResultFieldMatches(input, resultOutput, 'source');
    assertQuestionerResultFieldMatches(input, resultOutput, 'headSha');
    assertQuestionerResultFieldMatches(input, resultOutput, 'evaluationRunId');
    assertQuestionerResultFieldMatches(input, resultOutput, 'finalEvaluationRunId');
    assertQuestionerResultFieldMatches(input, resultOutput, 'contractId');
    assertQuestionerResultFieldMatches(input, resultOutput, 'artifactRef');
    assertQuestionerResultFieldMatches(input, resultOutput, 'verdict');
    assertQuestionerResultFieldMatches(input, resultOutput, 'questions');
    assertQuestionerResultFieldMatches(input, resultOutput, 'risks');
    assertQuestionerResultFieldMatches(input, resultOutput, 'missingTests');
    assertQuestionerResultFieldMatches(input, resultOutput, 'suggestedContractChanges');
    const resultInvocationId = resultOutput.actor?.invocationId;
    if (resultInvocationId && resultInvocationId !== invocation.id) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Questioner invocation result references ${resultInvocationId}, expected ${invocation.id}.`,
      );
    }
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

  async recordQuestionResolution(
    workflowId: string,
    input: Omit<Partial<QuestionResolution>, 'workflowId' | 'createdAt'> & {
      questionerOutputId: string;
      questionId: string;
      status: QuestionResolution['status'];
      evidenceRefs: string[];
      explanation: string;
    },
  ): Promise<QuestionResolution> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.recordQuestionResolution(id, input));
    }
    await this.requireWorkflow(id);
    const output = (await this.readQuestionerOutputs(id)).find((candidate) => candidate.id === input.questionerOutputId);
    if (!output) {
      throw new MultiAgentCoordinationError('missing_evidence', `QuestionerOutput not found: ${input.questionerOutputId}.`);
    }
    const question = output.questions.find((candidate) => candidate.id === input.questionId);
    if (!question) {
      throw new MultiAgentCoordinationError('missing_evidence', `Question not found in QuestionerOutput: ${input.questionId}.`);
    }
    if (question.priority === 'blocking' && input.status !== 'resolved' && !input.resolvedByHuman) {
      throw new MultiAgentCoordinationError(
        'blocking_question_unresolved',
        'Blocking Questioner questions require status=resolved unless a human resolver is recorded.',
      );
    }
    if (!input.explanation.trim()) {
      throw new MultiAgentCoordinationError('missing_evidence', 'QuestionResolution explanation is required.');
    }
    if (!input.resolvedByInvocationId && !input.resolvedByHuman) {
      throw new MultiAgentCoordinationError('missing_evidence', 'QuestionResolution must record resolvedByInvocationId or resolvedByHuman.');
    }
    const resolution: QuestionResolution = {
      id: this.normalizeId(input.id || `qres_${generateId().slice(0, 10)}`),
      workflowId: id,
      questionerOutputId: output.id,
      questionId: question.id,
      status: input.status,
      resolvedByInvocationId: input.resolvedByInvocationId,
      resolvedByHuman: input.resolvedByHuman,
      evidenceRefs: input.evidenceRefs || [],
      explanation: input.explanation,
      createdAt: new Date().toISOString(),
    };
    await fs.mkdir(this.questionResolutionsDir(id), { recursive: true });
    await this.writeJsonFileAtomic(this.questionResolutionFile(id, resolution.id), resolution);
    await this.appendEvent(id, 'question.resolution.recorded', 'codex-workflow', {
      questionResolutionId: resolution.id,
      questionerOutputId: resolution.questionerOutputId,
      questionId: resolution.questionId,
      status: resolution.status,
    });
    return resolution;
  }

  async createInvocation(workflowId: string, input: CreateAgentInvocationInput): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.createInvocation(id, input));
    }
    await this.requireWorkflow(id);
    const invocationId = this.normalizeId(input.id || `inv_${generateId()}`);
    if (await this.readInvocation(id, invocationId)) {
      throw new MultiAgentCoordinationError('version_conflict', `Agent invocation already exists: ${invocationId}.`);
    }
    const now = new Date().toISOString();
    const invocation: AgentInvocationRecord = {
      id: invocationId,
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
      nativeRuntimeOwned: input.nativeRuntimeOwned,
      contextBundleHash: input.contextBundleHash,
      estimatedContextTokens: input.estimatedContextTokens,
      contextTokenBudget: input.contextTokenBudget,
      cleanContext: input.cleanContext,
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

  async attestNativeInvocationStart(
    workflowId: string,
    invocationId: string,
    input: NativeInvocationStartInput,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const existing = await this.readInvocation(id, invocationId);
      if (!existing) {
        throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
      }
      if (!requiresRuntimeAttestation(existing)) {
        throw new MultiAgentCoordinationError('invalid_invocation_status', `Invocation ${invocationId} is not a Codex runtime invocation.`);
      }
      assertInvocationTransition(existing.status, 'started');
      if (input.role !== existing.role || !input.parentThreadId || !input.actualSubagentThreadId || !input.nonce) {
        throw new MultiAgentCoordinationError(
          'missing_subagent_invocation',
          `Tik-owned invocation ${existing.id} requires matching role, parent thread, native thread, and nonce.`,
        );
      }
      const now = new Date().toISOString();
      const startedAt = input.startedAt || now;
      const updated: AgentInvocationRecord = {
        ...existing,
        status: 'started',
        threadId: input.actualSubagentThreadId,
        actualSubagentThreadId: input.actualSubagentThreadId,
        parentThreadId: input.parentThreadId,
        hookAttested: true,
        attestationStartedAt: startedAt,
        runtimeAttestation: {
          source: 'codex-subagent-runtime',
          parentThreadId: input.parentThreadId,
          actualSubagentThreadId: input.actualSubagentThreadId,
          role: existing.role,
          nonce: input.nonce,
          startedAt,
        },
        startedAt,
        updatedAt: now,
      };
      await this.upsertInvocation(updated);
      await this.appendEvent(id, 'agent_invocation.started', 'tik', {
        invocationId: updated.id,
        status: updated.status,
        attestationSource: 'codex-subagent-runtime',
        actualSubagentThreadId: updated.actualSubagentThreadId,
      });
      return updated;
    });
  }

  async completeNativeInvocation(
    workflowId: string,
    invocationId: string,
    input: NativeInvocationCompletionInput,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const existing = await this.requireNativeInvocation(id, invocationId, 'started');
      assertInvocationTransition(existing.status, input.status);
      const now = new Date().toISOString();
      const stoppedAt = input.stoppedAt || now;
      const evidenceRefs = mergeUnique(existing.evidenceRefs, input.evidenceRefs);
      const readonlyPolicy = input.readonlyPolicy ?? readReadonlyPolicyFromRecord(input.result) ?? existing.readonlyPolicy;
      const updated: AgentInvocationRecord = {
        ...existing,
        status: input.status,
        result: input.result ?? existing.result,
        error: input.error ?? existing.error,
        headSha: input.headSha ?? readStringFromRecord(input.result, 'headSha') ?? existing.headSha,
        evidenceRefs,
        evaluationRunId: input.evaluationRunId ?? readStringFromRecord(input.result, 'evaluationRunId') ?? existing.evaluationRunId,
        readonlyPolicy,
        runtimeAttestation: {
          ...existing.runtimeAttestation!,
          stoppedAt,
          headSha: input.headSha ?? readStringFromRecord(input.result, 'headSha') ?? existing.headSha,
          evidenceRefs,
          readonlyPolicy,
        },
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
        attestationSource: 'codex-subagent-runtime',
      });
      return updated;
    });
  }

  async linkNativeInvocationResult(
    workflowId: string,
    invocationId: string,
    input: Omit<NativeInvocationCompletionInput, 'status' | 'stoppedAt'>,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    return this.withWorkflowMutation(id, async () => {
      const existing = await this.requireNativeInvocation(id, invocationId, 'completed');
      const requestedHeadSha = input.headSha ?? readStringFromRecord(input.result, 'headSha');
      if (requestedHeadSha && existing.headSha && requestedHeadSha !== existing.headSha) {
        throw new MultiAgentCoordinationError(
          'head_sha_mismatch',
          `Native invocation ${existing.id} completed at ${existing.headSha}, not ${requestedHeadSha}.`,
        );
      }
      const evidenceRefs = mergeUnique(existing.evidenceRefs, input.evidenceRefs);
      const readonlyPolicy = mergeReadonlyPolicies(
        existing.readonlyPolicy,
        input.readonlyPolicy ?? readReadonlyPolicyFromRecord(input.result),
      );
      const headSha = existing.headSha || requestedHeadSha;
      const updated: AgentInvocationRecord = {
        ...existing,
        result: { ...(existing.result || {}), ...(input.result || {}) },
        error: input.error ?? existing.error,
        headSha,
        evidenceRefs,
        evaluationRunId: input.evaluationRunId ?? readStringFromRecord(input.result, 'evaluationRunId') ?? existing.evaluationRunId,
        readonlyPolicy,
        runtimeAttestation: {
          ...existing.runtimeAttestation!,
          headSha,
          evidenceRefs,
          readonlyPolicy,
        },
        updatedAt: new Date().toISOString(),
      };
      await this.upsertInvocation(updated);
      await this.appendEvent(id, 'agent_invocation.completed', 'tik', {
        invocationId: updated.id,
        status: updated.status,
        attestationSource: 'codex-subagent-runtime',
        resultLinked: true,
      });
      return updated;
    });
  }

  async failQuestionerRunRuntime(workflowId: string, runId: string, message: string): Promise<QuestionerRun> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.failQuestionerRunRuntime(id, runId, message));
    }
    const run = await this.requireQuestionerRun(id, runId);
    if (run.status === 'validated' || run.status === 'rejected' || run.status === 'expired') return run;
    const rejected = await this.rejectQuestionerRun(id, run, message);
    await this.updateQuestionerCheckpointForRun(id, run, 'failed', 'infra_failure');
    const invocation = await this.readInvocation(id, run.invocationId);
    if (invocation?.status === 'created' || invocation?.status === 'started') {
      await this.updateInvocation(id, invocation.id, { status: 'failed', error: message });
    }
    return rejected;
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
      const recoverableCreated = invocation.status === 'created' && invocation.nativeRuntimeOwned === true;
      if (invocation.status !== 'started' && !recoverableCreated) continue;
      const startedAt = Date.parse(invocation.startedAt || invocation.updatedAt || invocation.createdAt);
      if (!Number.isFinite(startedAt) || nowMs - startedAt <= timeoutMs) continue;
      let updated: AgentInvocationRecord;
      if (invocation.role === 'questioner') {
        const runs = await this.readQuestionerRuns(id);
        const run = runs.find((candidate) => candidate.invocationId === invocation.id);
        if (run && (run.status === 'created' || run.status === 'started')) {
          await this.failQuestionerRunRuntime(id, run.id, 'stalled');
          updated = await this.readInvocation(id, invocation.id) || invocation;
        } else {
          updated = await this.failStalledInvocation(invocation, nowMs);
        }
      } else {
        updated = await this.failStalledInvocation(invocation, nowMs);
      }
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

  async failOrphanedCreatedNativeInvocation(
    workflowId: string,
    invocationId: string,
    error: string,
  ): Promise<AgentInvocationRecord> {
    const id = this.normalizeId(workflowId);
    if (!this.isWorkflowMutationActive(id)) {
      return this.withWorkflowMutation(id, () => this.failOrphanedCreatedNativeInvocation(id, invocationId, error));
    }
    const invocation = await this.readInvocation(id, invocationId);
    if (!invocation) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    if (invocation.status !== 'created' || invocation.nativeRuntimeOwned !== true) {
      throw new MultiAgentCoordinationError(
        'invalid_invocation_status',
        `Invocation ${invocation.id} is not a Tik-owned created native invocation.`,
      );
    }
    const now = new Date().toISOString();
    const updated: AgentInvocationRecord = {
      ...invocation,
      status: 'failed',
      error,
      updatedAt: now,
      completedAt: now,
    };
    await this.upsertInvocation(updated);
    await this.appendEvent(id, 'agent_invocation.completed', 'tik', {
      invocationId: updated.id,
      status: updated.status,
      reason: 'orphaned_native_runtime',
    });
    return updated;
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
      contextBundleHash?: string;
      estimatedContextTokens?: number;
      contextTokenBudget?: number;
      cleanContext?: boolean;
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
      contextBundleHash: patch.contextBundleHash ?? existing.contextBundleHash,
      estimatedContextTokens: patch.estimatedContextTokens ?? existing.estimatedContextTokens,
      contextTokenBudget: patch.contextTokenBudget ?? existing.contextTokenBudget,
      cleanContext: patch.cleanContext ?? existing.cleanContext,
      updatedAt: now,
      startedAt: patch.status === 'started' ? now : existing.startedAt,
      completedAt: patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled'
        ? now
        : existing.completedAt,
    };
    await this.upsertInvocation(updated);
    if (existing.status !== patch.status) {
      await this.appendEvent(
        id,
        patch.status === 'started' ? 'agent_invocation.started' : 'agent_invocation.completed',
        'tik',
        {
          invocationId: updated.id,
          status: updated.status,
        },
      );
    }
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
    if (!input.nonce || !input.parentThreadId || !input.actualSubagentThreadId) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} hook attestation must include nonce, parentThreadId, and actualSubagentThreadId.`,
      );
    }
    if (!input.nonce) {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Codex invocation ${existing.id} hook attestation must include nonce.`,
      );
    }

    const now = new Date().toISOString();
    const startedAt = input.startedAt || now;
    const runtimeAttestation: AgentInvocationRecord['runtimeAttestation'] = {
      source: 'codex-plugin-hook',
      parentThreadId: input.parentThreadId,
      actualSubagentThreadId: input.actualSubagentThreadId,
      role: existing.role,
      nonce: input.nonce,
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
    const updated = await this.prepareInvocationStop(id, invocationId, input);
    await this.upsertInvocation(updated);
    await this.appendEvent(id, 'agent_invocation.completed', 'tik', {
      invocationId: updated.id,
      status: updated.status,
      hookAttested: true,
    });
    return updated;
  }

  async prepareInvocationStop(
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
    return {
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

  private async requireNativeInvocation(
    workflowId: string,
    invocationId: string,
    expectedStatus: 'started' | 'completed',
  ): Promise<AgentInvocationRecord> {
    const invocation = await this.readInvocation(workflowId, invocationId);
    if (!invocation) {
      throw new MultiAgentCoordinationError('invocation_not_found', `Agent invocation not found: ${invocationId}.`);
    }
    if (invocation.status !== expectedStatus || invocation.runtimeAttestation?.source !== 'codex-subagent-runtime') {
      throw new MultiAgentCoordinationError(
        'missing_subagent_invocation',
        `Invocation ${invocation.id} is not a ${expectedStatus} Tik-owned native Codex invocation.`,
      );
    }
    return invocation;
  }

  private async prepareAcceptedContract(
    workflowId: string,
    subtaskId: string,
    contractId: string,
    input: {
      acceptedBy?: SprintContract['acceptedBy'];
      headShaAtAcceptance?: string;
      questionerOutputRefs?: string[];
    },
  ): Promise<SprintContract> {
    const workflow = await this.requireWorkflow(workflowId);
    if (workflow.mode === 'review') {
      throw new MultiAgentCoordinationError('invalid_transition', 'Review workflows do not accept SprintContracts.');
    }
    const contract = await this.requireContract(workflowId, subtaskId, contractId);
    const latest = await this.readLatestContract(workflowId, subtaskId);
    if (!latest || latest.id !== contract.id) {
      throw new MultiAgentCoordinationError(
        'version_conflict',
        `Contract ${contractId} is stale; latest Contract for ${subtaskId} is ${latest?.id || 'missing'}.`,
      );
    }
    if (workflow.policy?.requireQuestionerBeforeBuild) {
      const bundle = await this.requireBundle(workflowId);
      const headShaAtAcceptance = input.headShaAtAcceptance || contract.headShaAtAcceptance || workflow.currentHeadSha || '';
      const questioner = latestMatchingStrictQuestionerOutput(bundle, {
        subtaskId,
        intent: 'question_contract',
        contractId: contract.id,
        headSha: headShaAtAcceptance,
      });
      if (!questioner) {
        throw new MultiAgentCoordinationError(
          'missing_evidence',
          'Contract requires a validated Claude Questioner challenge before acceptance.',
        );
      }
      if (hasBlockingQuestionerQuestions(bundle, questioner)) {
        throw new MultiAgentCoordinationError(
          'blocking_question_unresolved',
          'Contract Questioner still has unresolved blocking or evidence-needed questions.',
        );
      }
    }
    return {
      ...contract,
      status: 'accepted',
      acceptedBy: input.acceptedBy || 'codex-workflow-plugin',
      acceptedAt: new Date().toISOString(),
      headShaAtAcceptance: input.headShaAtAcceptance || contract.headShaAtAcceptance,
      questionerOutputRefs: mergeUnique(contract.questionerOutputRefs, input.questionerOutputRefs),
    };
  }

  private async requireBundle(workflowId: string): Promise<MultiAgentWorkflowBundle> {
    const bundle = await this.readBundle(workflowId);
    if (!bundle) {
      throw new MultiAgentCoordinationError('workflow_not_found', `Multi-agent workflow not found: ${workflowId}.`);
    }
    return bundle;
  }

  private async listWorkflows(): Promise<MultiAgentWorkflowRecord[]> {
    try {
      const entries = await fs.readdir(this.rootDir(), { withFileTypes: true });
      const workflows = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readJsonFile<MultiAgentWorkflowRecord>(this.workflowFile(entry.name))));
      return workflows
        .filter((workflow): workflow is MultiAgentWorkflowRecord => Boolean(workflow))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
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

  private async readQuestionerRuns(workflowId: string): Promise<QuestionerRun[]> {
    try {
      const entries = await fs.readdir(this.questionerRunsDir(workflowId), { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readJsonFile<QuestionerRun>(this.questionerRunFile(workflowId, entry.name))));
      return records
        .filter((item): item is QuestionerRun => Boolean(item?.id && item.workflowId && item.contextHash))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readQuestionResolutions(workflowId: string): Promise<QuestionResolution[]> {
    try {
      const entries = await fs.readdir(this.questionResolutionsDir(workflowId));
      const records = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => this.readJsonFile<QuestionResolution>(path.join(this.questionResolutionsDir(workflowId), entry))));
      return records
        .filter((item): item is QuestionResolution => Boolean(item?.id && item.workflowId && item.questionerOutputId && item.questionId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async requireQuestionerRun(workflowId: string, runId: string): Promise<QuestionerRun> {
    const run = await this.readQuestionerRun(workflowId, runId);
    if (!run) {
      throw new MultiAgentCoordinationError('questioner_run_not_found', `QuestionerRun not found: ${runId}.`);
    }
    return run;
  }

  private async rejectQuestionerRun(workflowId: string, run: QuestionerRun, reason: string): Promise<QuestionerRun> {
    const rejected: QuestionerRun = {
      ...run,
      status: 'rejected',
      rejectionReason: reason,
      completedAt: new Date().toISOString(),
    };
    await this.writeJsonFileAtomic(this.questionerRunFile(workflowId, run.id), rejected);
    await this.appendEvent(workflowId, 'questioner.run.rejected', 'tik', {
      questionerRunId: run.id,
      reason,
    });
    return rejected;
  }

  private async failStalledInvocation(
    invocation: AgentInvocationRecord,
    nowMs: number,
  ): Promise<AgentInvocationRecord> {
    const updated: AgentInvocationRecord = {
      ...invocation,
      status: 'failed',
      error: 'stalled',
      updatedAt: new Date(nowMs).toISOString(),
      completedAt: new Date(nowMs).toISOString(),
    };
    await this.upsertInvocation(updated);
    return updated;
  }

  private async updateQuestionerCheckpointForRun(
    workflowId: string,
    run: QuestionerRun,
    status: 'passed' | 'failed',
    failureClass?: EvaluationFailureClass,
    outputHash?: string,
  ): Promise<void> {
    const evaluationRunId = run.finalEvaluationRunId || run.evaluationRunId;
    const subtaskId = run.finalEvaluationRunId ? '__final__' : run.subtaskId;
    if (!evaluationRunId || !subtaskId) return;
    const evaluation = await this.requireEvaluationRun(workflowId, subtaskId, evaluationRunId).catch(() => null);
    if (!evaluation) return;
    const now = new Date().toISOString();
    await this.updateEvaluationRun(workflowId, subtaskId, evaluationRunId, {
      failureClass,
      resumeFromStage: status === 'failed' ? 'questioner' : undefined,
      checkpoints: upsertEvaluationCheckpoint(evaluation.checkpoints || [], {
        stage: 'questioner',
        status,
        inputHash: run.contextHash,
        outputHash,
        failureClass,
        artifactRefs: [run.contextArtifactRef, run.outputArtifactRef].filter((item): item is string => Boolean(item)),
        startedAt: run.startedAt || run.createdAt,
        completedAt: now,
      }),
    });
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
    await this.appendEvents(workflowId, [{ type, actor, payload }]);
  }

  private async appendEvents(
    workflowId: string,
    inputs: Array<Pick<MultiAgentWorkflowEvent, 'type' | 'actor' | 'payload'>>,
  ): Promise<void> {
    if (inputs.length === 0) return;
    await this.withWorkflowMutation(workflowId, async () => {
      const events = inputs.map((input): MultiAgentWorkflowEvent => ({
        id: generateId(),
        workflowId,
        type: input.type,
        actor: input.actor,
        timestamp: new Date().toISOString(),
        payload: input.payload,
      }));
      await fs.mkdir(this.workflowDir(workflowId), { recursive: true });
      await fs.appendFile(
        this.eventsFile(workflowId),
        `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf-8',
      );
      const workflow = await this.readWorkflow(workflowId);
      if (workflow) {
        const durableEventCount = (await this.readJsonLines<MultiAgentWorkflowEvent>(this.eventsFile(workflowId))).length;
        await this.writeWorkflow({
          ...workflow,
          revision: durableEventCount,
          updatedAt: events[events.length - 1].timestamp,
        });
      }
    });
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

  private workflowMutationLockDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), '.mutation.lock');
  }

  private workflowTransactionFile(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), '.transaction.json');
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

  private questionResolutionsDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'question-resolutions');
  }

  private questionResolutionFile(workflowId: string, resolutionId: string): string {
    return path.join(this.questionResolutionsDir(workflowId), `${resolutionId}.json`);
  }

  private questionerRunsDir(workflowId: string): string {
    return path.join(this.workflowDir(workflowId), 'questioner-runs');
  }

  private questionerRunDir(workflowId: string, runId: string): string {
    return path.join(this.questionerRunsDir(workflowId), runId);
  }

  private questionerRunFile(workflowId: string, runId: string): string {
    return path.join(this.questionerRunDir(workflowId, runId), 'run.json');
  }

  private questionerRunContextFile(workflowId: string, runId: string): string {
    return path.join(this.questionerRunDir(workflowId, runId), 'context.json');
  }

  private questionerRunOutputFile(workflowId: string, runId: string): string {
    return path.join(this.questionerRunDir(workflowId, runId), 'output.json');
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

  private async withWorkflowMutation<T>(workflowId: string, mutation: () => Promise<T>): Promise<T> {
    const activeWorkflows = this.mutationContext.getStore();
    if (activeWorkflows?.has(workflowId)) {
      return mutation();
    }
    const previous = this.mutationQueues.get(workflowId) || Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.mutationQueues.set(workflowId, queued);
    await previous.catch(() => undefined);
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      releaseFileLock = await this.acquireWorkflowFileLock(workflowId);
      const nextContext = new Set(activeWorkflows || []);
      nextContext.add(workflowId);
      return await this.mutationContext.run(nextContext, async () => {
        await this.recoverWorkflowTransaction(workflowId);
        return mutation();
      });
    } finally {
      try {
        await releaseFileLock?.();
      } finally {
        release?.();
        if (this.mutationQueues.get(workflowId) === queued) this.mutationQueues.delete(workflowId);
      }
    }
  }

  private isWorkflowMutationActive(workflowId: string): boolean {
    return Boolean(this.mutationContext.getStore()?.has(workflowId));
  }

  private async acquireWorkflowFileLock(workflowId: string): Promise<() => Promise<void>> {
    const lockPath = this.workflowMutationLockDir(workflowId);
    await fs.mkdir(this.workflowDir(workflowId), { recursive: true });
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await fs.mkdir(lockPath);
        await fs.writeFile(
          path.join(lockPath, 'owner.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          'utf-8',
        );
        return async () => fs.rm(lockPath, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.stat(lockPath).catch(() => null);
        const owner = await this.readJsonFile<{ pid?: number }>(path.join(lockPath, 'owner.json'));
        // Stale-lock recovery: steal only when the previous owner is dead.
        // Cases:
        //   1. owner.json has a pid AND that pid is not alive → dead owner,
        //      steal after 60s or immediately.
        //   2. owner.json is unreadable/missing pid → can't verify liveness,
        //      fall back to age-only heuristic (>60s).
        //   3. owner is alive → do NOT steal even after 60s. Legitimate long
        //      mutations (large readJsonLines during appendEvents, slow fs)
        //      would otherwise cause concurrent writers to corrupt
        //      decisions.jsonl / subtasks.json. owner.json is written once at
        //      acquire and never refreshed (no heartbeat), so this is the
        //      only signal we have.
        const ownerHasPid = typeof owner?.pid === 'number';
        const ownerIsDead = ownerHasPid && !isProcessAlive(owner!.pid!);
        const olderThan60s = stat != null && Date.now() - stat.mtimeMs > 60_000;
        const canSteal = ownerIsDead || (!ownerHasPid && olderThan60s);
        if (canSteal) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new MultiAgentCoordinationError(
            'version_conflict',
            `Workflow ${workflowId} is locked by another durable mutation.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private assertWorkflowRevision(workflow: MultiAgentWorkflowRecord, expectedRevision: string | undefined): void {
    if (!expectedRevision || expectedRevision === '*') {
      throw new MultiAgentCoordinationError(
        'version_conflict',
        'Batch Contract acceptance requires an exact If-Match workflow revision.',
      );
    }
    const expected = Number(expectedRevision);
    const current = workflow.revision ?? 0;
    if (!Number.isSafeInteger(expected) || expected < 0 || current !== expected) {
      throw new MultiAgentCoordinationError(
        'version_conflict',
        `Workflow state changed; expected revision ${expectedRevision}, current ${current}.`,
      );
    }
  }

  private async assertWorkflowVersion(workflowId: string, expectedLastDecisionId: string | undefined): Promise<void> {
    if (!expectedLastDecisionId || expectedLastDecisionId === '*') return;
    const workflow = await this.requireWorkflow(workflowId);
    const expected = expectedLastDecisionId === 'none' ? undefined : expectedLastDecisionId;
    if (workflow.lastDecisionId !== expected) {
      throw new MultiAgentCoordinationError(
        'version_conflict',
        `Workflow decision history changed; expected ${expectedLastDecisionId}, current ${workflow.lastDecisionId || 'none'}.`,
      );
    }
  }

  private async snapshotFiles(filePaths: string[]): Promise<Array<{ filePath: string; contents: Buffer | null }>> {
    return Promise.all(filePaths.map(async (filePath) => ({
      filePath,
      contents: await fs.readFile(filePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }),
    })));
  }

  private async restoreFiles(snapshots: Array<{ filePath: string; contents: Buffer | null }>): Promise<void> {
    await Promise.all(snapshots.map(async ({ filePath, contents }) => {
      if (contents === null) {
        await fs.rm(filePath, { force: true });
        return;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents);
    }));
  }

  private async beginWorkflowTransaction(
    workflowId: string,
    snapshots: Array<{ filePath: string; contents: Buffer | null }>,
  ): Promise<void> {
    const workflowDir = this.workflowDir(workflowId);
    await this.writeJsonFileAtomic(this.workflowTransactionFile(workflowId), {
      phase: 'prepared',
      snapshots: snapshots.map(({ filePath, contents }) => ({
        path: path.relative(workflowDir, filePath),
        contents: contents?.toString('base64') ?? null,
      })),
    });
  }

  private async commitWorkflowTransaction(workflowId: string): Promise<void> {
    await this.writeJsonFileAtomic(this.workflowTransactionFile(workflowId), { phase: 'committed' });
    await fs.rm(this.workflowTransactionFile(workflowId), { force: true });
  }

  private async recoverWorkflowTransaction(workflowId: string): Promise<void> {
    const transaction = await this.readJsonFile<{
      phase?: string;
      snapshots?: Array<{ path?: string; contents?: string | null }>;
    }>(this.workflowTransactionFile(workflowId));
    if (!transaction) return;
    if (transaction.phase === 'prepared') {
      const workflowDir = this.workflowDir(workflowId);
      const snapshots = (transaction.snapshots || []).map((snapshot) => {
        const filePath = path.resolve(workflowDir, snapshot.path || '');
        const relative = path.relative(workflowDir, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new MultiAgentCoordinationError('invalid_workflow', 'Workflow transaction contains an invalid snapshot path.');
        }
        return {
          filePath,
          contents: snapshot.contents === null || snapshot.contents === undefined
            ? null
            : Buffer.from(snapshot.contents, 'base64'),
        };
      });
      await this.restoreFiles(snapshots);
    }
    await fs.rm(this.workflowTransactionFile(workflowId), { force: true });
  }
}

/**
 * Shallow-merge two metadata objects. Any key set to explicit `null` in the
 * patch removes that key from the merged output; `undefined` values in the
 * patch are ignored so callers can partially update.
 */
function mergeWorkflowMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
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
  const evaluationRunId = input.evaluationRunId || input.finalEvaluationRunId;
  if ((input.intent === 'question_evaluation' || input.intent === 'question_final_evidence') && !evaluationRunId) {
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

function readQuestionerOutputFromInvocationResult(result: Record<string, unknown> | undefined): Partial<QuestionerOutput> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const candidate = result.questionerOutput && typeof result.questionerOutput === 'object'
    ? result.questionerOutput
    : result;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  return candidate as Partial<QuestionerOutput>;
}

function assertQuestionerResultFieldMatches(
  input: Partial<QuestionerOutput>,
  result: Partial<QuestionerOutput>,
  field: keyof QuestionerOutput,
): void {
  const inputValue = input[field];
  const resultValue = result[field];
  if (inputValue === undefined && resultValue === undefined) {
    return;
  }
  if (typeof inputValue === 'object' || typeof resultValue === 'object') {
    if (JSON.stringify(inputValue ?? null) === JSON.stringify(resultValue ?? null)) {
      return;
    }
  } else if (inputValue === resultValue) {
    return;
  }
  throw new MultiAgentCoordinationError(
    'missing_evidence',
    `Questioner output ${String(field)} does not match the completed invocation result.`,
  );
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

async function validateEvaluationArtifactRefs(
  rootPath: string,
  workflowId: string,
  run: EvaluationRun,
  criteriaResults: CodexEvaluationResult['criteriaResults'],
  commandResults: CodexEvaluationResult['commandResults'],
): Promise<CodexEvaluationResult['coverageGaps']> {
  const refs: Array<{
    ref: string;
    commandArtifact: boolean;
    expectedSha256?: string;
    expectedBytes?: number;
  }> = [];
  for (const ref of run.artifactRefs || []) refs.push({ ref, commandArtifact: false });
  for (const criterion of criteriaResults) {
    for (const ref of criterion.artifactRefs || []) refs.push({ ref, commandArtifact: false });
  }
  for (const command of commandResults) {
    if (command.stdoutArtifactId) refs.push({
      ref: command.stdoutArtifactId,
      commandArtifact: true,
      expectedSha256: command.stdoutArtifactSha256,
      expectedBytes: command.stdoutArtifactBytes,
    });
    if (command.stderrArtifactId) refs.push({
      ref: command.stderrArtifactId,
      commandArtifact: true,
      expectedSha256: command.stderrArtifactSha256,
      expectedBytes: command.stderrArtifactBytes,
    });
    for (const report of command.testReports || []) refs.push({
      ref: report.artifactId,
      commandArtifact: true,
      expectedSha256: report.artifactSha256,
      expectedBytes: report.artifactBytes,
    });
  }

  const gaps: CodexEvaluationResult['coverageGaps'] = [];
  const seen = new Set<string>();
  const root = path.resolve(rootPath);
  const realRoot = await fs.realpath(root).catch(() => root);
  const commandPrefix = `.tik/multi-agent/workflows/${workflowId}/evaluations/${run.id}/`;
  for (const item of refs) {
    const ref = normalizeEvaluationArtifactRef(item.ref);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (path.isAbsolute(item.ref) || ref.startsWith('../')) {
      gaps.push({
        criterionId: 'artifact_path_invalid',
        description: `Evaluation artifact reference is outside the workspace: ${item.ref}`,
        reason: 'Evaluation artifact reference must stay inside the workspace root.',
      });
      continue;
    }
    if (item.commandArtifact && !ref.startsWith(commandPrefix)) {
      gaps.push({
        criterionId: 'artifact_path_mismatch',
        description: `Command artifact does not belong to EvaluationRun ${run.id}: ${ref}`,
        reason: 'Command artifact reference must use the canonical EvaluationRun directory.',
      });
      continue;
    }
    const resolved = path.resolve(root, ref);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      gaps.push({
        criterionId: 'artifact_path_invalid',
        description: `Evaluation artifact reference is outside the workspace: ${item.ref}`,
        reason: 'Evaluation artifact reference must stay inside the workspace root.',
      });
      continue;
    }
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) {
      gaps.push({
        criterionId: 'artifact_missing',
        description: `Referenced evaluation artifact is missing: ${ref}`,
        reason: 'Referenced evaluation artifact does not exist.',
      });
      continue;
    }
    if (stat.size === 0) {
      gaps.push({
        criterionId: 'artifact_empty',
        description: `Referenced evaluation artifact is empty: ${ref}`,
        reason: 'Referenced evaluation artifact must contain auditable output.',
      });
      continue;
    }
    if (item.commandArtifact && !item.expectedSha256) {
      gaps.push({
        criterionId: 'artifact_hash_missing',
        description: `Command artifact is missing SHA-256 metadata: ${ref}`,
        reason: 'Command artifact metadata must include the expected SHA-256 digest.',
      });
      continue;
    }
    if (item.expectedBytes !== undefined && item.expectedBytes !== stat.size) {
      gaps.push({
        criterionId: 'artifact_size_mismatch',
        description: `Evaluation artifact size does not match metadata: ${ref}`,
        reason: `Expected ${item.expectedBytes} bytes but found ${stat.size}.`,
      });
      continue;
    }
    if (item.expectedSha256) {
      const actualSha256 = `sha256:${createHash('sha256').update(await fs.readFile(resolved)).digest('hex')}`;
      if (actualSha256 !== item.expectedSha256) {
        gaps.push({
          criterionId: 'artifact_hash_mismatch',
          description: `Evaluation artifact hash does not match metadata: ${ref}`,
          reason: `Expected ${item.expectedSha256} but found ${actualSha256}.`,
        });
        continue;
      }
    }
    const real = await fs.realpath(resolved).catch(() => undefined);
    if (!real) {
      gaps.push({
        criterionId: 'artifact_missing',
        description: `Referenced evaluation artifact is unreadable: ${ref}`,
        reason: 'Referenced evaluation artifact does not exist.',
      });
      continue;
    }
    const realRelative = path.relative(realRoot, real);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      gaps.push({
        criterionId: 'artifact_path_invalid',
        description: `Evaluation artifact symlink escapes the workspace: ${ref}`,
        reason: 'Evaluation artifact reference must stay inside the workspace root.',
      });
    }
  }
  return gaps;
}

function normalizeEvaluationArtifactRef(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
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
  return current === (expected === 'none' ? undefined : expected);
}

function latestContractForSubtask(contracts: SprintContract[], subtaskId: string): SprintContract | undefined {
  return contracts
    .filter((contract) => contract.subtaskId === subtaskId)
    .sort((left, right) => right.version - left.version || right.id.localeCompare(left.id))[0];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false);
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

function mergeReadonlyPolicies(
  stored: AgentInvocationRecord['readonlyPolicy'] | undefined,
  requested: AgentInvocationRecord['readonlyPolicy'] | undefined,
): AgentInvocationRecord['readonlyPolicy'] | undefined {
  if (!stored) return requested;
  if (!requested) return stored;
  const violations = mergeUnique(stored.violations, requested.violations);
  return {
    enforced: stored.enforced && requested.enforced && violations.length === 0,
    allowedWritePaths: stored.allowedWritePaths || requested.allowedWritePaths,
    forbiddenWritePaths: stored.forbiddenWritePaths || requested.forbiddenWritePaths,
    violations,
    gitStatusBefore: stored.gitStatusBefore || requested.gitStatusBefore,
    gitStatusAfter: stored.gitStatusAfter || requested.gitStatusAfter,
  };
}

async function assertWorkspaceBindingInsideRoot(binding: MultiAgentWorkflowRecord['workspaceBinding']): Promise<void> {
  if (!binding?.workspaceRoot || !binding.effectiveProjectPath) {
    return;
  }

  const root = await fs.realpath(path.resolve(binding.workspaceRoot)).catch(() => path.resolve(binding.workspaceRoot));
  const target = await fs.realpath(path.resolve(binding.effectiveProjectPath)).catch(() => path.resolve(binding.effectiveProjectPath));
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const workspaceFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.code-workspace'))
    .map((entry) => path.join(root, entry.name));
  const externalRoots = (await Promise.all(workspaceFiles.map(async (workspaceFile) => {
    try {
      const parsed = JSON.parse(await fs.readFile(workspaceFile, 'utf-8')) as { folders?: Array<{ path?: unknown }> };
      return await Promise.all((parsed.folders || []).map(async (folder) => {
        if (typeof folder.path !== 'string' || folder.path.trim().length === 0) return null;
        const candidate = path.isAbsolute(folder.path) ? folder.path : path.resolve(path.dirname(workspaceFile), folder.path);
        return fs.realpath(candidate).catch(() => null);
      }));
    } catch {
      return [];
    }
  }))).flat().filter((item): item is string => Boolean(item));
  if ([root, ...externalRoots].some((allowedRoot) => {
    const relative = path.relative(allowedRoot, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) return;

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
      '**/target/**',
      '.risk.env',
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

function defaultQuestionerRuntimePolicy(): AgentRuntimePolicy {
  return {
    filesystem: 'read-only',
    network: 'tik-api-only',
    shell: 'read-only',
    permissionMode: 'dontAsk',
  };
}

function latestMatchingStrictQuestionerOutput(
  bundle: MultiAgentWorkflowBundle,
  input: {
    subtaskId?: string;
    intent: QuestionerIntent;
    contractId?: string;
    evaluationRunId?: string;
    finalEvaluationRunId?: string;
    headSha?: string;
  },
): QuestionerOutput | undefined {
  return (bundle.questionerOutputs || [])
    .filter((output) => output.subtaskId === input.subtaskId && output.intent === input.intent)
    .filter((output) => output.schemaVersion === 'questioner-output.v2')
    .filter((output) => input.contractId === undefined || output.references?.contractId === input.contractId || output.contractId === input.contractId)
    .filter((output) => input.evaluationRunId === undefined || output.references?.evaluationRunId === input.evaluationRunId || output.evaluationRunId === input.evaluationRunId)
    .filter((output) => input.finalEvaluationRunId === undefined || output.references?.finalEvaluationRunId === input.finalEvaluationRunId || output.finalEvaluationRunId === input.finalEvaluationRunId)
    .filter((output) => input.headSha === undefined || output.attestation?.headSha === input.headSha || output.headSha === input.headSha)
    .filter((output) => !hasBlockingQuestionerQuestions(bundle, output))
    .filter((output) => hasSufficientQuestionerCoverage(output))
    .filter((output) => {
      const invocation = output.actor.invocationId
        ? bundle.invocations.find((candidate) => candidate.id === output.actor.invocationId)
        : undefined;
      if (!invocation || invocation.status !== 'completed') return false;
      const run = output.questionerRunId
        ? bundle.questionerRuns.find((candidate) => candidate.id === output.questionerRunId)
        : undefined;
      if (!run || run.status !== 'validated') return false;
      if (run.invocationId !== invocation.id) return false;
      if (run.contextHash !== output.attestation?.contextHash) return false;
      if (run.contextArtifactRef !== output.attestation?.contextArtifactRef) return false;
      if (run.outputHash && run.outputHash !== output.attestation?.outputHash) return false;
      const readonly = run.readonlyAudit || invocation.readonlyPolicy;
      if (!readonly?.enforced || (readonly.violations || []).length > 0) return false;
      return true;
    })
    .sort((left, right) => safeIsoTime(right.createdAt).localeCompare(safeIsoTime(left.createdAt)))[0];
}

function hasBlockingQuestionerQuestions(bundle: MultiAgentWorkflowBundle, output: QuestionerOutput): boolean {
  const resolvedQuestionIds = new Set(
    (bundle.questionResolutions || [])
      .filter((resolution) => resolution.questionerOutputId === output.id)
      .filter((resolution) => resolution.status === 'resolved' || resolution.status === 'accepted_risk')
      .map((resolution) => resolution.questionId),
  );
  const unresolvedBlocking = (output.questions || [])
    .filter((question) => !resolvedQuestionIds.has(question.id))
    .filter((question) => question.priority === 'blocking' || question.priority === 'evidence_needed');
  if (unresolvedBlocking.length > 0) return true;
  if (
    output.verdict === 'questions_blocking'
    || output.verdict === 'need_clarification'
    || output.verdict === 'evidence_needed'
  ) {
    return (output.questions || []).length === 0;
  }
  return false;
}

function hasSufficientQuestionerCoverage(output: QuestionerOutput): boolean {
  if (!Array.isArray(output.coverageMatrix) || output.coverageMatrix.length === 0) return false;
  return output.coverageMatrix
    .filter((entry) => entry.required)
    .every((entry) => entry.status === 'covered' && entry.evidenceRefs.length > 0 && entry.comment.trim().length > 0);
}

function defaultQuestionerReadonlyPolicy(): NonNullable<QuestionerRun['readonlyAudit']> {
  return {
    enforced: true,
    allowedWritePaths: ['.tik/multi-agent/'],
    forbiddenWritePaths: ['src/', 'app/', 'packages/', 'server/', 'client/', 'tests/', 'package.json', 'pnpm-lock.yaml'],
    violations: [],
  };
}

function validateQuestionerReadonlyAudit(
  run: QuestionerRun,
  input: SubmitQuestionerRunOutputInput['runtimeAudit'],
): { accepted: boolean; code?: string; message?: string; audit: NonNullable<QuestionerRun['readonlyAudit']> } {
  const base = run.readonlyAudit || defaultQuestionerReadonlyPolicy();
  const allowedWritePaths = input?.allowedWritePaths || base.allowedWritePaths || defaultQuestionerReadonlyPolicy().allowedWritePaths;
  const forbiddenWritePaths = input?.forbiddenWritePaths || base.forbiddenWritePaths || defaultQuestionerReadonlyPolicy().forbiddenWritePaths;
  const audit: NonNullable<QuestionerRun['readonlyAudit']> = {
    ...base,
    enforced: true,
    allowedWritePaths,
    forbiddenWritePaths,
    violations: [],
    gitStatusBefore: base.gitStatusBefore,
    gitStatusAfter: input?.gitStatusAfter,
    workspaceFingerprintBefore: base.workspaceFingerprintBefore,
    workspaceFingerprintAfter: input?.workspaceFingerprintAfter,
  };
  if (audit.gitStatusBefore === undefined || audit.gitStatusAfter === undefined) {
    return {
      accepted: false,
      code: 'missing_evidence',
      message: 'QuestionerRun requires gitStatusBefore and gitStatusAfter readonly audit evidence.',
      audit,
    };
  }
  audit.violations = detectReadonlyViolations(audit.gitStatusBefore, audit.gitStatusAfter, allowedWritePaths, forbiddenWritePaths);
  if (
    audit.workspaceFingerprintBefore
    && audit.workspaceFingerprintBefore !== audit.workspaceFingerprintAfter
  ) {
    audit.violations = mergeUnique(audit.violations, ['workspace_content_changed']);
  }
  if (audit.violations.length > 0) {
    return {
      accepted: false,
      code: 'readonly_policy_violated',
      message: `Questioner wrote forbidden paths: ${audit.violations.join(', ')}`,
      audit,
    };
  }
  return { accepted: true, audit };
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

function validateTaskGraph(workflow: MultiAgentWorkflowRecord, graph: TaskGraph): void {
  const subtaskIds = new Set(graph.subtasks.map((subtask) => subtask.id));
  for (const subtask of graph.subtasks) {
    if (!Array.isArray(subtask.allowedPaths) || subtask.allowedPaths.length === 0) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `Subtask ${subtask.id} must declare at least one allowed path.`);
    }
    const blockedPaths = subtask.blockedPaths || [];
    const overlap = subtask.allowedPaths.flatMap((allowed) =>
      blockedPaths
        .filter((blocked) => pathPatternsOverlap(allowed, blocked))
        .map((blocked) => ({ allowed, blocked }))
    );
    if (overlap.length > 0) {
      throw new MultiAgentCoordinationError(
        'invalid_task_graph',
        `Subtask ${subtask.id} has overlapping allowedPaths and blockedPaths: ${overlap.map((item) => `${item.allowed} <-> ${item.blocked}`).join(', ')}.`,
      );
    }
    const missingDependencies = subtask.dependsOn.filter((dependency) => !subtaskIds.has(dependency));
    if (missingDependencies.length > 0) {
      throw new MultiAgentCoordinationError(
        'invalid_task_graph',
        `Subtask ${subtask.id} references missing dependencies: ${missingDependencies.join(', ')}.`,
      );
    }
    if (subtask.dependsOn.includes(subtask.id)) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `Subtask ${subtask.id} cannot depend on itself.`);
    }
    if (workflow.mode === 'review') {
      if (subtask.kind !== 'review') {
        throw new MultiAgentCoordinationError('invalid_task_graph', `Review workflow subtask ${subtask.id} must use kind=review.`);
      }
      if ((subtask.expectedChangedFiles || []).length > 0) {
        throw new MultiAgentCoordinationError('invalid_task_graph', `Review subtask ${subtask.id} cannot declare expectedChangedFiles.`);
      }
      if (subtask.assignedReviewer !== 'codex') {
        throw new MultiAgentCoordinationError('invalid_task_graph', `Review subtask ${subtask.id} must use a readonly Codex reviewer.`);
      }
    } else if (subtask.kind === 'review') {
      throw new MultiAgentCoordinationError('invalid_task_graph', `Implementation workflow subtask ${subtask.id} cannot use kind=review.`);
    }
  }
  assertTaskGraphAcyclic(graph);
}

function pathPatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeGitStatusPath(left);
  const normalizedRight = normalizeGitStatusPath(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftWitness = globWitness(normalizedLeft);
  const rightWitness = globWitness(normalizedRight);
  return matchesAnyPath(leftWitness, [normalizedRight])
    || matchesAnyPath(rightWitness, [normalizedLeft]);
}

function globWitness(pattern: string): string {
  return pattern
    .replace(/\*\*\/\*/g, '__tik_scope_probe__/file')
    .replace(/\*\*/g, '__tik_scope_probe__')
    .replace(/\*/g, '__tik_scope_probe__')
    .replace(/\/$/, '/__tik_scope_probe__');
}

function assertTaskGraphAcyclic(graph: TaskGraph): void {
  const dependencies = new Map(graph.subtasks.map((subtask) => [subtask.id, subtask.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (subtaskId: string): void => {
    if (visited.has(subtaskId)) return;
    if (visiting.has(subtaskId)) {
      throw new MultiAgentCoordinationError('invalid_task_graph', `TaskGraph contains a dependency cycle at ${subtaskId}.`);
    }
    visiting.add(subtaskId);
    for (const dependency of dependencies.get(subtaskId) || []) visit(dependency);
    visiting.delete(subtaskId);
    visited.add(subtaskId);
  };
  for (const subtaskId of dependencies.keys()) visit(subtaskId);
}

function isFinalEvaluationSubtask(subtaskId: string): boolean {
  return subtaskId === '__final__';
}

function upsertEvaluationCheckpoint(
  checkpoints: EvaluationCheckpoint[],
  checkpoint: EvaluationCheckpoint,
): EvaluationCheckpoint[] {
  return [
    ...checkpoints.filter((item) => item.stage !== checkpoint.stage),
    checkpoint,
  ];
}

function evaluationFailureClass(
  result: CodexEvaluationResult,
  status: EvaluationRun['status'],
): EvaluationFailureClass | undefined {
  if (status === 'invalidated') return 'readonly_violation';
  if (result.commandResults.some((command) => command.status === 'failed' || command.status === 'timeout')) {
    return 'command_failure';
  }
  if (result.coverageGaps.some((gap) => gap.reason === 'Required evaluation command did not pass.')) {
    return 'command_failure';
  }
  if (result.coverageGaps.some((gap) => /artifact|report|hash|stale/i.test(`${gap.description} ${gap.reason}`))) {
    return 'artifact_failure';
  }
  if (result.coverageGaps.some((gap) => gap.criterionId === 'semantic-verdict')) return 'invalid_output';
  if (result.verdict === 'fail' || result.verdict === 'human_review_required') return 'semantic_failure';
  if (result.verdict === 'inconclusive') return 'invalid_output';
  return undefined;
}

function evaluationResumeStage(
  result: CodexEvaluationResult,
  status: EvaluationRun['status'],
): EvaluationRun['resumeFromStage'] {
  const failureClass = evaluationFailureClass(result, status);
  if (failureClass === 'command_failure') return 'validation_commands';
  if (failureClass === 'artifact_failure') return 'artifact_verification';
  if (failureClass === 'readonly_violation') return 'semantic_review';
  if (failureClass === 'invalid_output' || failureClass === 'semantic_failure') return 'semantic_review';
  return 'verdict_merge';
}
