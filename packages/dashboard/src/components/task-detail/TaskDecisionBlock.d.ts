import React from 'react';
import type { WorkbenchDecisionResponse, WorkbenchTaskResponse } from '../../api/client';
interface TaskDecisionBlockProps {
    task: WorkbenchTaskResponse;
    decision: WorkbenchDecisionResponse | null;
    resolvingDecisionId?: string | null;
    onResolveDecision?: (taskId: string, decisionId: string, body: {
        optionId?: string;
        message?: string;
    }) => Promise<void>;
}
export declare function TaskDecisionBlock({ task, decision, resolvingDecisionId, onResolveDecision, }: TaskDecisionBlockProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=TaskDecisionBlock.d.ts.map