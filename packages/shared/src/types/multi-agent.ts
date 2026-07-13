import type { ReviewResult } from './workbench.js';
import type { TaskWorkspaceBinding } from './task.js';

export type MultiAgentWorkflowStatus =
  | 'created'
  | 'questioning_requirements'
  | 'planning'
  | 'task_graph_questioning'
  | 'active'
  | 'blocked'
  | 'human_review_required'
  | 'completed'
  | 'aborted'
  | 'failed';

export type MultiAgentWorkflowMode = 'implementation' | 'review';

export type WorkflowDecisionAction =
  | 'ask_claude_question_requirement'
  | 'ask_claude_question_task_graph'
  | 'request_dynamic_plan'
  | 'draft_contract'
  | 'ask_claude_question_contract'
  | 'accept_contract'
  | 'execute_subtask'
  | 'record_implementation'
  | 'run_readonly_reviewer'
  | 'record_review'
  | 'run_codex_evaluator'
  | 'validate_subtask'
  | 'ask_claude_question_evaluation'
  | 'fix_evaluation_findings'
  | 're_evaluate'
  | 'request_replan'
  | 'request_human_review'
  | 'complete_subtask'
  | 'run_final_evaluation'
  | 'ask_claude_question_final_evidence'
  | 'synthesize_review'
  | 'complete_workflow'
  | 'abort_workflow';

export type WorkflowDecisionActor = 'codex-workflow' | 'codex-workflow-plugin';

export interface WorkflowDecision {
  id: string;
  workflowId: string;
  rootTaskId: string;
  subtaskId?: string;
  reviewRoundId?: string;
  decidedBy: WorkflowDecisionActor;
  decidedAt: string;
  action: WorkflowDecisionAction;
  reason: string;
  evidenceRefs: string[];
  inputs?: Record<string, unknown>;
  expectedTikMutation?: {
    taskStatus?: string;
    agentLoopKind?: string;
    labelsAdd?: string[];
    labelsRemove?: string[];
  };
  confidence?: number;
  risks?: string[];
}

export type GuardResultCode =
  | 'ok'
  | 'invalid_transition'
  | 'missing_contract'
  | 'contract_not_accepted'
  | 'missing_implementation_evidence'
  | 'missing_evaluation_result'
  | 'evaluation_not_passed'
  | 'evaluation_evidence_insufficient'
  | 'blocking_question_unresolved'
  | 'blocking_finding_unresolved'
  | 'invocation_still_running'
  | 'head_sha_mismatch'
  | 'readonly_policy_violated'
  | 'max_rounds_exceeded'
  | 'worktree_out_of_scope'
  | 'missing_subagent_invocation'
  | 'subagent_thread_not_isolated'
  | 'missing_evidence'
  | 'requires_human_approval'
  | 'version_conflict'
  | 'preflight_failed'
  | 'unknown_error';

export interface GuardResult {
  accepted: boolean;
  code?: GuardResultCode;
  message?: string;
  currentState?: unknown;
}

/**
 * Well-known keys stored in workflow.metadata.
 * The server treats metadata as Record<string, unknown>; this interface
 * documents the keys the CLI writes so consumers can type-narrow safely.
 */
export interface WorkflowMetadata {
  /** Codex thread id that created this workflow, if any. */
  parentCodexThreadId?: string;
  /**
   * Files that were already dirty in the worktree *before* this workflow was
   * initialised (i.e. captured by `git diff --name-only` at init time).
   *
   * Used by the CLI's `deriveObservedChangedFiles` to subtract pre-existing
   * changes from the observed diff when there is no headShaAtAcceptance-based
   * baseline available, preventing `worktree_out_of_scope` rejections caused by
   * changes that belong to earlier work rather than to the current subtask.
   */
  preexistingChangedFiles?: string[];
}

export interface CreateMultiAgentWorkflowInput {
  id?: string;
  goal: string;
  mode?: MultiAgentWorkflowMode;
  rootTaskId?: string;
  repo?: string;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  maxRounds?: number;
  policy?: Partial<WorkflowPolicy>;
  workspaceBinding?: TaskWorkspaceBinding;
  metadata?: Record<string, unknown>;
}

