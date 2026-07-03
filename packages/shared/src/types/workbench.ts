import type { EnvironmentPackSelection, EnvironmentPackSnapshot } from './environment-pack.js';
import type { TaskWorkspaceBinding } from './task.js';

export type WorkbenchTaskStatus =
  | 'new'
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'needs_review'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'verifying'
  | 'accepted'
  | 'rejected'
  | 'retry'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'archived';

export type WorkbenchActor =
  | 'user'
  | 'supervisor'
  | 'researcher'
  | 'coder'
  | 'reviewer'
  | 'system';

export type AgentLoopWorkItemKind =
  | 'codex_implement'
  | 'codex_fix'
  | 'claude_review'
  | 'final_claude_review'
  | 'human_review';

export type ChangeRequestScm = 'github' | 'gitlab' | 'internal';

export type ChangeRequestType = 'pull_request' | 'merge_request' | 'internal_review';

export interface ChangeRequestRef {
  scm: ChangeRequestScm;
  repo: string;
  id: string;
  type?: ChangeRequestType;
  url?: string;
  title?: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  status?: 'open' | 'merged' | 'closed';
  ciStatus?: 'pending' | 'success' | 'failed' | 'unknown';
}

export interface BlockingIssue {
  title: string;
  file: string;
  line?: number;
  reason: string;
  suggestedFix?: string;
}

export interface NonBlockingSuggestion {
  title: string;
  file?: string;
  line?: number;
  reason: string;
}

export interface ReviewResult {
  verdict: 'request_changes' | 'comment' | 'approve';
  headShaReviewed: string;
  currentHeadSha?: string;
  workflowId?: string;
  blockingIssues: BlockingIssue[];
  nonBlockingSuggestions?: NonBlockingSuggestion[];
  testsNeeded?: string[];
  subtaskCoverage?: Array<{
    subtaskId: string;
    status: 'covered' | 'partial' | 'missing';
    notes?: string;
  }>;
  markdown: string;
  reviewerWorkerId?: string;
}

export interface ReviewInputSource {
  source: 'local_diff' | 'merge_request';
  mergeRequestUrl?: string;
  fetchRemote?: string;
  fetchRef?: string;
}

export interface AgentLoopMetadata {
  kind: AgentLoopWorkItemKind;
  phase?: 'needs_claude_review' | 'claude_reviewing' | 'needs_codex_fix' | 'codex_fixing' | 'needs_human_review' | 'stale' | 'complete';
  rootTaskId: string;
  round: number;
  maxRounds: number;
  nextReviewRound?: number;
  headSha?: string;
  previousHeadSha?: string;
  idempotencyKey: string;
  changeRequest: ChangeRequestRef;
  createdBy?: 'human' | 'codex' | 'claude' | 'system';
  allowedScope?: string[];
  acceptanceCriteria?: string[];
  reviewFocus?: string[];
  reviewInput?: ReviewInputSource;
  blockingIssues?: BlockingIssue[];
  reviewResult?: ReviewResult;
  stale?: {
    expectedHeadSha: string;
    actualHeadSha: string;
  };
}

export interface AgentLoopPayload {
  kind: AgentLoopWorkItemKind;
  rootTaskId: string;
  round: number;
  maxRounds?: number;
  changeRequest: ChangeRequestRef;
  idempotencyKey?: string;
  previousHeadSha?: string;
  nextReviewRound?: number;
  allowedScope?: string[];
  acceptanceCriteria?: string[];
  reviewFocus?: string[];
  reviewInput?: ReviewInputSource;
  blockingIssues?: BlockingIssue[];
  createdBy?: AgentLoopMetadata['createdBy'];
  labels?: string[];
  workspaceBinding?: TaskWorkspaceBinding;
  environmentPackSnapshot?: EnvironmentPackSnapshot;
  environmentPackSelection?: EnvironmentPackSelection;
}

export interface WorkbenchTaskRecord {
  id: string;
  identifier?: string;
  shortIdentifier?: string;
  title: string;
  description?: string | null;
  goal: string;
  status: WorkbenchTaskStatus;
  state?: string;
  priority?: number | null;
  labels?: string[];
  blockedBy?: WorkbenchTaskBlockerRecord[];
  blockedByTaskIds?: string[];
  parentTaskId?: string | null;
  assignee?: string | null;
  humanAssignee?: string | null;
  createdBy?: string | null;
  sourceUrl?: string | null;
  comments?: WorkbenchTaskCommentRecord[];
  attempts?: WorkbenchTaskAttemptRecord[];
  createdAt: string;
  updatedAt: string;
  activeSessionId?: string;
  currentOwner?: WorkbenchActor;
  latestSummary?: string;
  waitingReason?: string;
  waitingDecisionId?: string;
  lastProgressAt?: string;
  environmentPackSnapshot?: EnvironmentPackSnapshot;
  environmentPackSelection?: EnvironmentPackSelection;
  workspaceBinding?: TaskWorkspaceBinding;
  agentLoop?: AgentLoopMetadata;
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
  evidenceSummary?: WorkbenchTaskEvidenceSummary;
  runs?: WorkbenchTaskRunRecord[];
}

export interface WorkbenchTaskBlockerRecord {
  id?: string | null;
  shortIdentifier?: string | null;
  state?: string | null;
}

export interface WorkbenchTaskRunRecord {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'cancelled';
  kernelTaskId?: string;
  agentName?: string;
  turnCount?: number;
  errorReason?: string;
}

