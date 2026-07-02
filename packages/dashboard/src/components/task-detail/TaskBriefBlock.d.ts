import React from 'react';
import type { UpdateWorkbenchTaskBriefResult, WorkbenchTaskResponse } from '../../api/client';
interface TaskBriefBlockProps {
    task: WorkbenchTaskResponse;
    savingAdjustment: boolean;
    revertingAdjustment: boolean;
    onApplyTaskAdjustment: (task: WorkbenchTaskResponse, input: {
        title: string;
        goal: string;
        adjustment?: string;
        launchFollowUp?: boolean;
    }) => Promise<UpdateWorkbenchTaskBriefResult>;
    onRevertLastAdjustment: (task: WorkbenchTaskResponse) => Promise<void>;
}
export declare function TaskBriefBlock({ task, savingAdjustment, revertingAdjustment, onApplyTaskAdjustment, onRevertLastAdjustment, }: TaskBriefBlockProps): React.JSX.Element;
export {};
//# sourceMappingURL=TaskBriefBlock.d.ts.map