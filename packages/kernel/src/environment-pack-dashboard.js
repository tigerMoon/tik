import * as path from 'node:path';
import { buildEnvironmentPackPromotionQueue, } from '@tik/shared';
export function buildEnvironmentPackDashboard(rootPath, packs, activePackId, tasks) {
    return {
        packs,
        activePackId,
        generatedAt: new Date().toISOString(),
        summaries: packs.map((pack) => buildEnvironmentPackDashboardSummary(rootPath, pack, activePackId, tasks)),
    };
}
function buildEnvironmentPackDashboardSummary(rootPath, pack, activePackId, tasks) {
    const boundTasks = tasks
        .filter((task) => task.environmentPackSnapshot?.id === pack.id)
        .sort((left, right) => getTaskTimestamp(right).localeCompare(getTaskTimestamp(left)));
    return {
        packId: pack.id,
        manifestPath: path.join(rootPath, 'env-packs', pack.id, 'pack.json'),
        status: pack.id === activePackId ? 'active' : 'ready',
        boundTaskCount: boundTasks.length,
        activeTaskCount: boundTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length,
        waitingTaskCount: boundTasks.filter((task) => WAITING_TASK_STATUSES.has(task.status)).length,
        latestBoundTasks: boundTasks.slice(0, 4).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            updatedAt: getTaskTimestamp(task),
        })),
        mountedNamespaces: [`env/${pack.id}/*`],
        promotionQueue: buildPromotionQueue(pack),
    };
}
function buildPromotionQueue(pack) {
    return buildEnvironmentPackPromotionQueue(pack, { limit: 6 });
}
function getTaskTimestamp(task) {
    return task.lastProgressAt || task.updatedAt || task.createdAt;
}
const ACTIVE_TASK_STATUSES = new Set([
    'new',
    'running',
    'verifying',
    'waiting_for_user',
    'paused',
]);
const WAITING_TASK_STATUSES = new Set([
    'waiting_for_user',
    'blocked',
    'failed',
    'cancelled',
]);
//# sourceMappingURL=environment-pack-dashboard.js.map