export interface MultiAgentWorkflowRecord {
  id: string;
  driver: 'codex-workflow';
  /** Monotonic durable-state revision; absent only on records created before revisioning. */
  revision?: number;
  status: MultiAgentWorkflowStatus;
  /** Defaults to implementation for records created before review mode existed. */
  mode?: MultiAgentWorkflowMode;
  goal: string;
  rootTaskId: string;
  repo?: string;
  baseRef?: string;
  headRef?: string;
  currentHeadSha?: string;
  maxRounds: number;
  policy?: WorkflowPolicy;
  workspaceBinding?: TaskWorkspaceBinding;
  taskGraphVersion?: number;
  lastDecisionId?: string;
  pauseReason?: 'max_rounds_reached' | 'budget_exceeded' | 'awaiting_subagent' | string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  abortedAt?: string;
}

export interface TaskGraph {
  workflowId: string;
  version: number;
  createdBy: 'claude-code' | 'codex-workflow' | 'codex-workflow-plugin' | 'human';
  subtasks: SubtaskSpec[];
  risks: string[];
  globalAcceptanceCriteria: string[];
  finalValidationCommands: string[];
}

export interface FinalWorkflowContract {
  id: string;
  workflowId: string;
  globalAcceptanceCriteria: SubtaskAcceptanceCriterion[];
  requiredEvidenceKinds: Array<'build' | 'test' | 'e2e' | 'smoke' | 'questioner'>;
  finalValidationCommands: string[];
}

export interface SubtaskSpec {
  id: string;
  /** Defaults to implementation. Review workflows only accept review subtasks. */
  kind?: 'implementation' | 'review';
  title: string;
  goal: string;
  dependsOn: string[];
  allowedPaths: string[];
  blockedPaths?: string[];
  loopContractOverride?: Partial<LoopContract>;
  acceptanceCriteria: string[] | SubtaskAcceptanceCriterion[];
  validationCommands: string[];
  reviewFocus: string[];
  expectedChangedFiles?: string[];
  assignedExecutor?: 'codex';
  assignedReviewer: 'claude-code' | 'codex';
}

export type SubtaskRunStatus =
  | 'pending'
  | 'ready'
  | 'contract_drafting'
  | 'contract_questioning'
  | 'contract_accepted'
  | 'reviewing'
  | 'reviewed'
  | 'building'
  | 'executing'
  | 'implemented'
  | 'evaluating'
  | 'validating'
  | 'evaluation_failed'
  | 'evaluation_passed'
  | 'validated'
  | 'validation_failed'
  | 'questioning_evidence'
  | 'synthesizing'
  | 'synthesized'
  | 'needs_fix'
  | 'fixing'
  | 'done'
  | 'blocked'
  | 'human_review_required';

export interface SubtaskRunState {
  subtaskId: string;
  status: SubtaskRunStatus;
  implementationHeadSha?: string;
  lastValidatedHeadSha?: string;
  validationRunIds: string[];
  evidenceRefs: string[];
  blockerFindingIds: string[];
  fixRound: number;
}

export interface ValidationSummary {
  passed: boolean;
  command?: string;
  exitCode?: number;
  outputRef?: string;
  checkedAt?: string;
}

export type MultiAgentEvidenceKind =
  | 'implementation'
  | 'review'
  | 'synthesis'
  | 'validation'
  | 'evaluation'
  | 'questioner'
  | 'fix'
  | 'plan'
  | 'decision'
  | 'note';

