import type { TrackerDaemonLaunchInput, TrackerDaemonWorkLauncher, TrackerRunRecord, TrackedTask, WorkbenchLaunchTaskOptions, WorkbenchPort } from './types.js';
export declare class WorkbenchTrackerLauncher implements TrackerDaemonWorkLauncher {
    private readonly workbench;
    private readonly options;
    constructor(workbench: WorkbenchPort, options: WorkbenchLaunchTaskOptions);
    launchTask(task: TrackedTask, input: TrackerDaemonLaunchInput): Promise<{
        taskId: string;
        workbenchTaskId: string;
        projectPath: string;
    }>;
    stopRun(input: {
        taskId: string;
        reason: string;
        task: TrackedTask;
        run: TrackerRunRecord;
    }): Promise<void>;
    isRunActive(kernelTaskId: string): Promise<boolean>;
    runHook(name: string, input: {
        task: TrackedTask;
        workspaceRoot: string;
        projectPath: string;
        run?: TrackerRunRecord;
    }): Promise<void>;
    cleanupWorkspace(input: {
        task: TrackedTask;
        workspaceRoot: string;
        projectPath: string;
        run?: TrackerRunRecord;
    }): Promise<void>;
    markRuntimeRunStarted(task: TrackedTask, input: {
        runId: string;
        attempt: number;
        projectPath: string;
        runner: string;
        mode: string;
        startedAt: string;
    }): Promise<{
        attemptNumber: number;
    }>;
    markRuntimeRunFinished(taskId: string, input: {
        runId: string;
        attemptNumber: number;
        completion: {
            status: 'completed' | 'failed' | 'cancelled';
            error?: string;
        };
        endedAt: string;
        runner?: 'codex' | 'claude-code';
    }): Promise<void>;
    markAttemptFailed(taskId: string, error: string): Promise<void>;
    private buildWorkspaceBinding;
}
//# sourceMappingURL=workbench-launcher.d.ts.map