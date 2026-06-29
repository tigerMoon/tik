import React, { useMemo } from 'react';
import {
  type WorkbenchArtifactRecord,
  type WorkbenchTaskResponse,
} from '../../api/client';
import { buildTaskArtifactRailModel } from '../../view-models/artifacts';

interface TaskArtifactRailProps {
  task: WorkbenchTaskResponse;
  artifacts: WorkbenchArtifactRecord[];
  loading?: boolean;
  onGenerate: (taskId: string) => Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
}

export function TaskArtifactRail({
  task,
  artifacts,
  loading,
  onGenerate,
  onOpenArtifact,
}: TaskArtifactRailProps) {
  const model = useMemo(() => buildTaskArtifactRailModel(artifacts), [artifacts]);

  return (
    <section className="task-artifact-rail">
      <header className="task-artifact-header">
        <div>
          <span>Artifacts</span>
          <strong>{model.totalCount}</strong>
        </div>
        <button type="button" className="console-secondary-button" disabled={loading} onClick={() => void onGenerate(task.id)}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </header>

      {!model.latestArtifactId ? (
        <div className="task-artifact-empty">
          No review artifact yet. Generate one from current timeline and evidence.
        </div>
      ) : (
        <div className="task-artifact-summary">
          <div className="task-artifact-summary-main">
            <span className="task-artifact-summary-status">{model.statusSummary}</span>
            <strong>{model.latestTitle}</strong>
            <span>{model.latestMeta}</span>
          </div>
          <div className="task-artifact-summary-actions">
            <button type="button" onClick={() => onOpenArtifact(model.latestArtifactId!)}>
              {model.primaryActionLabel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
