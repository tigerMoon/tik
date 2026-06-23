import * as path from 'node:path';
import {
  buildEnvironmentPackPromotionQueue,
  type EnvironmentPackManifest,
  type WorkbenchTaskRecord,
} from '@tik/shared';

export interface EnvironmentPromotionQueueItem {
  id: string;
  kind: string;
  detail: string;
}

export interface EnvironmentPackTaskPreview {
  id: string;
  title: string;
  status: WorkbenchTaskRecord['status'];
  updatedAt: string;
}

export interface EnvironmentPackDashboardSummary {
  packId: string;
  manifestPath: string;
  status: 'active' | 'ready';
  boundTaskCount: number;
  activeTaskCount: number;
  waitingTaskCount: number;
  latestBoundTasks: EnvironmentPackTaskPreview[];
  mountedNamespaces: string[];
  promotionQueue: EnvironmentPromotionQueueItem[];
}

export interface EnvironmentPackDashboardResponse {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  generatedAt: string;
  summaries: EnvironmentPackDashboardSummary[];
}

export function buildEnvironmentPackDashboard(
  rootPath: string,
  packs: EnvironmentPackManifest[],
  activePackId: string | null,
  tasks: WorkbenchTaskRecord[],
): EnvironmentPackDashboardResponse {
  return {
    packs,
    activePackId,
    generatedAt: new Date().toISOString(),
    summaries: packs.map((pack) => buildEnvironmentPackDashboardSummary(rootPath, pack, activePackId, tasks)),
  };
}

function buildEnvironmentPackDashboardSummary(
  rootPath: string,
  pack: EnvironmentPackManifest,
  activePackId: string | null,
  tasks: WorkbenchTaskRecord[],
): EnvironmentPackDashboardSummary {
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

function buildPromotionQueue(
  pack: EnvironmentPackManifest,
): EnvironmentPromotionQueueItem[] {
  return buildEnvironmentPackPromotionQueue(pack, { limit: 6 });
}

function getTaskTimestamp(task: WorkbenchTaskRecord): string {
  return task.lastProgressAt || task.updatedAt || task.createdAt;
}

const ACTIVE_TASK_STATUSES = new Set<WorkbenchTaskRecord['status']>([
  'new',
  'running',
  'verifying',
  'waiting_for_user',
  'paused',
]);

const WAITING_TASK_STATUSES = new Set<WorkbenchTaskRecord['status']>([
  'waiting_for_user',
  'blocked',
  'failed',
  'cancelled',
]);
