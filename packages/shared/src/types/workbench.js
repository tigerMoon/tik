export function isWorkbenchTerminalStatus(status) {
    return status === 'completed'
        || status === 'accepted'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'archived';
}
export function canRetryWorkbenchTask(status) {
    return status === 'new'
        || status === 'backlog'
        || status === 'todo'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'paused'
        || status === 'retry'
        || status === 'rejected'
        || status === 'completed'
        || status === 'accepted'
        || status === 'archived';
}
export function canArchiveWorkbenchTask(status) {
    return status === 'new'
        || status === 'backlog'
        || status === 'todo'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'paused'
        || status === 'retry'
        || status === 'rejected'
        || status === 'completed';
}
//# sourceMappingURL=workbench.js.map