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

export type WorkflowDecisionAction =
  | 'ask_claude_question_requirement'
  | 'ask_claude_question_task_graph'
  | 'request_dynamic_plan'
  | 'draft_contract'
  | 'ask_claude_question_contract'
  | 'accept_contract'
  | 'execute_subtask'
  | 'record_implementation'
  | 'run_codex_evaluator'
  | 'validate_subtask'
  | 'ask_claude_question_evaluation'
  | 'fix_evaluation_findings'
  | 'request_claude_review'
  | 'fix_claude_blockers'
  | 're_evaluate'
  | 'request_re_review'
  | 'request_replan'
  | 'skip_non_blocking_suggestions'
  | 'request_human_review'
  | 'complete_subtask'
  | 'run_final_evaluation'
  | 'ask_claude_question_final_evidence'
  | 'request_final_review'
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
  | 'head_sha_mismatch'
  | 'readonly_policy_violated'
  | 'max_rounds_exceeded'
  | 'worktree_out_of_scope'
  | 'missing_subagent_invocation'
  | 'subagent_thread_not_isolated'
  | 'missing_evidence'
  | 'requires_human_approval'
  | 'unknown_error';

export interface GuardResult {
  accepted: boolean;
  code?: GuardResultCode;
  message?: string;
  currentState?: unknown;
}

export interface CreateMultiAgentWorkflowInput {
  id?: string;
  goal: string;
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
  status: MultiAgentWorkflowStatus;
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

export interface SubtaskSpec {
  id: string;
  title: string;
  goal: string;
  dependsOn: string[];
  allowedPaths: string[];
  blockedPaths?: string[];
  acceptanceCriteria: string[] | SubtaskAcceptanceCriterion[];
  validationCommands: string[];
  reviewFocus: string[];
  expectedChangedFiles?: string[];
  assignedExecutor: 'codex';
  assignedReviewer: 'claude-code';
}

export type SubtaskRunStatus =
  | 'pending'
  | 'ready'
  | 'contract_drafting'
  | 'contract_questioning'
  | 'contract_accepted'
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
  | 'reviewing'
  | 'needs_fix'
  | 'fixing'
  | 'review_approved'
  | 'approved'
  | 'done'
  | 'blocked'
  | 'human_review_required';

export interface SubtaskRunState {
  subtaskId: string;
  status: SubtaskRunStatus;
  implementationHeadSha?: string;
  lastValidatedHeadSha?: string;
  lastReviewedHeadSha?: string;
  reviewRoundIds: string[];
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
  | 'validation'
  | 'evaluation'
  | 'questioner'
  | 'review'
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

export type MultiAgentInvocationRole = 'planner' | 'reviewer' | 'final-reviewer' | 'executor' | 'questioner' | 'evaluator';
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
  };
  runtimeAttestation?: SubagentRuntimeAttestation;
  status: MultiAgentInvocationStatus;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SubagentRuntimeAttestation {
  source: 'codex-subagent-runtime' | 'codex-plugin-hook';
  parentThreadId: string;
  actualSubagentThreadId: string;
  role: MultiAgentInvocationRole;
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
    | 'fix_claude_blockers'
    | 'request_re_review'
    | 'request_replan'
    | 'request_human_review'
    | 'complete_workflow';
}

export type MultiAgentWorkflowEventType =
  | 'workflow.created'
  | 'decision.recorded'
  | 'task_graph.created'
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
  | 'questioner.output.recorded'
  | 'agent_invocation.created'
  | 'agent_invocation.started'
  | 'agent_invocation.completed'
  | 'codex.execute.started'
  | 'codex.execute.completed'
  | 'validation.started'
  | 'validation.completed'
  | 'claude.review.requested'
  | 'claude.review.started'
  | 'claude.review.completed'
  | 'codex.fix.started'
  | 'codex.fix.completed'
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
  questionerOutputs: QuestionerOutput[];
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
  allowClaudeFinalReview?: boolean;
  allowHumanOverride: boolean;
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
  };
  result?: CodexEvaluationResult;
  artifactRefs: string[];
  startedAt: string;
  completedAt?: string;
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
  id: string;
  workflowId: string;
  subtaskId?: string;
  intent:
    | 'question_requirement'
    | 'question_task_graph'
    | 'question_contract'
    | 'question_evaluation'
    | 'question_fix'
    | 'question_final_evidence';
  actor: {
    kind: 'claude-code-questioner';
    invocationId?: string;
  };
  source?: 'claude-plugin';
  headSha?: string;
  evaluationRunId?: string;
  contractId?: string;
  artifactRef?: string;
  verdict:
    | 'need_clarification'
    | 'contract_ready'
    | 'evidence_sufficient'
    | 'risk_found'
    | 'no_blocking_questions';
  questions: Array<{
    id: string;
    priority: 'blocking' | 'important' | 'optional';
    question: string;
    whyItMatters: string;
    expectedAnswerType:
      | 'requirement'
      | 'constraint'
      | 'acceptance_criterion'
      | 'test_case'
      | 'edge_case'
      | 'architecture_decision'
      | 'evidence'
      | 'human_decision';
  }>;
  risks: Array<{
    id: string;
    severity: 'high' | 'medium' | 'low';
    description: string;
    suggestedMitigation: string;
  }>;
  missingTests: Array<{
    id: string;
    scenario: string;
    reason: string;
  }>;
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
