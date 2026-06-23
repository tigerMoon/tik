import type {
  CreateWorkbenchTaskInput,
  CreateTaskInput,
  TaskWorkspaceBinding,
  WorkbenchTaskBlockerRecord,
  WorkbenchTaskRecord,
  WorkbenchTaskRunRecord,
  WorkbenchTimelineItem,
} from '@tik/shared';

export type TrackedTaskStateKind = 'active' | 'blocked' | 'terminal';

export interface TrackedTaskBlocker extends WorkbenchTaskBlockerRecord {
  id?: string | null;
  shortIdentifier?: string | null;
  state?: string | null;
}

export interface TrackedTaskRepositoryRef {
  name?: string;
  path?: string;
  workspaceFile?: string;
}

export interface TrackedTask {
  id: string;
  shortIdentifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: string;
  stateKind: TrackedTaskStateKind;
  sourceUrl?: string | null;
  labels: string[];
  blockedBy: TrackedTaskBlocker[];
  repository?: TrackedTaskRepositoryRef;
  assignee?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  activeKernelTaskId?: string | null;
  activeAttemptStartedAt?: string | null;
  sourceKind?: 'workbench' | 'external';
}

export interface TrackedTaskImporter {
  listCandidateTasks(): Promise<TrackedTask[]>;
  listOpenAttemptTasks?(): Promise<TrackedTask[]>;
  fetchTaskStatesByIds?(taskIds: string[]): Promise<TrackedTask[]>;
  fetchTasksByStates?(stateNames: string[]): Promise<TrackedTask[]>;
}

export interface TrackerRunRecord {
  taskId: string;
  shortIdentifier: string;
  kernelTaskId: string;
  workspaceRoot: string;
  projectPath: string;
  startedAt: string;
  status: 'running' | 'stopping' | 'stopped';
  lastTaskState: string;
  lastSeenAt: string;
}

export interface TrackerRetryRecord {
  taskId: string;
  shortIdentifier: string;
  attempt: number;
  dueAtMs: number;
  lastError: string;
  updatedAt: string;
}

export interface TrackerRecentRecord {
  type: 'dispatched' | 'stopped' | 'skipped' | 'failed';
  shortIdentifier: string;
  message: string;
  createdAt: string;
}

export interface TrackerDaemonState {
  runs?: Record<string, TrackerRunRecord>;
  retries: Record<string, TrackerRetryRecord>;
  watching?: boolean;
  recent?: TrackerRecentRecord[];
}

export interface TrackerDaemonStateStore {
  load(): Promise<TrackerDaemonState>;
  save(state: TrackerDaemonState): Promise<void>;
}

export interface TrackerDaemonLaunchInput {
  workspaceRoot: string;
  projectPath: string;
  workspaceBinding?: TaskWorkspaceBinding;
  prompt?: string;
  attempt?: number;
}

export interface TrackerDaemonLaunchResult {
  taskId: string;
  workbenchTaskId?: string;
  projectPath?: string;
}

export interface TrackerDaemonWorkLauncher {
  launchTask?(task: TrackedTask, input: TrackerDaemonLaunchInput): Promise<TrackerDaemonLaunchResult>;
  markAttemptFailed?(taskId: string, error: string): Promise<void>;
  isRunActive?(kernelTaskId: string): Promise<boolean> | boolean;
  stopRun(input: { taskId: string; reason: string; task: TrackedTask; run: TrackerRunRecord }): Promise<void>;
  runHook?(name: string, input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }): Promise<void>;
  cleanupWorkspace?(input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }): Promise<void>;
}

export interface TrackerDaemonRetryConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface TrackerDaemonTickResult {
  dispatched: string[];
  stopped: string[];
  skipped: Array<{ shortIdentifier: string; reason: string }>;
  failed: Array<{ shortIdentifier: string; error: string }>;
}

export interface TrackerWorkflowConfig {
  tracker: {
    kind: 'json' | 'linear';
    taskFile?: string;
    endpoint?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    projectSlug?: string;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
    maxConcurrentAgents: number;
  };
  workspace: {
    root: string;
    cleanupTerminal: boolean;
    hooks: {
      afterCreate: string[];
      beforeRun: string[];
      afterRun: string[];
      beforeRemove: string[];
    };
  };
  agent: {
    timeoutMs: number;
  };
}

export interface TrackerWorkflowDefinition {
  config: TrackerWorkflowConfig;
  promptTemplate: string;
  renderPrompt(task: TrackedTask, input?: { attempt?: number }): string;
}

export interface TrackerDaemonWatchHandle {
  stop(): void;
}

export interface WorkbenchLaunchTaskOptions {
  workspaceRoot: string;
  defaultProjectPath: string;
  workspaceName?: string;
  resolveExecutionTarget?: (input: {
    task: TrackedTask;
    workspaceRoot: string;
    workspaceName: string;
    projectName: string;
    sourceProjectPath: string;
    laneId: string;
  }) => Promise<{
    sourceProjectPath: string;
    effectiveProjectPath: string;
    worktreeKind?: TaskWorkspaceBinding['worktreeKind'];
    worktreePath?: string;
  }>;
  runTask?: (task: { id: string }, input: { workbenchTaskId: string }) => Promise<unknown> | unknown;
  isRunActive?: (kernelTaskId: string) => Promise<boolean> | boolean;
  stopTask?: (taskId: string, reason: string) => Promise<unknown> | unknown;
  runHook?: (name: string, input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }) => Promise<unknown> | unknown;
  cleanupWorkspace?: (input: { task: TrackedTask; workspaceRoot: string; projectPath: string; run?: TrackerRunRecord }) => Promise<unknown> | unknown;
  createKernelTask?: (input: {
    id?: string;
    description: string;
    projectPath: string;
    workspaceBinding: TaskWorkspaceBinding;
    recentComments?: CreateTaskInput['recentComments'];
    taskContextSnapshot?: CreateTaskInput['taskContextSnapshot'];
  }) => { id: string };
}

export interface WorkbenchPort {
  createTask(input: CreateWorkbenchTaskInput, taskId?: string): Promise<WorkbenchTaskRecord>;
  readTask?(taskId: string): Promise<WorkbenchTaskRecord | null>;
  readTimeline?(taskId: string): Promise<WorkbenchTimelineItem[]>;
  listTasks?(): Promise<WorkbenchTaskRecord[]>;
  transitionTask?(taskId: string, to: WorkbenchTaskRecord['status'], input?: { reason?: string; actor?: 'human' | 'agent' | 'daemon' | 'system' }): Promise<WorkbenchTaskRecord | null>;
  updateTaskTrackerMetadata?(taskId: string, input: {
    title?: string;
    description?: string | null;
    goal?: string;
    status?: WorkbenchTaskRecord['status'];
    priority?: number | null;
    labels?: string[];
    parentTaskId?: string | null;
    humanAssignee?: string | null;
    assignee?: string | null;
    createdBy?: string | null;
    sourceUrl?: string | null;
  }): Promise<WorkbenchTaskRecord | null>;
  appendAttempt?(taskId: string, input: Partial<NonNullable<WorkbenchTaskRecord['attempts']>[number]>): Promise<NonNullable<WorkbenchTaskRecord['attempts']>[number]>;
  finishAttempt?(taskId: string, attemptNumber: number, outcome: NonNullable<NonNullable<WorkbenchTaskRecord['attempts']>[number]['outcome']>, error?: string): Promise<WorkbenchTaskRecord | null>;
  appendTaskRun?(taskId: string, run: WorkbenchTaskRunRecord): Promise<WorkbenchTaskRecord | null>;
}
