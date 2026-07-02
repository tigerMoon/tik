export function runWorkbenchKernelTaskInBackground(task, input) {
    void input.runTask(task).catch(async (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        input.logError?.(`[tracker] runTask failed for ${task.id}: ${error.message}`, error);
        await markWorkbenchRunTaskFailed(input.workbench, input.taskId, task.id, error);
    });
}
export async function markWorkbenchRunTaskFailed(workbench, workbenchTaskId, kernelTaskId, error) {
    const task = await workbench.readTask?.(workbenchTaskId);
    const attempt = task?.attempts
        ?.filter((item) => item.kernelTaskId === kernelTaskId && !item.finishedAt)
        .at(-1)
        || task?.attempts?.filter((item) => !item.finishedAt).at(-1);
    if (attempt) {
        await workbench.finishAttempt?.(workbenchTaskId, attempt.attemptNumber, 'failed', error.message);
    }
    const latestTask = await workbench.readTask?.(workbenchTaskId);
    if (latestTask && latestTask.status !== 'failed') {
        await workbench.transitionTask?.(workbenchTaskId, 'failed', {
            actor: 'daemon',
            reason: error.message,
        });
    }
}
//# sourceMappingURL=workbench-runner.js.map