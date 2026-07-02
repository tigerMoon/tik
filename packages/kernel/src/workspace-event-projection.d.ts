import type { WorkflowSubtaskSpec } from '@tik/shared';
import type { WorkspaceEventKind, WorkspaceEventRecord } from './workspace-event-store.js';
export interface WorkspaceDisplayEventProjection {
    phase: WorkflowSubtaskSpec['phase'];
    kind: WorkspaceEventKind;
    projectName?: string;
    message: string;
    count: number;
    firstTimestamp: string;
    lastTimestamp: string;
}
export interface WorkspacePhaseEventProjection {
    phase: WorkflowSubtaskSpec['phase'];
    eventCount: number;
    lastMessage?: string;
}
export interface WorkspaceProjectEventProjection {
    projectName: string;
    eventCount: number;
    feedbackCount: number;
    recoveryCount: number;
    completionCount: number;
    lastKind?: WorkspaceEventKind;
    lastMessage?: string;
}
export interface WorkspaceEventProjection {
    totalEvents: number;
    phases: WorkspacePhaseEventProjection[];
    projects: WorkspaceProjectEventProjection[];
    recent: WorkspaceEventRecord[];
    recentDisplay: WorkspaceDisplayEventProjection[];
}
export declare function buildWorkspaceEventProjection(records: WorkspaceEventRecord[]): WorkspaceEventProjection;
//# sourceMappingURL=workspace-event-projection.d.ts.map