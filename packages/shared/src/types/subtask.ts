import type { ConvergenceStrategy, TaskStatus } from './task.js';
import type { WorkspacePhase } from './workspace.js';

export type WorkflowExecutablePhase = Extract<WorkspacePhase, 'PARALLEL_CLARIFY' | 'PARALLEL_SPECIFY' | 'PARALLEL_PLAN' | 'PARALLEL_ACE'>;

export type WorkflowSubtaskContract =
  | 'CLARIFY_SUBTASK'
  | 'SPECIFY_SUBTASK'
  | 'PLAN_SUBTASK'
  | 'ACE_SUBTASK';

export type WorkflowAgentRole =
  | 'planner'
  | 'executor'
  | 'reviewer';

export type WorkflowSkillName =
  | 'superpowers-clarify'
  | 'sdd-specify'
  | 'sdd-plan'
  | 'ace-sdd-workflow';

export type WorkflowSkillSourceKind =
  | 'agents'
  | 'superpowers';

export interface WorkflowExecutionReadyContract {
  summary?: string;
  confidence?: number;
  rationale?: string;
  targetFiles?: string[];
  candidateFiles?: Array<{ path: string; score: number; reason: string }>;
  targetMethods?: string[];
  cachePatternReferences?: string[];
  validationTargets?: string[];
  searchHints?: string[];
  artifacts?: string[];
  signals?: string[];
}

export interface WorkflowSubtaskInputs {
  demand: string;
  clarificationPath?: string;
  specContent?: string;
  planContent?: string;
  targetSpecPath?: string;
  resolvedSpecPath?: string;
  targetPlanPath?: string;
  executionContract?: WorkflowExecutionReadyContract;
  workspaceRoot?: string;
  workspaceFile?: string;
  sourceProjectPath?: string;
  effectiveProjectPath?: string;
  projectRoleHint?: string;
}

export interface WorkflowSubtaskSpec {
  projectName: string;
  projectPath: string;
  phase: WorkflowExecutablePhase;
  contract: WorkflowSubtaskContract;
  role: WorkflowAgentRole;
  skillName: WorkflowSkillName;
  skillSourceKind?: WorkflowSkillSourceKind;
  skillPath: string;
  description: string;
  inputs: WorkflowSubtaskInputs;
  strategy?: ConvergenceStrategy;
  maxIterations?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSubtaskResult {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowExecutablePhase;
  contract: WorkflowSubtaskContract;
  role: WorkflowAgentRole;
  skillName: WorkflowSkillName;
  skillSourceKind?: WorkflowSkillSourceKind;
  status: TaskStatus;
  summary: string;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowSubtaskHandle {
  taskId: string;
  spec: WorkflowSubtaskSpec;
  execute(): Promise<WorkflowSubtaskResult>;
  cancel?(): void | Promise<void>;
}

export type WorkflowSubtaskExecutionState =
  | 'prepared'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed';

export interface WorkflowSubtaskExecutionRecord {
  taskId: string;
  projectName: string;
  projectPath: string;
  phase: WorkflowExecutablePhase;
  contract: WorkflowSubtaskContract;
  role: WorkflowAgentRole;
  skillName: WorkflowSkillName;
  skillSourceKind?: WorkflowSkillSourceKind;
  state: WorkflowSubtaskExecutionState;
  attempt: number;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
}