export interface MultiAgentWorkflowEvidence {
  id: string;
  workflowId: string;
  subtaskId?: string;
  kind: MultiAgentEvidenceKind;
  title: string;
  summary?: string;
  command?: string;
  passed?: boolean;
  artifactRef?: string;
  headSha?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface ImplementationChangedFile {
  path: string;
  changeType?: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
}

export interface ImplementationScopeCheck {
  allowed: boolean;
  violations: string[];
}

export interface ImplementationEvidencePayload extends Record<string, unknown> {
  changedFiles?: Array<string | ImplementationChangedFile>;
  declaredChangedFiles?: Array<string | ImplementationChangedFile>;
  observedChangedFiles?: Array<string | ImplementationChangedFile>;
  headShaBefore?: string;
  headShaAfter?: string;
  scopeCheck?: ImplementationScopeCheck;
}

export type MultiAgentInvocationRole = 'planner' | 'executor' | 'reviewer' | 'questioner' | 'evaluator';
export type MultiAgentInvocationRunner = 'claude-code' | 'codex' | 'codex-evaluator';
export type MultiAgentInvocationStatus = 'created' | 'started' | 'completed' | 'failed' | 'cancelled';

export interface AgentInvocationRecord {
  id: string;
  workflowId: string;
  subtaskId?: string;
  role: MultiAgentInvocationRole;
  runner: MultiAgentInvocationRunner;
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
  readonlyPolicy?: {
    enforced: boolean;
    allowedWritePaths?: string[];
    forbiddenWritePaths?: string[];
    violations?: string[];
    gitStatusBefore?: string;
    gitStatusAfter?: string;
    workspaceFingerprintBefore?: string;
    workspaceFingerprintAfter?: string;
  };
  /** True only when Tik owns launching and recovering the native runtime process. */
  nativeRuntimeOwned?: boolean;
  attestationToken?: string;
  hookAttested?: boolean;
  attestationStartedAt?: string;
  attestationStoppedAt?: string;
  runtimeAttestation?: SubagentRuntimeAttestation;
  status: MultiAgentInvocationStatus;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentRuntimePolicy {
  filesystem: 'read-only' | 'workspace-write' | 'unrestricted';
  network: 'tik-api-only' | 'disabled' | 'unrestricted';
  shell: 'disabled' | 'read-only' | 'unrestricted';
  permissionMode: 'dontAsk' | 'bypassPermissions';
}

export interface SubagentRuntimeAttestation {
  source: 'codex-subagent-runtime' | 'codex-plugin-hook';
  parentThreadId: string;
  actualSubagentThreadId: string;
  role: MultiAgentInvocationRole;
  nonce: string;
  startedAt: string;
  stoppedAt?: string;
  headSha?: string;
  evidenceRefs?: string[];
  readonlyPolicy?: AgentInvocationRecord['readonlyPolicy'];
}

export interface TaskGraphPatch {
  baseGraphVersion: number;
  operations: Array<
    | { op: 'add_subtask'; subtask: SubtaskSpec }
    | { op: 'update_subtask'; subtaskId: string; patch: Partial<SubtaskSpec> }
    | { op: 'remove_subtask'; subtaskId: string; reason: string }
    | { op: 'add_dependency'; from: string; to: string }
    | { op: 'remove_dependency'; from: string; to: string }
  >;
  reason: string;
  risks: string[];
}

export interface LoopGateInput {
  workflow: MultiAgentWorkflowRecord;
  graph: TaskGraph;
  subtask: SubtaskRunState;
  reviewResult?: ReviewResult;
  validationSummary?: ValidationSummary;
  currentHeadSha: string;
  maxRounds: number;
  round: number;
  changedFiles: string[];
  allowedPaths: string[];
}

export interface LoopGateDecision extends WorkflowDecision {
  action:
    | 'complete_subtask'
    | 'request_replan'
    | 'request_human_review'
    | 'complete_workflow';
}

export type MultiAgentWorkflowEventType =
  | 'workflow.created'
  | 'workflow.policy.updated'
  | 'workflow.human_override'
  | 'decision.recorded'
  | 'task_graph.created'
  | 'context_snapshot.recorded'
  | 'contract.created'
  | 'contract.accepted'
  | 'contract.staled'
  | 'subtask.selected'
  | 'subtask.updated'
  | 'evidence.recorded'
  | 'evaluation.created'
  | 'evaluation.updated'
  | 'evaluation.result.recorded'
  | 'evaluation.readonly_validated'
  | 'questioner.run.created'
  | 'questioner.run.started'
  | 'questioner.run.output_received'
  | 'questioner.run.validated'
  | 'questioner.run.rejected'
  | 'questioner.output.recorded'
  | 'question.resolution.recorded'
  | 'agent_invocation.created'
  | 'agent_invocation.started'
  | 'agent_invocation.completed'
  | 'invocation.stalled'
  | 'codex.execute.started'
  | 'codex.execute.completed'
  | 'validation.started'
  | 'validation.completed'
  | 'replan.requested'
  | 'human_review.requested'
  | 'workflow.completed'
  | 'workflow.aborted';

export interface MultiAgentWorkflowEvent {
  id: string;
  workflowId: string;
  type: MultiAgentWorkflowEventType;
  actor: 'codex-workflow' | 'tik' | 'claude-code' | 'human';
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface MultiAgentWorkflowBundle {
  workflow: MultiAgentWorkflowRecord;
  taskGraph: TaskGraph | null;
  subtasks: Record<string, SubtaskRunState>;
  contracts: SprintContract[];
  evaluationRuns: EvaluationRun[];
  questionerRuns: QuestionerRun[];
  questionerOutputs: QuestionerOutput[];
  questionResolutions: QuestionResolution[];
  decisions: WorkflowDecision[];
  evidence: MultiAgentWorkflowEvidence[];
  invocations: AgentInvocationRecord[];
  events: MultiAgentWorkflowEvent[];
}

export interface WorkflowPolicy {
  maxFixRoundsPerSubtask: number;
  maxEvaluationRoundsPerSubtask: number;
  requireQuestionerBeforeBuild: boolean;
  requireQuestionerAfterEvaluation: boolean;
  requireAcceptedContract: boolean;
  requireEvaluationPassForComplete: boolean;
  requireSameHeadShaForEvidence: boolean;
  allowHumanOverride: boolean;
  loopContract?: LoopContract;
  stalledInvocationTimeoutMs?: number;
  snapshotMaxChars?: Partial<Record<WorkflowContextSnapshotTarget, number>>;
}

export interface MultiAgentEnvironmentPreflightCheck {
  id: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface MultiAgentEnvironmentPreflightReport {
  accepted: boolean;
  mode: MultiAgentWorkflowMode;
  workspaceRoot?: string;
  projectPath?: string;
  headSha?: string;
  checks: MultiAgentEnvironmentPreflightCheck[];
}

export type QuestionerIntent =
  | 'question_requirement'
  | 'question_task_graph'
  | 'question_contract'
  | 'question_evaluation'
  | 'question_fix'
  | 'question_final_evidence';

export interface QuestionerRun {
  id: string;
  workflowId: string;
  subtaskId?: string;
  intent: QuestionerIntent;
  status:
    | 'created'
    | 'started'
    | 'output_received'
    | 'validated'
    | 'rejected'
    | 'expired';
  invocationId: string;
  runner: 'claude-code';
  pluginSkill: 'question-tik-agent-loop';
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  headSha: string;
  contextArtifactRef: string;
  contextHash: string;
  expectedOutputArtifactRef?: string;
  outputHash?: string;
  outputArtifactRef?: string;
  rejectionReason?: string;
  tokenId: string;
  tokenHash: string;
  tokenExpiresAt: string;
  runtimePolicy: AgentRuntimePolicy;
  readonlyAudit?: {
    enforced: boolean;
    allowedWritePaths: string[];
    forbiddenWritePaths: string[];
    violations: string[];
    gitStatusBefore?: string;
    gitStatusAfter?: string;
    workspaceFingerprintBefore?: string;
    workspaceFingerprintAfter?: string;
  };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type LoopStopCondition =
  | 'guard_rejected'
  | 'same_failure_repeated'
  | 'head_sha_changed'
  | 'human_required'
  | 'budget_exceeded'
  | 'evaluation_inconclusive';

export type LoopRefreshAction =
  | 'read_latest_head_sha'
  | 'read_observed_git_diff'
  | 'reload_task_graph'
  | 'reload_contract'
  | 'reload_latest_evidence';

export interface LoopContract {
  id: string;
  workflowId: string;
  subtaskId?: string;
  scope: {
    allowedPaths: string[];
    blockedPaths: string[];
  };
  budget: {
    maxRounds: number;
    maxRuntimeMs: number;
    maxConsecutiveFailures: number;
    maxSubagentRuns?: number;
    maxEvaluatorRuns?: number;
  };
  stop: LoopStopCondition[];
  refresh: LoopRefreshAction[];
  report: {
    destination: 'tik_timeline' | 'dashboard' | 'local_file';
    fields: string[];
  };
}

export type WorkflowContextSnapshotTarget = 'main' | 'builder' | 'evaluator' | 'questioner';

export interface WorkflowContextSnapshot {
  workflowId: string;
  headSha: string;
  activeSubtaskId?: string;
  target: WorkflowContextSnapshotTarget;
  objectiveSummary: string;
  completedSubtasks: string[];
  currentContractSummary?: string;
  latestImplementationSummary?: string;
  latestEvaluationSummary?: string;
  latestQuestionerSummary?: string;
  unresolvedBlockers: string[];
  nextActionHint?: string;
  artifactRefs: string[];
  renderedMarkdown?: string;
  markdownArtifactRef?: string;
  maxChars: number;
  etag?: string;
  createdAt: string;
  updatedAt: string;
}

export interface HumanOverrideRecord {
  id: string;
  workflowId: string;
  reason: string;
  approver: string;
  unblockAction: 'resume' | 'abort' | 'force_complete_subtask' | 'force_complete_workflow';
  subtaskId?: string;
  note?: string;
  guardRejection?: GuardResult;
  createdAt: string;
}

export interface SubtaskAcceptanceCriterion {
  id: string;
  statement: string;
  priority: 'must' | 'should' | 'nice_to_have';
}

export interface SprintContract {
  id: string;
  workflowId: string;
  subtaskId: string;
  version: number;
  status: 'draft' | 'questioning' | 'accepted' | 'rejected' | 'stale';
  goal: string;
  scope: {
    allowedPaths: string[];
    blockedPaths: string[];
  };
  deliverables: Array<{
    id: string;
    description: string;
    expectedFiles?: string[];
  }>;
  acceptanceCriteria: Array<{
    id: string;
    statement: string;
    priority: 'must' | 'should' | 'nice_to_have';
    verificationMethod: 'command' | 'playwright' | 'api' | 'db' | 'manual' | 'inspection';
  }>;
  verificationPlan: {
    commands: ValidationCommandSpec[];
    playwrightScenarios?: PlaywrightScenarioSpec[];
    apiChecks?: ApiCheckSpec[];
    dbChecks?: DbCheckSpec[];
    negativeChecks?: string[];
  };
  questionerOutputRefs: string[];
  acceptedBy?: WorkflowDecisionActor | 'human';
  acceptedAt?: string;
  headShaAtAcceptance: string;
}

export interface ValidationCommandSpec {
  id: string;
  command: string;
  cwd?: string;
  hardTimeoutMs: number;
  idleTimeoutMs?: number;
  required: boolean;
}

export interface PlaywrightScenarioSpec {
  id: string;
  title: string;
  baseUrl?: string;
  steps: Array<{
    action: 'goto' | 'click' | 'fill' | 'select' | 'expectText' | 'expectVisible' | 'screenshot';
    selector?: string;
    value?: string;
    url?: string;
    expected?: string;
  }>;
  expectedOutcome: string;
}

export interface ApiCheckSpec {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  expectedStatus: number;
  expectedJsonContains?: unknown;
}

export interface DbCheckSpec {
  id: string;
  connectionRef: string;
  query: string;
  expectedRows?: number;
  expectedContains?: unknown;
}

export interface EvaluationRun {
  id: string;
  workflowId: string;
  subtaskId: string;
  contractId: string;
  evaluator: {
    kind: 'codex-evaluator';
    sessionId?: string;
    runnerId?: string;
  };
  status: 'created' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'invalidated';
  headSha: string;
  readonlyPolicy: {
    enforced: boolean;
    allowedWritePaths: string[];
    forbiddenWritePaths: string[];
    violations?: string[];
    gitStatusBefore?: string;
    gitStatusAfter?: string;
    workspaceFingerprintBefore?: string;
    workspaceFingerprintAfter?: string;
  };
  result?: CodexEvaluationResult;
  artifactRefs: string[];
  startedAt: string;
  completedAt?: string;
}

export interface QuestionerContextV1 {
  schemaVersion: 'questioner-context.v1';
  run: {
    questionerRunId: string;
    invocationId: string;
    workflowId: string;
    intent: QuestionerIntent;
    headSha: string;
    contextHash: string;
    submitUrl: string;
  };
  workflow: {
    goal: string;
    policy: Record<string, unknown>;
    globalAcceptanceCriteria: string[];
  };
  subtask?: {
    id: string;
    title: string;
    description?: string;
    status: string;
    dependencies: string[];
  };
  contract?: {
    id: string;
    status: SprintContract['status'];
    mustCriteria: Array<{
      id: string;
      statement: string;
      verificationMethod?: string;
    }>;
    shouldCriteria: Array<{
      id: string;
      statement: string;
      verificationMethod?: string;
    }>;
    outOfScope: string[];
    requiredEvidence: string[];
  };
  implementationEvidence?: {
    id: string;
    builderInvocationId?: string;
    headSha?: string;
    summary: string;
    changedFiles: Array<{
      path: string;
      changeType?: string;
    }>;
    commands: Array<{
      id?: string;
      command: string;
      status?: string;
      summary?: string;
    }>;
    artifacts: Array<{
      ref: string;
      kind?: string;
      summary?: string;
    }>;
  };
  evaluation?: {
    id: string;
    evaluatorInvocationId?: string;
    readonly: boolean;
    headSha: string;
    verdict?: string;
    commands: CodexEvaluationResult['commandResults'];
    artifacts: Array<{
      ref: string;
      kind?: string;
      summary?: string;
    }>;
    coverage: CodexEvaluationResult['criteriaResults'];
    coverageGaps: CodexEvaluationResult['coverageGaps'];
    logs: Array<{
      artifactRef?: string;
      excerpt: string;
    }>;
  };
  finalEvaluation?: {
    id: string;
    headSha: string;
    verdict?: string;
    globalCriteriaCoverage: CodexEvaluationResult['criteriaResults'];
    requiredEvidence: Array<{
      ref: string;
      kind?: string;
      summary?: string;
    }>;
    coverageGaps: CodexEvaluationResult['coverageGaps'];
  };
  diff?: {
    baseSha?: string;
    headSha: string;
    files: Array<{
      path: string;
      changeType?: string;
    }>;
    excerpts: Array<{
      path: string;
      excerpt: string;
    }>;
  };
  relevantFiles: Array<{
    path: string;
    sha256: string;
    excerpt: string;
    reason: string;
  }>;
  previousQuestionerOutputs: Array<{
    id: string;
    intent: QuestionerIntent;
    verdict: string;
    unresolvedQuestions: Array<{
      id: string;
      priority: string;
      claim: string;
    }>;
  }>;
  outputContract: {
    schemaVersion: 'questioner-output.v2';
    requiredFields: string[];
    allowedVerdicts: string[];
  };
}

export interface CodexEvaluationResult {
  workflowId: string;
  subtaskId: string;
  contractId: string;
  evaluatorRunId: string;
  headSha: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'human_review_required';
  criteriaResults: Array<{
    criterionId: string;
    status: 'pass' | 'fail' | 'not_tested';
    evidence: string;
    reproductionSteps?: string[];
    artifactRefs?: string[];
  }>;
  commandResults: Array<{
    commandId: string;
    command: string;
    status: 'passed' | 'failed' | 'timeout' | 'skipped';
    exitCode?: number;
    stdoutArtifactId?: string;
    stderrArtifactId?: string;
    stdoutArtifactSha256?: string;
    stderrArtifactSha256?: string;
    stdoutArtifactBytes?: number;
    stderrArtifactBytes?: number;
    gateFailureCodes?: string[];
    testReports?: Array<{
      selector: string;
      className: string;
      tests: number;
      failures: number;
      errors: number;
      skipped: number;
      generatedAt: string;
      artifactId: string;
      artifactSha256: string;
      artifactBytes: number;
    }>;
    summary: string;
  }>;
  runtimeFindings: Array<{
    id: string;
    severity: 'blocker' | 'high' | 'medium' | 'low';
    title: string;
    observed: string;
    expected: string;
    reproductionSteps: string[];
    suspectedFiles?: Array<{
      path: string;
      line?: number;
      reason?: string;
    }>;
  }>;
  coverageGaps: Array<{
    criterionId?: string;
    description: string;
    reason: string;
  }>;
  confidence: number;
}

export interface QuestionerOutput {
  schemaVersion?: 'questioner-output.v1' | 'questioner-output.v2';
  id: string;
  questionerRunId?: string;
  workflowId: string;
  subtaskId?: string;
  source: 'claude-plugin' | 'manual' | 'codex-workflow';
  headSha: string;
  contractId?: string;
  evaluationRunId?: string;
  finalEvaluationRunId?: string;
  artifactRef?: string;
  attestation?: QuestionerOutputV2['attestation'];
  references?: QuestionerOutputV2['references'];
  coverageMatrix?: QuestionerOutputV2['coverageMatrix'];
  advisoryNotes?: string[];
  intent: QuestionerIntent;
  actor: {
    kind: 'claude-code-questioner';
    invocationId?: string;
    model?: string;
    pluginName?: 'agent-loop-claude-review';
    skillName?: 'question-tik-agent-loop';
  };
  verdict:
    | 'need_clarification'
    | 'contract_ready'
    | 'evidence_sufficient'
    | 'risk_found'
    | 'no_blocking_questions'
    | 'questions_blocking'
    | 'questions_non_blocking'
    | 'evidence_needed'
    | 'human_review_required';
  questions: QuestionerQuestion[];
  risks: QuestionerRisk[];
  missingTests: QuestionerMissingTest[];
  suggestedContractChanges: Array<{
    target:
      | 'acceptanceCriteria'
      | 'validationCommands'
      | 'playwrightScenarios'
      | 'apiChecks'
      | 'dbChecks'
      | 'negativeChecks';
    change: string;
    reason: string;
  }>;
  createdAt: string;
}

export interface QuestionerQuestion {
  id: string;
  priority: 'blocking' | 'important' | 'optional' | 'evidence_needed' | 'advisory';
  question?: string;
  whyItMatters?: string;
  expectedAnswerType?:
    | 'requirement'
    | 'constraint'
    | 'acceptance_criterion'
    | 'test_case'
    | 'edge_case'
    | 'architecture_decision'
    | 'evidence'
    | 'human_decision';
  category?:
    | 'ambiguous_requirement'
    | 'contract_gap'
    | 'coverage_gap'
    | 'missing_test'
    | 'weak_evidence'
    | 'stale_evidence'
    | 'head_mismatch'
    | 'artifact_gap'
    | 'safety_risk'
    | 'regression_risk';
  claim?: string;
  evidenceRefs?: string[];
  requestedFix?: string;
  requestedEvidence?: string;
  reproductionCommand?: string;
  status?: 'open' | 'resolved' | 'accepted_risk' | 'wont_fix';
}

export interface QuestionerRisk {
  id: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  suggestedMitigation?: string;
  evidenceRefs?: string[];
  mitigation?: string;
}

export interface QuestionerMissingTest {
  id: string;
  scenario?: string;
  testScenario?: string;
  reason: string;
  relatedCriteria?: string[];
  suggestedCommand?: string;
}

export interface QuestionerOutputV2 {
  schemaVersion: 'questioner-output.v2';
  id: string;
  questionerRunId: string;
  workflowId: string;
  subtaskId?: string;
  intent: QuestionerIntent;
  source: 'claude-plugin';
  actor: {
    kind: 'claude-code-questioner';
    invocationId: string;
    pluginName: 'agent-loop-claude-review';
    skillName: 'question-tik-agent-loop';
    model?: string;
  };
  attestation: {
    headSha: string;
    contextArtifactRef: string;
    contextHash: string;
    outputArtifactRef: string;
    outputHash: string;
    generatedAt: string;
  };
  references: {
    contractId?: string;
    evaluationRunId?: string;
    finalEvaluationRunId?: string;
  };
  verdict:
    | 'questions_blocking'
    | 'evidence_needed'
    | 'risk_found'
    | 'no_blocking_questions'
    | 'evidence_sufficient';
  coverageMatrix: Array<{
    criterionId: string;
    criterionText: string;
    required: boolean;
    status:
      | 'covered'
      | 'partially_covered'
      | 'missing'
      | 'not_applicable';
    evidenceRefs: string[];
    comment: string;
  }>;
  questions: Array<{
    id: string;
    priority: 'blocking' | 'evidence_needed' | 'advisory';
    category:
      | 'ambiguous_requirement'
      | 'contract_gap'
      | 'coverage_gap'
      | 'missing_test'
      | 'weak_evidence'
      | 'stale_evidence'
      | 'head_mismatch'
      | 'artifact_gap'
      | 'safety_risk'
      | 'regression_risk';
    claim: string;
    evidenceRefs: string[];
    requestedFix?: string;
    requestedEvidence?: string;
    reproductionCommand?: string;
    status: 'open';
  }>;
  risks: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    evidenceRefs: string[];
    mitigation?: string;
  }>;
  missingTests: Array<{
    id: string;
    testScenario: string;
    reason: string;
    relatedCriteria: string[];
    suggestedCommand?: string;
  }>;
  advisoryNotes: string[];
  createdAt?: string;
}

export interface QuestionResolution {
  id: string;
  workflowId: string;
  questionerOutputId: string;
  questionId: string;
  status: 'resolved' | 'accepted_risk' | 'wont_fix';
  resolvedByInvocationId?: string;
  resolvedByHuman?: string;
  evidenceRefs: string[];
  explanation: string;
  createdAt: string;
}
