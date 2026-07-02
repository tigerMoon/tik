export function buildWorkbenchTaskList(tasks, timelineByTaskId) {
    return [...tasks]
        .sort((a, b) => (b.lastProgressAt || b.updatedAt).localeCompare(a.lastProgressAt || a.updatedAt))
        .map((task) => ({
        ...task,
        timelineCount: timelineByTaskId.get(task.id)?.length || 0,
    }));
}
//# sourceMappingURL=workbench-projection.js.map