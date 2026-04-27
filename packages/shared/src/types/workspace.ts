import type { WorkflowAgentRole, WorkflowExecutablePhase, WorkflowSkillName, WorkflowSubtaskContract } from './subtask.js'; import type { WorkspaceExplanation } from './explanation.js';

/**
 * Workspace Types
 *
 * Reuses VSCode .code-workspace format for project discovery.
 * Tik state stored in .tik/ directory alongside the workspace file.
 */

// ─── VSCode .code-workspace format ──────────────────────────

export interface CodeWorkspaceFile {
  folders: CodeWorkspaceFolder[];
  settings?: Record<string, unknown>;
}

export interface CodeWorkspaceFolder {
  path: string;
  name?: string;
}

// ─── Tik Workspace ──────────────────────────────────────────

export interface Workspace {
  /** Workspace name (derived from .code-workspace filename) */
  name: string;
  /** Absolute path to workspace root (directory containing .code-workspace) */
  rootPath: string;
  /** Path to the .code-workspace file */
  workspaceFile: string;
  /** Resolved projects */
  projects: WorkspaceProject[];
  /** Workspace config */
  config: WorkspaceConfig;
}

export interface WorkspaceProject {
  /** Project name (folder name or explicit name) */
  name: string;
  /** Absolute path to project */
  path: string;
}

export interface WorkspaceConfig {
  /** Default convergence strategy */
  strategy?: 'incremental' | 'aggressive' | 'defensive';
  /** Default max iterations */
  maxIterations?: number;
  /** Default LLM model */
  model?: string;
}

// ─── Workspace Orchestration ───────────────────────────────

export type WorkspacePhase =
  | 'WORKSPACE_SPLIT'
  | 'PARALLEL_CLARIFY'
  | 'PARALLEL_SPECIFY'
  | 'PARALLEL_PLAN'
  | 'PARALLEL_ACE'
  | 'FEEDBACK_ITERATION'
  | 'COMPLETED';

export type WorkspaceWorkflowPolicyProfile =
  | 'balanced'
  | 'fast-feedback'
  | 'deep-verify';

export type WorkspaceWorktreeMode = 'disabled' | 'managed';

export type WorkspaceWorktreeBranchStrategy =
  | 'auto-create'
  | 'reuse-existing';

export type WorkspaceWorktreeRetention =
  | 'retain'
  | 'cleanup';

export type WorkspaceWorktreeNonGitStrategy =
  | 'block'
  | 'source'
  | 'copy';

export type WorkspaceProjectWorktreeKind =
  | 'git-worktree'
  | 'source'
  | 'copy';

export type WorkspaceProjectWorktreeStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'archived'
  | 'removed'
  | 'source';

export type WorkspaceDecisionPhase =
  | 'PARALLEL_CLARIFY'
  | 'PARALLEL_SPECIFY'
  | 'PARALLEL_PLAN'
  | 'PARALLEL_ACE';

export type WorkspaceDecisionKind =
  | 'clarification'
  | 'approach_choice'
  | 'phase_reroute'
  | 'approval';

export type WorkspaceDecisionConfidence = 'low' | 'medium' | 'high';

export interface WorkspaceDecisionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  nextPhase?: WorkspaceDecisionPhase;
  artifactPath?: string;
  artifactField?: 'specPath' | 'planPath';
}

export interface WorkspaceDecisionResolution {
  status: 'resolved' | 'dismissed';
  optionId?: string;
  message?: string;
  nextPhase?: WorkspaceDecisionPhase;
  resolvedAt: string;
}

export interface WorkspaceDecisionRequest {
  id: string;
  status: 'pending' | 'resolved' | 'dismissed';
  kind: WorkspaceDecisionKind;
  phase: WorkspaceDecisionPhase;
  projectName?: string;
  title: string;
  prompt: string;
  options?: WorkspaceDecisionOption[];
  recommendedOptionId?: string;
  allowFreeform?: boolean;
  confidence?: WorkspaceDecisionConfidence;
  rationale?: string;
  signals?: string[];
  sourceSummary?: string;
  createdAt: string;
  updatedAt: string;
  resolution?: WorkspaceDecisionResolution;
}

