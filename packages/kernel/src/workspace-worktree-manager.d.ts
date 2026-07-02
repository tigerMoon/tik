import type { WorkspaceProjectWorktreeKind, WorkspaceProjectWorktreeState, WorkspaceWorktreeBranchStrategy, WorkspaceWorktreeMode, WorkspaceWorktreeNonGitStrategy, WorkspaceWorktreePolicyConfig, WorkspaceWorktreeRetention } from '@tik/shared';
export interface WorkspaceExecutionTarget {
    sourceProjectPath: string;
    effectiveProjectPath: string;
    worktree?: WorkspaceProjectWorktreeState;
}
export interface WorkspaceExecutionTargetInput {
    workspaceName: string;
    workspaceRoot: string;
    projectName: string;
    sourceProjectPath: string;
    laneId?: string;
    existingEffectiveProjectPath?: string;
    existingWorktree?: WorkspaceProjectWorktreeState;
    existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
    policy?: WorkspaceWorktreePolicyConfig;
}
export interface WorkspaceRemoveManagedWorktreeInput {
    workspaceName: string;
    workspaceRoot: string;
    projectName: string;
    sourceProjectPath: string;
    laneId?: string;
    existingWorktree?: WorkspaceProjectWorktreeState;
    existingWorktreeLanes?: WorkspaceProjectWorktreeState[];
    policy?: WorkspaceWorktreePolicyConfig;
    force?: boolean;
}
export interface WorkspaceManagedWorktreeEntry {
    projectName: string;
    sourceProjectPath: string;
    effectiveProjectPath: string;
    laneId?: string;
    active: boolean;
    kind: WorkspaceProjectWorktreeKind;
    dirtyFileCount?: number;
    dirtyFiles?: string[];
    warnings: string[];
    safeToActivate: boolean;
    safeToRemove: boolean;
    worktree?: WorkspaceProjectWorktreeState;
}
interface ResolvedWorktreePolicy {
    mode: WorkspaceWorktreeMode;
    defaultBranchStrategy: WorkspaceWorktreeBranchStrategy;
    defaultRetention: WorkspaceWorktreeRetention;
    nonGitStrategy: WorkspaceWorktreeNonGitStrategy;
    worktreeRoot: string;
}
export declare class WorkspaceWorktreeManager {
    resolvePolicy(workspaceRoot: string, policy?: WorkspaceWorktreePolicyConfig): ResolvedWorktreePolicy;
    buildManagedWorktreeBranch(workspaceName: string, projectName: string, sourceProjectPath: string, laneId?: string): string;
    buildManagedWorktreePath(workspaceRoot: string, projectName: string, sourceProjectPath: string, laneId?: string, policy?: WorkspaceWorktreePolicyConfig): string;
    isGitRepository(projectPath: string): boolean;
    readSourceBranch(projectPath: string): string | undefined;
    getExecutionTarget(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget>;
    readManagedWorktreeStatus(input: WorkspaceExecutionTargetInput): Promise<WorkspaceExecutionTarget>;
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
    }): Promise<WorkspaceManagedWorktreeEntry[]>;
    removeManagedWorktree(input: WorkspaceRemoveManagedWorktreeInput): Promise<WorkspaceExecutionTarget>;
    resolveManagedWorktreeLane(worktree: WorkspaceProjectWorktreeState | undefined, worktreeLanes: WorkspaceProjectWorktreeState[] | undefined, laneId?: string): WorkspaceProjectWorktreeState | undefined;
    private readExistingManagedWorktree;
    private branchExists;
    private findExistingLane;
    private readExistingNonGitCopy;
    private captureDirtyFiles;
    private buildWorktreeWarnings;
    private runGit;
    private captureCopyDirtyFiles;
    private buildFileSnapshot;
    private collectFileSnapshot;
}
export {};
//# sourceMappingURL=workspace-worktree-manager.d.ts.map