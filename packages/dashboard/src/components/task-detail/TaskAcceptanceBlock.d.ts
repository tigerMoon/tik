import React from 'react';
import { type WorkbenchDecisionResponse, type WorkbenchArtifactRecord, type WorkbenchTaskResponse, type WorkbenchTimelineResponseItem } from '../../api/client';
interface TaskAcceptanceBlockProps {
    task: WorkbenchTaskResponse;
    timeline: WorkbenchTimelineResponseItem[];
    decisions: WorkbenchDecisionResponse[];
    artifacts?: WorkbenchArtifactRecord[];
}
export declare function TaskAcceptanceBlock({ task, timeline, decisions, artifacts }: TaskAcceptanceBlockProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=TaskAcceptanceBlock.d.ts.map