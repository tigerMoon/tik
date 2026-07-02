import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { UpdateWorkbenchTaskBriefResult, UpdateWorkbenchTaskConfigurationInput, WorkbenchDecisionResponse, WorkbenchArtifactRecord, WorkbenchTaskResponse, WorkbenchTimelineResponseItem } from '../../api/client';
interface TaskDetailPanelProps {
    task: WorkbenchTaskResponse | null;
    pack: EnvironmentPackManifest | null;
    packs: EnvironmentPackManifest[];
    timeline: WorkbenchTimelineResponseItem[];
    decisions: WorkbenchDecisionResponse[];
    artifacts?: WorkbenchArtifactRecord[];
    resolvingDecisionId?: string | null;
    retrying: boolean;
    archiving: boolean;
    savingAdjustment: boolean;
    revertingAdjustment: boolean;
    savingConfiguration: boolean;
    controllingTaskAction?: 'pause' | 'resume' | 'stop' | null;
    timelineError?: string | null;
    onRetryTask: (task: WorkbenchTaskResponse) => Promise<void>;
    onArchiveTask: (task: WorkbenchTaskResponse) => Promise<void>;
    onApplyTaskAdjustment: (task: WorkbenchTaskResponse, input: {
        title: string;
        goal: string;
        adjustment?: string;
        launchFollowUp?: boolean;
    }) => Promise<UpdateWorkbenchTaskBriefResult>;
    onRevertLastAdjustment: (task: WorkbenchTaskResponse) => Promise<void>;
    onResolveDecision?: (taskId: string, decisionId: string, body: {
        optionId?: string;
        message?: string;
    }) => Promise<void>;
    onSaveTaskConfiguration: (taskId: string, selection: UpdateWorkbenchTaskConfigurationInput) => Promise<void>;
    /** Status transitions triggered by banner actions (reopen, unblock) reuse this handler. */
    onUpdateTaskMetadata: (task: WorkbenchTaskResponse, input: Partial<Pick<WorkbenchTaskResponse, 'status' | 'priority' | 'labels' | 'parentTaskId' | 'humanAssignee'>>) => Promise<void>;
    onAddTaskComment: (task: WorkbenchTaskResponse, body: string) => Promise<void>;
    onGenerateArtifact?: (taskId: string) => Promise<void>;
    onAcceptArtifact?: (artifactId: string) => Promise<void>;
    onRejectArtifact?: (artifactId: string, reason: string) => Promise<void>;
    onOpenArtifact?: (artifactId: string) => void;
    generatingArtifact?: boolean;
    busyArtifactId?: string | null;
    /** Banner stop/resume route through this. */
    onControlTask: (taskId: string, action: 'pause' | 'resume' | 'stop') => Promise<void>;
}
export declare function TaskDetailPanel(props: TaskDetailPanelProps): React.JSX.Element;
export {};
//# sourceMappingURL=TaskDetailPanel.d.ts.map