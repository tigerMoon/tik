import React from 'react';
import { type WorkbenchArtifactRecord, type WorkbenchTaskResponse } from '../../api/client';
interface TaskRunProofPanelProps {
    task: WorkbenchTaskResponse;
    artifacts: WorkbenchArtifactRecord[];
    busyArtifactId?: string | null;
    onAcceptArtifact?: (artifactId: string) => Promise<void>;
    onRejectArtifact?: (artifactId: string, reason: string) => Promise<void>;
    onOpenArtifact?: (artifactId: string) => void;
}
export declare function TaskRunProofPanel({ task, artifacts, busyArtifactId, onAcceptArtifact, onRejectArtifact, onOpenArtifact, }: TaskRunProofPanelProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=TaskRunProofPanel.d.ts.map