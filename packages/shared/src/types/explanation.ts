/**
 * Explanation Types
 *
 * Product-facing explanation model for terminal task/workspace states.
 * The goal is to translate runtime evidence into a user-readable reason:
 * why completed/failed/feedback happened, what changed, what remains.
 */

export type ExplanationStatus =
  | 'completed'
  | 'converged'
  | 'feedback'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

export type ChangedFileKind = 'created' | 'modified' | 'deleted' | 'renamed' | 'unknown';

export interface ChangedFileSummary {
  /** Repo-relative path when available. */
  path: string;
  /** Optional project/workspace member owning the file. */
  projectName?: string;
  changeType: ChangedFileKind;
  /** Human-readable reason when the runtime can infer it. */
  reason?: string;
  /** Evidence lines, task ids, artifact ids, or command summaries. */
  evidence?: string[];
}

export interface ExplanationBlocker {
  type:
    | 'external_repo_error'
    | 'missing_context'
    | 'tool_failure'
    | 'llm_failure'
    | 'needs_human'
    | 'replan_required'
    | 'runtime_blocker'
    | 'unknown';
  message: string;
  projectName?: string;
  phase?: string;
  evidence?: string[];
  relatedFiles?: string[];
}

export interface PhaseExplanation {
  /** Phase name, e.g. PARALLEL_SPECIFY / PARALLEL_PLAN / PARALLEL_ACE. */
  phase: string;
  projectName?: string;
  status: ExplanationStatus;
  summary: string;
  artifacts?: string[];
  changedFiles?: ChangedFileSummary[];
  blockers?: ExplanationBlocker[];
  evidence?: string[];
}

export interface WorkspaceExplanation {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  status: ExplanationStatus;
  summary: string;
  /** Plain-language reasons for the terminal/current state. */
  whyThisStatus: string[];
  phases: PhaseExplanation[];
  changedFiles: ChangedFileSummary[];
  blockers: ExplanationBlocker[];
  unresolvedItems: string[];
  nextActions: string[];
  confidence: 'high' | 'medium' | 'low';
  generatedAt: string;
}
