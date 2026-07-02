import type { WorkbenchTaskRecord, WorkbenchTimelineItem } from '@tik/shared';
export interface WorkbenchTaskListItem extends WorkbenchTaskRecord {
    timelineCount: number;
}
export declare function buildWorkbenchTaskList(tasks: WorkbenchTaskRecord[], timelineByTaskId: Map<string, WorkbenchTimelineItem[]>): WorkbenchTaskListItem[];
//# sourceMappingURL=workbench-projection.d.ts.map