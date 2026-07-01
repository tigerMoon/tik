export function chooseNextSubtask(graph, states) {
  if (!graph?.subtasks?.length) return null;
  return graph.subtasks.find((subtask) => {
    const state = states?.[subtask.id];
    const status = state?.status || 'pending';
    if (status !== 'ready' && status !== 'pending') return false;
    return (subtask.dependsOn || []).every((dep) => states?.[dep]?.status === 'done');
  }) || null;
}

export function findSubtask(graph, subtaskId) {
  return graph?.subtasks?.find((subtask) => subtask.id === subtaskId) || null;
}

export function allSubtasksDone(graph, states) {
  return Boolean(graph?.subtasks?.length) && graph.subtasks.every((subtask) => states?.[subtask.id]?.status === 'done');
}
