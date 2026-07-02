import React from 'react';
import type { WorkbenchDecisionResponse, WorkbenchTaskResponse, WorkbenchTimelineResponseItem } from '../api/client';
interface WorkbenchTimelineProps {
    task: WorkbenchTaskResponse | null;
    items: WorkbenchTimelineResponseItem[];
    decisions: WorkbenchDecisionResponse[];
    resolvingDecisionId?: string | null;
    onResolveDecision?: (taskId: string, decisionId: string, body: {
        optionId?: string;
        message?: string;
    }) => Promise<void>;
}
export declare function WorkbenchTimeline({ task, items, decisions, resolvingDecisionId, onResolveDecision, }: WorkbenchTimelineProps): React.JSX.Element;
export {};
//# sourceMappingURL=WorkbenchTimeline.d.ts.map