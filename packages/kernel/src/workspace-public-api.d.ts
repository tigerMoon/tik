import type { WorkspaceDecisionRequest, WorkspaceSettings, WorkspaceSplitDemands, WorkspaceState } from '@tik/shared';
import { type WorkspaceEventProjection } from './workspace-event-projection.js';
import { WorkspaceMemoryStore, type WorkspaceMemorySnapshot } from './workspace-memory.js';
import { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import { type WorkspaceManagedWorktreeEntry } from './workspace-worktree-manager.js';
export declare const WORKSPACE_PUBLIC_API_VERSION = "2026-04-07";
export declare const WORKSPACE_PUBLIC_SCHEMA_VERSION = 2;
export interface WorkspaceManagedWorktreeView extends WorkspaceManagedWorktreeEntry {
    projectPhase?: NonNullable<WorkspaceState['projects']>[number]['phase'];
    projectStatus?: NonNullable<WorkspaceState['projects']>[number]['status'];
}
export interface WorkspaceWorktreesView {
    mode: NonNullable<WorkspaceSettings['worktreePolicy']>['mode'] | 'managed';
    root: string;
    nonGitStrategy: NonNullable<WorkspaceSettings['worktreePolicy']>['nonGitStrategy'] | 'source';
    entries: WorkspaceManagedWorktreeView[];
}
export interface WorkspacePublicSnapshot {
    apiVersion: string;
    schemaVersion: number;
    rootPath: string;
    settings: WorkspaceSettings | null;
    state: WorkspaceState | null;
    splitDemands: WorkspaceSplitDemands | null;
    projection: WorkspaceEventProjection;
    memory: WorkspaceMemorySnapshot;
    worktrees: WorkspaceWorktreesView;
}
export interface WorkspaceStatusView extends WorkspacePublicSnapshot {
}
export interface WorkspaceBoardView {
    apiVersion: string;
    schemaVersion: number;
    rootPath: string;
    phase: WorkspaceState['currentPhase'] | 'WORKSPACE_SPLIT';
    healthy: Array<NonNullable<WorkspaceState['projects']>[number]>;
    blocked: Array<NonNullable<WorkspaceState['projects']>[number]>;
    feedbackRequired: boolean;
    pendingDecisions: WorkspaceDecisionRequest[];
    projection: WorkspaceEventProjection;
    memory: WorkspaceMemorySnapshot;
}
export interface WorkspaceReportView extends WorkspacePublicSnapshot {
    eventCount: number;
}
export declare class WorkspaceReadModel {
    private readonly rootPath;
    private readonly orchestrator;
    private readonly memoryStore;
    private readonly worktreeManager;
    constructor(rootPath: string, options?: {
        orchestrator?: WorkspaceOrchestrator;
        memoryStore?: WorkspaceMemoryStore;
    });
    load(): Promise<WorkspacePublicSnapshot>;
    readStatusView(): Promise<WorkspaceStatusView>;
    readBoardView(): Promise<WorkspaceBoardView>;
    readReportView(): Promise<WorkspaceReportView>;
    private buildEmptyMemorySnapshot;
    private buildWorktreesView;
}
//# sourceMappingURL=workspace-public-api.d.ts.map