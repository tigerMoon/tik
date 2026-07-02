import React from 'react';
import type { WorkbenchArtifactRecord, WorkbenchTaskResponse } from '../api/client';
interface ArtifactGalleryProps {
    artifacts: WorkbenchArtifactRecord[];
    tasks: WorkbenchTaskResponse[];
    selectedArtifactId: string | null;
    loading?: boolean;
    onSelectArtifact: (artifactId: string) => void;
    onOpenTask: (taskId: string) => void;
    onRefresh: () => Promise<void>;
}
export declare function ArtifactGallery({ artifacts, tasks, selectedArtifactId, loading, onSelectArtifact, onOpenTask, onRefresh, }: ArtifactGalleryProps): React.JSX.Element;
export {};
//# sourceMappingURL=ArtifactGallery.d.ts.map