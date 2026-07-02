import { type EnvironmentPackManifest, type WorkbenchTaskRecord } from '@tik/shared';
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
export declare function buildEnvironmentPackDashboard(rootPath: string, packs: EnvironmentPackManifest[], activePackId: string | null, tasks: WorkbenchTaskRecord[]): EnvironmentPackDashboardResponse;
//# sourceMappingURL=environment-pack-dashboard.d.ts.map