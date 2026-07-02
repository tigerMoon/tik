import React from 'react';
import type { WorkspaceDecision, WorkspaceStatusResponse } from '../api/client';
interface WorkspacePanelProps {
    workspaceRoot: string;
    onWorkspaceRootChange: (value: string) => void;
    onRefresh: () => void;
    status: WorkspaceStatusResponse | null;
    pendingDecisions: WorkspaceDecision[];
    resolutionDrafts: Record<string, string>;
    onResolutionDraftChange: (decisionId: string, value: string) => void;
    onResolve: (decisionId: string, optionId?: string, message?: string) => Promise<void>;
    busyDecisionId?: string | null;
    worktreeLaneDrafts: Record<string, string>;
    onWorktreeLaneDraftChange: (projectKey: string, value: string) => void;
    onCreateWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string) => Promise<void>;
    onUseWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string, force?: boolean) => Promise<void>;
    onRemoveWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string, force?: boolean) => Promise<void>;
    busyWorktreeKey?: string | null;
    loading: boolean;
    error?: string | null;
}
export declare function WorkspacePanel(props: WorkspacePanelProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkspacePanel.d.ts.map