export interface WorkspaceSettings {
  workspaceName: string;
  workspaceRoot: string;
  workspaceFile: string;
  createdAt: string;
  updatedAt: string;
  projects: WorkspaceProject[];
  workflowPolicy?: WorkspaceWorkflowPolicyConfig;
  worktreePolicy?: WorkspaceWorktreePolicyConfig;
}

export interface WorkspaceDemandSplitItem {
  projectName: string;
  projectPath: string;
  demand: string;
  reason: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface WorkspaceSplitDemands {
  demand: string;
  createdAt: string;
  items: WorkspaceDemandSplitItem[];
}

export interface WorkspaceState {
  currentPhase: WorkspacePhase;
  demand: string;
  activeProjectNames: string[];
  createdAt: string;
  updatedAt: string;
  notes?: string[];
  projects?: WorkspaceProjectState[];
  workspaceFeedback?: WorkspaceFeedbackState;
  decisions?: WorkspaceDecisionRequest[];
  summary?: WorkspaceExecutionSummary;
}

export interface WorkspaceProjectState {
  projectName: string;
  projectPath: string;
  sourceProjectPath?: string;
  effectiveProjectPath?: string;
  phase: WorkspacePhase;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';
  executionMode?: 'native' | 'fallback';
  workflowContract?: WorkflowSubtaskContract;
  workflowRole?: WorkflowAgentRole;
  workflowSkillName?: WorkflowSkillName;
  workflowSkillPath?: string;
  worktree?: WorkspaceProjectWorktreeState;
  worktreeLanes?: WorkspaceProjectWorktreeState[];
  blockerKind?: 'NEED_HUMAN' | 'REPLAN' | 'EXECUTION_FAILED';
  clarificationPath?: string;
  clarificationStatus?: 'skipped' | 'generated' | 'awaiting_decision' | 'resolved';
  specPath?: string;
  planPath?: string;
  taskId?: string;
  clarifyTaskId?: string;
  specTaskId?: string;
  planTaskId?: string;
  aceTaskId?: string;
  recommendedCommand?: string;
  summary?: string;
  updatedAt: string;
}

export interface WorkspaceWorkflowPolicyConfig {
  profile?: WorkspaceWorkflowPolicyProfile;
  phaseBudgetsMs?: Partial<Record<WorkflowExecutablePhase, number>>;
  maxFeedbackRetriesPerPhase?: Partial<Record<WorkflowExecutablePhase, number>>;
  enableNativeArtifactRescue?: boolean;
  enableAceEvidencePromotion?: boolean;
}

export interface WorkspaceWorktreePolicyConfig {
  mode?: WorkspaceWorktreeMode;
  defaultBranchStrategy?: WorkspaceWorktreeBranchStrategy;
  defaultRetention?: WorkspaceWorktreeRetention;
  nonGitStrategy?: WorkspaceWorktreeNonGitStrategy;
  worktreeRoot?: string;
}

export interface WorkspaceProjectWorktreeState {
  enabled: boolean;
  status: WorkspaceProjectWorktreeStatus;
  kind?: WorkspaceProjectWorktreeKind;
  laneId?: string;
  sourceBranch?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  createdAt?: string;
  updatedAt: string;
  retainedAfterCompletion?: boolean;
  lastError?: string;
}

export interface WorkspaceFeedbackState {
  required: boolean;
  reason?: string;
  affectedProjects?: string[];
  nextPhase?: 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE';
  updatedAt: string;
}

export interface WorkspaceExecutionSummary {
  totalProjects: number;
  completedProjects: number;
  blockedProjects: number;
  failedProjects: number;
  clarifiedProjects?: number;
  pendingClarificationProjects?: number;
  needsHumanProjects: number;
  replanProjects: number;
  updatedAt: string;
}

// ─── Resolution Result ──────────────────────────────────────

export interface WorkspaceResolution {
  /** Resolved workspace (null if no .code-workspace found) */
  workspace: Workspace | null;
  /** The active project path (resolved from --target or cwd) */
  projectPath: string;
  /** Whether we're in workspace mode */
  isWorkspace: boolean;
}
