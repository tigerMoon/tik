import type { TrackedTask, TrackedTaskImporter } from './types.js';
export declare class JsonTaskImporter implements TrackedTaskImporter {
    private readonly filePath;
    constructor(filePath: string);
    listCandidateTasks(): Promise<TrackedTask[]>;
    fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]>;
    fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]>;
    private readTasks;
}
//# sourceMappingURL=json-tracker-client.d.ts.map