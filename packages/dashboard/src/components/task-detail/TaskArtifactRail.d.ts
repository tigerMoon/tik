import React from 'react';
import { type WorkbenchArtifactRecord, type WorkbenchTaskResponse } from '../../api/client';
interface TaskArtifactRailProps {
    task: WorkbenchTaskResponse;
    artifacts: WorkbenchArtifactRecord[];
    loading?: boolean;
    onGenerate: (taskId: string) => Promise<void>;
    onOpenArtifact: (artifactId: string) => void;
}
export declare function TaskArtifactRail({ task, artifacts, loading, onGenerate, onOpenArtifact, }: TaskArtifactRailProps): React.JSX.Element;
export {};
//# sourceMappingURL=TaskArtifactRail.d.ts.map