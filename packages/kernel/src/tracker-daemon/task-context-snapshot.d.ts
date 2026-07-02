import type { TaskContextSnapshot, TaskOperatorComment, WorkbenchTaskCommentRecord, WorkbenchTaskRecord, WorkbenchTimelineItem } from '@tik/shared';
export declare function buildTaskContextSnapshot(task: WorkbenchTaskRecord | null | undefined, timeline?: WorkbenchTimelineItem[]): TaskContextSnapshot | undefined;
export declare function humanCommentsBudget(comments: WorkbenchTaskCommentRecord[] | undefined): TaskOperatorComment[] | undefined;
//# sourceMappingURL=task-context-snapshot.d.ts.map