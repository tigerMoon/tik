import type { WorkbenchTaskRecord, WorkbenchTimelineItem } from '@tik/shared';

export interface WorkbenchTaskListItem extends WorkbenchTaskRecord {
  timelineCount: number;
}

export function buildWorkbenchTaskList(
  tasks: WorkbenchTaskRecord[],
  timelineByTaskId: Map<string, WorkbenchTimelineItem[]>,
): WorkbenchTaskListItem[] {
  return [...tasks]
    .sort((a, b) => (b.lastProgressAt || b.updatedAt).localeCompare(a.lastProgressAt || a.updatedAt))
    .map((task) => ({
      ...task,
      timelineCount: timelineByTaskId.get(task.id)?.length || 0,
    }));
}
