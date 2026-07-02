import type { WorkspaceExplanation, WorkspaceSettings, WorkspaceSplitDemands, WorkspaceState } from '@tik/shared';
export interface WorkspaceExplanationInput {
    workspaceRoot: string;
    settings?: WorkspaceSettings | null;
    state?: WorkspaceState | null;
    splitDemands?: WorkspaceSplitDemands | null;
    /** Optional project filter used by CLI report/board. */
    projectNames?: string[];
}
/**
 * Rule-based explanation builder.
 *
 * v1 intentionally does not call an LLM. It turns existing workspace state,
 * phase artifacts, blockers, and git status into a stable explanation object.
 */
export declare class WorkspaceExplanationBuilder {
    build(input: WorkspaceExplanationInput): WorkspaceExplanation;
    private visibleProjects;
    private resolveStatus;
    private buildSummary;
    private buildReasons;
    private collectPhases;
    private mapProjectStatus;
    private collectBlockers;
    private collectChangedFiles;
    private mapGitStatusToChangeType;
    private collectUnresolvedItems;
    private buildNextActions;
    private resolveConfidence;
}
//# sourceMappingURL=workspace-explanation-builder.d.ts.map