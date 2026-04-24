import type { EnvironmentPackSelection, EnvironmentPackSnapshot } from './environment-pack.js';
import type { TaskWorkspaceBinding } from './task.js';

export type WorkbenchTaskStatus =
  | 'new'
  | 'running'
  | 'waiting_for_user'
  | 'blocked'
  | 'verifying'
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

export interface WorkbenchTaskRecord {
  id: string;
  title: string;
  goal: string;
  status: WorkbenchTaskStatus;
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
  lastAdjustment?: WorkbenchTaskAdjustmentRecord;
  evidenceSummary?: WorkbenchTaskEvidenceSummary;
}

export interface WorkbenchTaskEvidenceSummary {
  rawEventCount: number;
  modifiedFileCount: number;
  previewableArtifactCount: number;
  latestPreviewableArtifactPath?: string;
  latestPreviewableArtifactCreatedAt?: string;
  latestToolName?: string;
  hasErrorEvidence: boolean;
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
  title: string;
  goal: string;
  environmentPackSnapshot?: EnvironmentPackSnapshot;
  environmentPackSelection?: EnvironmentPackSelection;
  workspaceBinding?: TaskWorkspaceBinding;
}

export function isWorkbenchTerminalStatus(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'archived';
}

export function canRetryWorkbenchTask(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'new'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'paused'
    || status === 'completed'
    || status === 'archived';
}

export function canArchiveWorkbenchTask(
  status: WorkbenchTaskStatus,
): boolean {
  return status === 'new'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'paused'
    || status === 'completed';
}
