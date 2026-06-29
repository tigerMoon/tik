export type AgentRuntimeName = 'codex' | 'claude-code';

export type AgentRuntimeMode =
  | 'codex_exec'
  | 'codex_app_server'
  | 'claude_print'
  | 'claude_hooked';

export type AgentRunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_for_permission'
  | 'completed_by_agent'
  | 'needs_review'
  | 'accepted'
  | 'rejected'
  | 'retry'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface TranscriptRef {
  path: string;
  contentType?: string;
}

export interface DiffSummary {
  changedFiles: string[];
  insertions?: number;
  deletions?: number;
  patchPath?: string;
  statPath?: string;
}

export interface AgentRunRecord {
  id: string;
  taskId: string;
  shortIdentifier: string;
  attempt: number;
  runner: AgentRuntimeName;
  runnerMode: AgentRuntimeMode;
  workflowPath: string;
  workflowConfigHash: string;
  workflowPromptHash: string;
  status: AgentRunStatus;
  workspaceRoot: string;
  projectPath: string;
  worktreePath?: string;
  branchName?: string;
  startedAt?: string;
  lastHeartbeatAt?: string;
  endedAt?: string;
  transcriptRefs: TranscriptRef[];
  eventRefs: string[];
  artifactIds: string[];
  diffSummary?: DiffSummary;
  internalActivity?: {
    subagentCount?: number;
    internalTaskCount?: number;
    toolCallCount?: number;
  };
  failure?: {
    kind: 'runtime_error' | 'permission_denied' | 'timeout' | 'validation_failed' | 'unknown';
    message: string;
    retryable: boolean;
  };
}

export interface RunEvent {
  runId: string;
  ts: string;
  source: 'codex' | 'claude' | 'tik';
  kind:
    | 'run.start'
    | 'run.heartbeat'
    | 'run.complete'
    | 'run.fail'
    | 'run.cancel'
    | 'turn.start'
    | 'turn.complete'
    | 'subagent.start'
    | 'subagent.stop'
    | 'internal_task.created'
    | 'internal_task.completed'
    | 'tool.use'
    | 'permission.request'
    | 'artifact.discovered'
    | 'validation.result'
    | 'stdout'
    | 'stderr';
  payload: Record<string, unknown>;
}

export type RunProofStatus =
  | 'ready_for_review'
  | 'no_change'
  | 'validation_failed'
  | 'runner_failed'
  | 'proof_incomplete';

export type RunRiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface RunDiffSummary {
  filesChanged: number;
  insertions?: number;
  deletions?: number;
  changedFiles: string[];
  patchArtifactId?: string;
  statArtifactId?: string;
}

export interface RunValidationRef {
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs?: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
  summary?: string;
}

export interface RunProof {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  status: RunProofStatus;
  risk: RunRiskLevel;
  summary: string;
  transcriptArtifactIds: string[];
  diff: RunDiffSummary;
  validationRefs: RunValidationRef[];
  producedArtifactIds: string[];
  failure?: {
    kind: 'runner_error' | 'timeout' | 'validation_error' | 'collection_error' | 'unknown';
    message: string;
    retryable: boolean;
  };
  createdAt: string;
  updatedAt: string;
}
