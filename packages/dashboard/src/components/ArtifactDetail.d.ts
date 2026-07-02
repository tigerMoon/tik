import React from 'react';
import { type WorkbenchArtifactRecord, type WorkbenchArtifactVersion, type WorkbenchTaskResponse } from '../api/client';
interface ArtifactDetailProps {
    artifact: WorkbenchArtifactRecord | null;
    versions: WorkbenchArtifactVersion[];
    task: WorkbenchTaskResponse | null;
    loading?: boolean;
    busyAction?: 'accept' | 'reject' | 'archive' | null;
    onAccept: (artifactId: string) => Promise<void>;
    onReject: (artifactId: string, reason: string) => Promise<void>;
    onArchive: (artifactId: string) => Promise<void>;
    onOpenTask: (taskId: string) => void;
}
export declare function ArtifactDetail({ artifact, versions, task, loading, busyAction, onAccept, onReject, onArchive, onOpenTask, }: ArtifactDetailProps): React.JSX.Element;
export {};
//# sourceMappingURL=ArtifactDetail.d.ts.map