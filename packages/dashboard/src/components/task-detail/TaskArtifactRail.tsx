import React, { useState } from 'react';
import {
  buildWorkbenchArtifactVersionPreviewUrl,
  type WorkbenchArtifactRecord,
  type WorkbenchTaskResponse,
} from '../../api/client';

interface TaskArtifactRailProps {
  task: WorkbenchTaskResponse;
  artifacts: WorkbenchArtifactRecord[];
  loading?: boolean;
  busyArtifactId?: string | null;
  onGenerate: (taskId: string) => Promise<void>;
  onAccept: (artifactId: string) => Promise<void>;
  onReject: (artifactId: string, reason: string) => Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
}

export function TaskArtifactRail({
  task,
  artifacts,
  loading,
  busyArtifactId,
  onGenerate,
  onAccept,
  onReject,
  onOpenArtifact,
}: TaskArtifactRailProps) {
  const [reasonByArtifactId, setReasonByArtifactId] = useState<Record<string, string>>({});
  const latestArtifact = artifacts[0] || null;

  return (
    <section className="task-artifact-rail">
      <header className="task-artifact-header">
        <div>
          <span>Artifacts</span>
          <strong>{artifacts.length}</strong>
        </div>
        <button type="button" className="console-secondary-button" disabled={loading} onClick={() => void onGenerate(task.id)}>
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </header>

      {!latestArtifact ? (
        <div className="task-artifact-empty">
          No review artifact yet. Generate one from current timeline and evidence.
        </div>
      ) : (
        <div className="task-artifact-stack">
          {artifacts.map((artifact) => {
            const reason = reasonByArtifactId[artifact.id] || '';
            return (
              <article key={artifact.id} className="task-artifact-card">
                <div className="task-artifact-card-head">
                  <span className={`artifact-status is-${artifact.status}`}>{artifact.status.replace(/_/g, ' ')}</span>
                  <button type="button" onClick={() => onOpenArtifact(artifact.id)}>Open</button>
                </div>
                <strong>{artifact.title}</strong>
                <span>{artifact.kind} · v{artifact.version} · {formatShortDate(artifact.updatedAt)}</span>
                <div className="task-artifact-actions">
                  <a
                    href={buildWorkbenchArtifactVersionPreviewUrl(artifact.id, artifact.latestVersionId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                  <button
                    type="button"
                    disabled={busyArtifactId === artifact.id}
                    onClick={() => void onAccept(artifact.id)}
                  >
                    Accept
                  </button>
                </div>
                <label className="task-artifact-reject">
                  <span>Request changes</span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReasonByArtifactId({
                      ...reasonByArtifactId,
                      [artifact.id]: event.target.value,
                    })}
                  />
                </label>
                <button
                  type="button"
                  className="task-artifact-request-button"
                  disabled={busyArtifactId === artifact.id || !reason.trim()}
                  onClick={() => void onReject(artifact.id, reason)}
                >
                  Send request
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatShortDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
