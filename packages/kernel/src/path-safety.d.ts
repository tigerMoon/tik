export interface SafeResolveOptions {
    allowAbsolute?: boolean;
    allowDirectory?: boolean;
}
export interface SafeResolveWorkspacePathOptions {
    allowDirectory?: boolean;
}
export declare function safeResolveWorkspacePath(root: string, requestedPath: string, options?: SafeResolveWorkspacePathOptions): Promise<string>;
export declare function safeResolve(contextCwd: string, requestedPath: string, options?: SafeResolveOptions): Promise<string>;
//# sourceMappingURL=path-safety.d.ts.map