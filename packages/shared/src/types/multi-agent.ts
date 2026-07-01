import type { ReviewResult } from './workbench.js';
import type { TaskWorkspaceBinding } from './task.js';

export type MultiAgentWorkflowStatus = 'active' | 'completed' | 'aborted';

export type WorkflowDecisionAction =
  | 'request_dynamic_plan'
  | 'execute_subtask'
  | 'validate_subtask'
  | 'request_claude_review'
  | 'fix_claude_blockers'
  | 'request_re_review'
  | 'request_replan'
  | 'skip_non_blocking_suggestions'
  | 'request_human_review'
  | 'complete_subtask'
  | 'request_final_review'
  | 'complete_workflow'
  | 'abort_workflow';

export interface WorkflowDecision {
  id: string;
  workflowId: string;
  rootTaskId: string;
  subtaskId?: string;
  reviewRoundId?: string;
  decidedBy: 'codex-workflow';
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
  | 'head_sha_mismatch'
  | 'max_rounds_exceeded'
  | 'worktree_out_of_scope'
  | 'missing_evidence'
  | 'requires_human_approval';

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
  createdBy: 'claude-code' | 'codex-workflow' | 'human';
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
  acceptanceCriteria: string[];
  validationCommands: string[];
  reviewFocus: string[];
  expectedChangedFiles?: string[];
  assignedExecutor: 'codex';
  assignedReviewer: 'claude-code';
}

export type SubtaskRunStatus =
  | 'pending'
  | 'ready'
  | 'executing'
  | 'implemented'
  | 'validating'
  | 'validated'
  | 'validation_failed'
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

export type MultiAgentInvocationRole = 'planner' | 'reviewer' | 'final-reviewer' | 'executor';
export type MultiAgentInvocationRunner = 'claude-code' | 'codex';
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
  status: MultiAgentInvocationStatus;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
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
  | 'subtask.selected'
  | 'subtask.updated'
  | 'evidence.recorded'
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
  decisions: WorkflowDecision[];
  evidence: MultiAgentWorkflowEvidence[];
  invocations: AgentInvocationRecord[];
  events: MultiAgentWorkflowEvent[];
}
