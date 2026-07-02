import type { AgentRunStorePort, AgentRuntimeName, TrackerDaemonRetryConfig, TrackerDaemonStateStore, TrackerDaemonTickResult, TrackerDaemonWatchHandle, TrackerDaemonWorkLauncher, TrackerWorkflowDefinition, TrackedTask, TrackedTaskImporter } from './types.js';
import type { AgentRuntimeRunner } from '../agent-runners/agent-runtime-runner.js';
import type { RunProofService } from '../agent-runners/run-proof-service.js';
export interface TrackerDaemonOptions {
    importer: TrackedTaskImporter;
    stateStore: TrackerDaemonStateStore;
    launcher: TrackerDaemonWorkLauncher;
    workspaceRoot: string;
    defaultProjectPath: string;
    now?: () => number;
    retry?: Partial<TrackerDaemonRetryConfig>;
    agentRunStore?: AgentRunStorePort;
    maxConcurrentAgents?: number;
    pollIntervalMs?: number;
    workflow?: TrackerWorkflowDefinition;
    workflowProvider?: () => Promise<TrackerWorkflowDefinition | undefined>;
    terminalStates?: string[];
    cleanupTerminalWorkspaces?: boolean;
    workspaceHooks?: {
        afterCreate?: string[];
        beforeRun?: string[];
        afterRun?: string[];
        beforeRemove?: string[];
    };
    runtimeRunners?: Partial<Record<AgentRuntimeName, AgentRuntimeRunner>>;
    runProofService?: RunProofService;
}
export declare class TrackerDaemon {
    private readonly options;
    private readonly retry;
    private readonly now;
    private watchTimer?;
    private tickInFlight;
    private watchStopped;
    private watchModeActive;
    constructor(options: TrackerDaemonOptions);
    watch(): TrackerDaemonWatchHandle;
    tick(): Promise<TrackerDaemonTickResult>;
    runExplicitTask(task: TrackedTask): Promise<TrackerDaemonTickResult>;
    private stopIneligibleRuns;
    private cleanupStaleOpenAttempts;
    private listRunningTasks;
    private cleanupTerminalTasks;
    private maxConcurrentAgents;
    private resolveWorkflow;
    private persistWatching;
    private createAgentRun;
    private renderWorkflowPrompt;
    private launchRuntimeRunner;
    private trackRuntimeCompletion;
    private recordRuntimeCompletion;
    private createRunProof;
    private isRuntimeRunActive;
    private appendAgentRunComplete;
    private appendAgentRunCancel;
    private appendAgentRunFailure;
    private runningCount;
    private runHooks;
    private retryIsDue;
    private resetUpdatedRetries;
    private nextRetry;
}
//# sourceMappingURL=tracker-daemon.d.ts.map