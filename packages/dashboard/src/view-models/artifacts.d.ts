import type { WorkbenchArtifactRecord, WorkbenchTaskStatus } from '@tik/shared';
export type WorkbenchArtifactReviewGroup = WorkbenchArtifactRecord & {
    groupedArtifactCount: number;
    groupedVersionCount: number;
    groupedArtifactIds: string[];
};
export interface WorkbenchArtifactStatusCounts {
    all: number;
    needs_review: number;
    accepted: number;
    rejected: number;
}
export type ArtifactGalleryFilter = 'all' | 'needs_review' | 'accepted' | 'rejected';
export interface ArtifactGalleryViewModel {
    groupedArtifacts: WorkbenchArtifactReviewGroup[];
    rows: WorkbenchArtifactReviewGroup[];
    counts: WorkbenchArtifactStatusCounts;
}
export interface TaskArtifactRailModel {
    totalCount: number;
    needsReviewCount: number;
    acceptedCount: number;
    rejectedCount: number;
    latestArtifactId: string | null;
    latestTitle: string;
    latestMeta: string;
    primaryActionLabel: string;
    statusSummary: string;
}
export declare function buildArtifactGalleryViewModel(input: {
    artifacts: WorkbenchArtifactRecord[];
    tasks: Array<{
        id: string;
        status: WorkbenchTaskStatus;
    }>;
    filter: ArtifactGalleryFilter;
}): ArtifactGalleryViewModel;
export declare function buildTaskArtifactRailModel(artifacts: WorkbenchArtifactRecord[]): TaskArtifactRailModel;
export declare function groupWorkbenchArtifactsForReview(artifacts: WorkbenchArtifactRecord[], options?: {
    inactiveTaskIds?: Iterable<string>;
}): WorkbenchArtifactReviewGroup[];
export declare function countWorkbenchArtifactGroupsByStatus(artifacts: WorkbenchArtifactReviewGroup[]): WorkbenchArtifactStatusCounts;
//# sourceMappingURL=artifacts.d.ts.map