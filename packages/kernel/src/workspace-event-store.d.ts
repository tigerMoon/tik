import type { WorkflowSubtaskSpec } from '@tik/shared';
export type WorkspaceEventLevel = 'workspace' | 'project';
export type WorkspaceEventKind = 'phase.started' | 'phase.completed' | 'phase.blocked' | 'phase.recovered' | 'artifact.detected' | 'artifact.missing' | 'subtask.started' | 'subtask.completed' | 'feedback.recorded';
export interface WorkspaceEventRecord {
    timestamp: string;
    level: WorkspaceEventLevel;
    kind: WorkspaceEventKind;
    phase: WorkflowSubtaskSpec['phase'];
    projectName?: string;
    taskId?: string;
    message: string;
    metadata?: Record<string, unknown>;
}
export interface WorkspaceEventStoreOptions {
    persistPath?: string;
}
export declare class WorkspaceEventStore {
    private readonly records;
    private readonly persistPath?;
    constructor(options?: WorkspaceEventStoreOptions);
    record(event: Omit<WorkspaceEventRecord, 'timestamp'>): WorkspaceEventRecord;
    list(filter?: {
        phase?: WorkflowSubtaskSpec['phase'];
        projectName?: string;
    }): WorkspaceEventRecord[];
    latest(): WorkspaceEventRecord | undefined;
    snapshot(): WorkspaceEventRecord[];
    count(filter?: {
        phase?: WorkflowSubtaskSpec['phase'];
        projectName?: string;
        kind?: WorkspaceEventKind;
    }): number;
    private loadPersistedRecords;
}
//# sourceMappingURL=workspace-event-store.d.ts.map