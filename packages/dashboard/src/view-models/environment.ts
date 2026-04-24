import {
  buildEnvironmentPackWorkflowCoverage,
  type EnvironmentPackManifest,
  type EnvironmentPackWorkflowCoverage,
} from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';

export interface EnvironmentPackStatusBadge {
  label: 'Active' | 'Ready';
  tone: 'active' | 'ready';
}

export interface EnvironmentPromotionItem {
  id: string;
  kind: string;
  detail: string;
}

export interface EnvironmentActivationSummary {
  statusLabel: string;
  boundTaskCount: number;
  activeTaskCount: number;
  waitingTaskCount: number;
  lastSyncLabel: string;
  mountedNamespaces: string[];
}

export function getEnvironmentPackStatusBadge(
  pack: EnvironmentPackManifest,
  activePackId: string | null,
): EnvironmentPackStatusBadge {
  if (pack.id === activePackId) {
    return { label: 'Active', tone: 'active' };
  }

  return { label: 'Ready', tone: 'ready' };
}

export function buildEnvironmentPromotionQueue(
  pack: EnvironmentPackManifest,
): EnvironmentPromotionItem[] {
  const items = new Map<string, EnvironmentPromotionItem>();
  buildEnvironmentPackWorkflowCoverage(pack).forEach((workflow) => {
    workflow.phases.forEach((phase) => {
      phase.missingCapabilities.forEach((capability) => {
        const id = `missing-capability:${workflow.workflow}:${phase.phase}:${capability}`;
        items.set(id, {
          id,
          kind: 'capability proposal',
          detail: `Promote "${capability}" into ${workflow.workflow} / ${phase.phase} so this pack can satisfy its declared workflow binding.`,
        });
      });
    });
  });

  if (pack.evaluators.length === 0) {
    items.set('missing-evaluators', {
      id: 'missing-evaluators',
      kind: 'coverage review',
      detail: 'Add at least one evaluator so this environment can verify task outcomes before release.',
    });
  }

  return Array.from(items.values()).slice(0, 4);
}

export function countEnvironmentPromotionItems(
  packs: EnvironmentPackManifest[],
): number {
  return packs.reduce((total, pack) => total + buildEnvironmentPromotionQueue(pack).length, 0);
}

export function buildEnvironmentWorkflowCoverage(
  pack: EnvironmentPackManifest,
): EnvironmentPackWorkflowCoverage[] {
  return buildEnvironmentPackWorkflowCoverage(pack);
}

export function buildEnvironmentActivationSummary(
  pack: EnvironmentPackManifest,
  tasks: WorkbenchTaskResponse[],
  activePackId: string | null,
  syncedAt?: string | null,
): EnvironmentActivationSummary {
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

export function buildEnvironmentCommandSnippet(
  pack: EnvironmentPackManifest,
  promotionQueueCount: number,
): string {
  return `@env/${pack.id} #open-manifest and review ${pack.policies.length} policies, ${pack.workflowBindings.length} workflow bindings, and ${promotionQueueCount} promotion queue item${promotionQueueCount === 1 ? '' : 's'}`;
}

export function formatRelativeSyncTime(value?: string | null): string {
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
