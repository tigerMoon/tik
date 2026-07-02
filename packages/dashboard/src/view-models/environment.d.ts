import { type EnvironmentPackManifest, type EnvironmentPackWorkflowCoverage } from '@tik/shared';
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
export declare function getEnvironmentPackStatusBadge(pack: EnvironmentPackManifest, activePackId: string | null): EnvironmentPackStatusBadge;
export declare function buildEnvironmentPromotionQueue(pack: EnvironmentPackManifest): EnvironmentPromotionItem[];
export declare function countEnvironmentPromotionItems(packs: EnvironmentPackManifest[]): number;
export declare function buildEnvironmentWorkflowCoverage(pack: EnvironmentPackManifest): EnvironmentPackWorkflowCoverage[];
export declare function buildEnvironmentActivationSummary(pack: EnvironmentPackManifest, tasks: WorkbenchTaskResponse[], activePackId: string | null, syncedAt?: string | null): EnvironmentActivationSummary;
export declare function formatRelativeSyncTime(value?: string | null): string;
//# sourceMappingURL=environment.d.ts.map