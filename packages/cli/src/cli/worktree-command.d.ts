import type { Command } from 'commander';
import type { WorkspaceProjectWorktreeState, WorkspaceResolution, WorkspaceSettings, WorkspaceWorktreePolicyConfig } from '@tik/shared';
import type { WorkspaceExecutionTarget, WorkspaceExecutionTargetInput, WorkspaceManagedWorktreeEntry, WorkspaceRemoveManagedWorktreeInput } from '@tik/kernel';
export type WorktreeWorkspaceStatusSnapshot = {
    settings: Pick<WorkspaceSettings, 'workspaceName' | 'worktreePolicy'> | null;
    state: {
        projects?: WorktreeWorkspaceProjectSnapshot[];
    } | null;
};
export interface WorktreeWorkspaceProjectSnapshot {
    projectName: string;
    projectPath: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    worktree?: WorkspaceProjectWorktreeState;
    worktreeLanes?: WorkspaceProjectWorktreeState[];
    status: string;
}
export type ManagedWorktreeEntry = WorkspaceManagedWorktreeEntry;
export interface WorktreeCommandServices {
    resolveProjectPath(opts: {
        project?: string;
        target?: string;
    }): Promise<WorkspaceResolution>;
    workspaceOrchestrator: {
        getStatus(rootPath: string): Promise<WorktreeWorkspaceStatusSnapshot>;
        markProjectWorktreeReady(rootPath: string, projectName: string, input: {
            effectiveProjectPath: string;
            worktree: WorkspaceProjectWorktreeState;
        }): Promise<unknown>;
        markProjectWorktreeRemoved(rootPath: string, projectName: string, input: {
            sourceProjectPath: string;
            worktree: WorkspaceProjectWorktreeState;
        }): Promise<unknown>;
        activateProjectWorktreeLane(rootPath: string, projectName: string, input: {
            effectiveProjectPath: string;
            worktree: WorkspaceProjectWorktreeState;
        }): Promise<unknown>;
    };
    workspaceWorktreeManager: {
        listManagedWorktrees(input: {
            workspaceName: string;
            workspaceRoot: string;
            projects: Array<{
                projectName: string;
                sourceProjectPath: string;
                effectiveProjectPath?: string;
                worktree?: WorkspaceProjectWorktreeState;
                worktreeLanes?: WorkspaceProjectWorktreeState[];
            }>;
            policy?: WorkspaceWorktreePolicyConfig;
        }): Promise<ManagedWorktreeEntry[]>;
        getExecutionTarget(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget>;
        removeManagedWorktree(input: WorkspaceRemoveManagedWorktreeInput): Promise<WorkspaceExecutionTarget>;
    };
    selectWorkspaceProjectSnapshot(projects: WorktreeWorkspaceProjectSnapshot[], activeProjectPath: string, target?: string): WorktreeWorkspaceProjectSnapshot | undefined;
    selectManagedWorktreeEntry(entries: ManagedWorktreeEntry[], projectName: string, sourceProjectPath?: string, laneId?: string): ManagedWorktreeEntry | undefined;
}
export declare function registerWorktreeCommands(program: Command, services: WorktreeCommandServices): void;
//# sourceMappingURL=worktree-command.d.ts.map