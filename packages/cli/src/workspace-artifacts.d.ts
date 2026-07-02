export interface WorkspaceArtifactResolution {
    path: string | null;
    ambiguous: boolean;
    candidates: string[];
}
export declare function buildWorkspaceFeatureName(projectName: string, demand: string): string;
export declare function buildWorkspaceFeatureDir(projectPath: string, projectName: string, demand: string): string;
export declare function buildWorkspaceSpecTargetPath(projectPath: string, projectName: string, demand: string): string;
export declare function buildWorkspacePlanTargetPath(projectPath: string, projectName: string, demand: string): string;
export declare function workspaceFeatureDirForArtifact(artifactPath: string | null): string | null;
export declare function resolveWorkspaceSpecArtifact(projectPath: string, preferredSpecPath?: string | null): Promise<WorkspaceArtifactResolution>;
export declare function resolveWorkspacePlanArtifact(projectPath: string, options?: {
    preferredPlanPath?: string | null;
    preferredFeatureDir?: string | null;
}): Promise<WorkspaceArtifactResolution>;
//# sourceMappingURL=workspace-artifacts.d.ts.map