import { buildEnvironmentPackPromotionQueue, buildEnvironmentPackWorkflowCoverage, } from '@tik/shared';
export function getEnvironmentPackStatusBadge(pack, activePackId) {
    if (pack.id === activePackId) {
        return { label: 'Active', tone: 'active' };
    }
    return { label: 'Ready', tone: 'ready' };
}
export function buildEnvironmentPromotionQueue(pack) {
    return buildEnvironmentPackPromotionQueue(pack, { limit: 4 });
}
export function countEnvironmentPromotionItems(packs) {
    return packs.reduce((total, pack) => total + buildEnvironmentPackPromotionQueue(pack).length, 0);
}
export function buildEnvironmentWorkflowCoverage(pack) {
    return buildEnvironmentPackWorkflowCoverage(pack);
}
export function buildEnvironmentActivationSummary(pack, tasks, activePackId, syncedAt) {
    const boundTasks = tasks.filter((task) => task.environmentPackSnapshot?.id === pack.id);
    const activeStatuses = new Set(['new', 'running', 'verifying', 'waiting_for_user', 'paused']);
    const waitingStatuses = new Set(['waiting_for_user', 'blocked', 'failed', 'cancelled']);
    return {
        statusLabel: pack.id === activePackId ? 'Mounted and healthy' : 'Available for activation',
        boundTaskCount: boundTasks.length,
        activeTaskCount: boundTasks.filter((task) => activeStatuses.has(task.status)).length,
        waitingTaskCount: boundTasks.filter((task) => waitingStatuses.has(task.status)).length,
        lastSyncLabel: formatRelativeSyncTime(syncedAt),
        mountedNamespaces: [`env/${pack.id}/*`],
    };
}
export function formatRelativeSyncTime(value) {
    if (!value) {
        return 'Not synced yet';
    }
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
        return value;
    }
    const diffMs = Math.max(0, Date.now() - timestamp);
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) {
        return 'Just now';
    }
    if (diffMinutes < 60) {
        return `${diffMinutes} min ago`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
        return `${diffHours} hr ago`;
    }
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}
//# sourceMappingURL=environment.js.map