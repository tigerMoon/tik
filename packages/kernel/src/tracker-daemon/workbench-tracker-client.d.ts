import type { TrackedTask, WorkbenchPort, TrackedTaskImporter } from './types.js';
export declare class WorkflowV2WorkbenchTaskImporter implements TrackedTaskImporter {
    private readonly workbench;
    private readonly defaultProjectPath;
    constructor(workbench: WorkbenchPort, defaultProjectPath: string);
    listCandidateTasks(): Promise<TrackedTask[]>;
    listOpenAttemptTasks(): Promise<TrackedTask[]>;
    fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]>;
    fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]>;
    private listWorkbenchTasks;
}
//# sourceMappingURL=workbench-tracker-client.d.ts.map