export interface WorkbenchTaskCommentRecord {
  id: string;
  authorKind: 'human' | 'agent' | 'system';
  authorId?: string;
  body: string;
  createdAt: string;
}

export interface WorkbenchTaskAttemptRecord {
  attemptNumber: number;
  startedAt: string;
  finishedAt?: string;
  outcome?: 'completed' | 'failed' | 'cancelled' | 'stalled';
  error?: string;
  kernelTaskId?: string;
  turnCount?: number;
}

export interface WorkbenchTaskEvidenceSummary {
  rawEventCount: number;
  modifiedFileCount: number;
  previewableArtifactCount: number;
  latestPreviewableArtifactPath?: string;
  latestPreviewableArtifactCreatedAt?: string;
  latestArtifactId?: string;
  latestArtifactVersionId?: string;
  artifactCount?: number;
  needsReviewArtifactCount?: number;
  acceptedArtifactCount?: number;
  latestToolName?: string;
  hasErrorEvidence: boolean;
}

export type ArtifactKind =
  | 'run_review'
  | 'transcript'
  | 'html'
  | 'markdown'
  | 'svg'
  | 'json'
  | 'text'
  | 'diff'
  | 'validation_log'
  | 'agent_output'
  | 'user_deliverable'
  | 'diagnostic'
  | 'report'
  | 'dashboard'
  | 'checklist'
  | 'timeline'
  | 'comparison';

export type ArtifactStatus =
  | 'draft'
  | 'previewable'
  | 'needs_review'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'archived';

export type ArtifactVisibility =
  | 'local'
  | 'workspace'
  | 'project'
  | 'exported';

export interface WorkbenchArtifactRecord {
  id: string;
  taskId: string;
  workspaceId?: string;
  projectId?: string;
  sessionId?: string;
  attemptId?: string;
  title: string;
  description?: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  latestVersionId: string;
  version: number;
  safeRelativePath: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  sourceEventIds: string[];
  sourceEvidenceIds: string[];
  changedFiles?: string[];
  validationRefs?: string[];
  decisionIds?: string[];
  producedBy: {
    agent?: string;
    provider?: string;
    model?: string;
    tool?: string;
    template?: string;
  };
  summary?: string;
  risks?: string[];
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

export interface WorkbenchArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  safeRelativePath: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  sourceEventIds: string[];
  sourceEvidenceIds: string[];
  changedFiles?: string[];
  validationRefs?: string[];
  decisionIds?: string[];
  summary?: string;
  createdAt: string;
}

export interface WorkbenchTaskAdjustmentRecord {
  previousTitle: string;
  previousGoal: string;
  nextTitle: string;
  nextGoal: string;
  note?: string;
  appliedAt: string;
}

export interface WorkbenchSessionRecord {
  id: string;
  taskId: string;
  status: 'running' | 'paused' | 'stopped';
  owner: WorkbenchActor;
  createdAt: string;
  updatedAt: string;
  compactSummary?: string;
}

export interface WorkbenchDecisionOption {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface WorkbenchDecisionRecord {
  id: string;
  taskId: string;
  title: string;
  summary: string;
  risk: 'medium' | 'high';
  recommendedOptionId?: string;
  status: 'pending' | 'resolved' | 'dismissed';
  options: WorkbenchDecisionOption[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkbenchEvidenceRecord {
  id: string;
  taskId: string;
  kind: 'command' | 'diff' | 'test' | 'search' | 'artifact' | 'note';
  title: string;
  body: string;
  createdAt: string;
}

export interface WorkbenchTimelineItem {
  id: string;
  taskId: string;
  kind: 'summary' | 'decision' | 'raw';
  actor: WorkbenchActor;
  body: string;
  evidenceIds?: string[];
  decisionId?: string;
  createdAt: string;
}

export interface CreateWorkbenchTaskInput {
  id?: string;
  identifier?: string;
  shortIdentifier?: string;
  title: string;
  description?: string | null;
  goal: string;
  status?: WorkbenchTaskStatus;
  state?: string;
  priority?: number | null;
  labels?: string[];
  blockedBy?: WorkbenchTaskBlockerRecord[];
  blockedByTaskIds?: string[];
  parentTaskId?: string | null;
  assignee?: string | null;
  humanAssignee?: string | null;
  createdBy?: string | null;
  sourceUrl?: string | null;
  comments?: WorkbenchTaskCommentRecord[];
  attempts?: WorkbenchTaskAttemptRecord[];
  runs?: WorkbenchTaskRunRecord[];
  environmentPackSnapshot?: EnvironmentPackSnapshot;
  environmentPackSelection?: EnvironmentPackSelection;
  workspaceBinding?: TaskWorkspaceBinding;
  agentLoop?: AgentLoopMetadata;
}

export function isWorkbenchTerminalStatus(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'completed'
    || status === 'accepted'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'archived';
}

export function canRetryWorkbenchTask(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'new'
    || status === 'backlog'
    || status === 'todo'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'paused'
    || status === 'retry'
    || status === 'rejected'
    || status === 'completed'
    || status === 'accepted'
    || status === 'archived';
}

export function canArchiveWorkbenchTask(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'new'
    || status === 'backlog'
    || status === 'todo'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'paused'
    || status === 'retry'
    || status === 'rejected'
    || status === 'completed';
}
