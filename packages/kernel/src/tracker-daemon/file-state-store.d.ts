import type { TrackerDaemonState, TrackerDaemonStateStore } from './types.js';
export declare class FileTrackerDaemonStateStore implements TrackerDaemonStateStore {
    private readonly statePath;
    constructor(statePath: string);
    static forWorkspace(workspaceRoot: string): FileTrackerDaemonStateStore;
    load(): Promise<TrackerDaemonState>;
    save(state: TrackerDaemonState): Promise<void>;
}
export declare function emptyState(): TrackerDaemonState;
//# sourceMappingURL=file-state-store.d.ts.map