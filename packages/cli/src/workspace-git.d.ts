interface GitCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export declare function parseGitStatusPaths(output: string): string[];
export declare function captureWorkspaceGitChangedFiles(projectPath: string): Promise<Set<string>>;
export declare function isGitRepository(projectPath: string): boolean;
export declare function readGitBranch(projectPath: string): string | undefined;
export declare function listGitWorktrees(projectPath: string): Array<{
    path: string;
    branch?: string;
    bare?: boolean;
}>;
export declare function runGit(projectPath: string, args: string[]): GitCommandResult;
export {};
//# sourceMappingURL=workspace-git.d.ts.map