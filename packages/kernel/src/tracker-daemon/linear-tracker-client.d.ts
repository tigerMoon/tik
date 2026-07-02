import type { TrackedTask, TrackedTaskImporter } from './types.js';
export interface LinearTaskImporterOptions {
    apiKey: string;
    activeStates?: string[];
    terminalStates?: string[];
    endpoint?: string;
    projectSlug?: string;
    fetchJson?: (input: {
        endpoint: string;
        headers: Record<string, string>;
        body: {
            query: string;
            variables: Record<string, unknown>;
        };
    }) => Promise<any>;
}
export declare class LinearTaskImporter implements TrackedTaskImporter {
    private readonly options;
    private readonly activeStates;
    private readonly terminalStates;
    private readonly endpoint;
    private readonly fetchJson;
    constructor(options: LinearTaskImporterOptions);
    listCandidateTasks(): Promise<TrackedTask[]>;
    fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]>;
    fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]>;
    private request;
    private issueStateFilter;
    private withProjectSlug;
}
//# sourceMappingURL=linear-tracker-client.d.ts.map