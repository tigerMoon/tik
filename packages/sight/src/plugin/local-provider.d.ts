/**
 * Local Context Provider
 *
 * File-based context provider that scans the real project structure.
 * Provides: project metadata, file tree, git history, spec files, run state.
 *
 * Note: Deep repo-aware analysis (code index, method scanner, PR lineage)
 * will be provided via MCP in Phase 3.
 */
import type { ContextFragment } from '../context/types.js';
import type { IContextProvider } from './types.js';
export declare class LocalContextProvider implements IContextProvider {
    name: string;
    getFragments(projectPath: string, _taskId: string, iteration: number): Promise<ContextFragment[]>;
    private readSpecFragments;
    private readRepoFragments;
    private readProjectMetadata;
    private getFileTree;
    private getGitLog;
    private getGitStatus;
    private readRunFragments;
    private frag;
}
//# sourceMappingURL=local-provider.d.ts.map