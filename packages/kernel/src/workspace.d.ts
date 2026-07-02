/**
 * Workspace Resolver
 *
 * Discovers and parses VSCode .code-workspace files.
 * Manages .tik/ state directory alongside the workspace.
 */
import type { WorkspaceConfig, WorkspaceResolution } from '@tik/shared';
export declare class WorkspaceResolver {
    /**
     * Resolve workspace from a starting directory.
     *
     * 1. Walk up from cwd looking for *.code-workspace
     * 2. If found: parse folders, resolve paths
     * 3. If --target: scope to that project
     * 4. If no workspace: single-project mode (cwd = project)
     */
    resolve(cwd: string, target?: string): Promise<WorkspaceResolution>;
    /**
     * Walk up from cwd looking for *.code-workspace file.
     */
    private findWorkspaceFile;
    /**
     * Parse a .code-workspace file into a Workspace.
     */
    private parseWorkspace;
    /**
     * Resolve which project to use.
     * Priority: --target flag > cwd inside a project > first project
     */
    private resolveProject;
    /**
     * Ensure .tik/ directory structure exists.
     */
    private ensureTikDir;
    /**
     * Load workspace config from .tik/config.json.
     */
    private loadConfig;
    /**
     * Save workspace config to .tik/config.json.
     */
    saveConfig(rootPath: string, config: WorkspaceConfig): Promise<void>;
    private normalizePath;
}
//# sourceMappingURL=workspace.d.ts.map