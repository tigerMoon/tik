import type { WorkspacePhase, WorkspaceSettings, WorkspaceSplitDemands, WorkspaceState, WorkspaceWorkflowPolicyConfig } from '@tik/shared';
import type { WorkspaceEventProjection } from './workspace-event-projection.js';
export interface WorkspaceSessionMemory {
    workspaceName?: string;
    rootPath: string;
    demand?: string;
    currentPhase?: WorkspacePhase;
    workflowProfile?: WorkspaceWorkflowPolicyConfig['profile'];
    completedProjects: string[];
    blockedProjects: string[];
    failedProjects: string[];
    recentEvents: string[];
    nextAction?: string;
    updatedAt: string;
}
export interface WorkspaceProjectMemory {
    projectName: string;
    projectPath: string;
    phase?: WorkspacePhase;
    status?: string;
    workflowRole?: string;
    workflowContract?: string;
    workflowSkillName?: string;
    executionMode?: 'native' | 'fallback';
    knownArtifacts: string[];
    recentEvents: string[];
    summary?: string;
    blockerKind?: string;
    recommendedCommand?: string;
    updatedAt: string;
}
export interface WorkspaceMemorySnapshot {
    session: WorkspaceSessionMemory;
    projects: WorkspaceProjectMemory[];
}
export interface WorkspaceMemoryRefreshInput {
    rootPath: string;
    settings: WorkspaceSettings | null;
    state: WorkspaceState | null;
    splitDemands: WorkspaceSplitDemands | null;
    projection: WorkspaceEventProjection;
}
export declare class WorkspaceMemoryStore {
    private readonly rootPath;
    constructor(rootPath: string);
    refresh(input: Omit<WorkspaceMemoryRefreshInput, 'rootPath'>): Promise<WorkspaceMemorySnapshot>;
    load(): Promise<WorkspaceMemorySnapshot | null>;
    loadOrBuild(input: Omit<WorkspaceMemoryRefreshInput, 'rootPath'>): Promise<WorkspaceMemorySnapshot>;
    private buildSnapshot;
    private getMemoryDir;
    private projectFileName;
    private writeIfChanged;
}
//# sourceMappingURL=workspace-memory.d.ts.map