import * as fs from 'node:fs/promises';
export declare function isManagedTrackerWorktreePath(workspaceRoot: string, worktreePath: string): boolean;
export declare function cleanupManagedTrackerWorkspace(input: {
    workspaceRoot: string;
    worktreePath?: string;
    remove?: typeof fs.rm;
}): Promise<boolean>;
//# sourceMappingURL=tracker-workspace-cleanup.d.ts.map