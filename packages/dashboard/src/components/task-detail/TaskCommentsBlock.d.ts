import React from 'react';
import type { WorkbenchTaskResponse, WorkbenchTimelineResponseItem } from '../../api/client';
interface TaskCommentsBlockProps {
    task: WorkbenchTaskResponse;
    timeline: WorkbenchTimelineResponseItem[];
    onAddTaskComment: (task: WorkbenchTaskResponse, body: string) => Promise<void>;
}
type CommentProcessingState = {
    tone: 'green' | 'red' | 'yellow';
    label: string;
    detail: string;
};
export declare function TaskCommentsBlock({ task, timeline, onAddTaskComment }: TaskCommentsBlockProps): React.JSX.Element;
export declare function buildCommentProcessingStates(comments: WorkbenchTaskResponse['comments'], timeline: WorkbenchTimelineResponseItem[]): Record<string, CommentProcessingState>;
export {};
//# sourceMappingURL=TaskCommentsBlock.d.ts.map