import React, { useMemo, useState } from 'react';
import {
  buildWorkbenchArtifactVersionPreviewUrl,
  type WorkbenchArtifactRecord,
  type WorkbenchArtifactVersion,
  type WorkbenchTaskResponse,
} from '../api/client';

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

export function ArtifactDetail({
  artifact,
  versions,
  task,
  loading,
  busyAction,
  onAccept,
  onReject,
  onArchive,
  onOpenTask,
}: ArtifactDetailProps) {
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const activeVersion = useMemo(() => {
    if (!artifact) {
      return null;
    }
    return versions.find((version) => version.id === (selectedVersionId || artifact.latestVersionId))
      || versions.find((version) => version.id === artifact.latestVersionId)
      || versions[versions.length - 1]
      || null;
  }, [artifact, selectedVersionId, versions]);

  if (!artifact) {
    return (
      <section className="artifact-detail panel">
        <div className="artifact-empty">Select an artifact to inspect its preview and evidence.</div>
      </section>
    );
  }

  const previewUrl = activeVersion
    ? buildWorkbenchArtifactVersionPreviewUrl(artifact.id, activeVersion.id)
    : '';

  return (
    <section className="artifact-detail panel">
      <header className="artifact-detail-header">
        <div>
          <span className={`artifact-status is-${artifact.status}`}>{artifact.status.replace(/_/g, ' ')}</span>
          <h2>{artifact.title}</h2>
          <p>{task?.shortIdentifier || task?.identifier || artifact.taskId} · {artifact.kind} · v{artifact.version}</p>
        </div>
        <div className="artifact-action-row">
          <button
            type="button"
            className="console-secondary-button"
            disabled={busyAction !== null}
            onClick={() => void onAccept(artifact.id)}
          >
            {busyAction === 'accept' ? 'Accepting...' : 'Accept'}
          </button>
          <button
            type="button"
            className="console-secondary-button"
            disabled={busyAction !== null || !rejectionReason.trim()}
            onClick={() => void onReject(artifact.id, rejectionReason)}
          >
            {busyAction === 'reject' ? 'Rejecting...' : 'Request changes'}
          </button>
          <button
            type="button"
            className="console-danger-button"
            disabled={busyAction !== null}
            onClick={() => void onArchive(artifact.id)}
          >
            {busyAction === 'archive' ? 'Archiving...' : 'Archive'}
          </button>
        </div>
      </header>

      <div className="artifact-detail-grid">
        <main className="artifact-preview-pane">
          <div className="artifact-preview-toolbar">
            <label>
              <span>Version</span>
              <select
                value={activeVersion?.id || ''}
                onChange={(event) => setSelectedVersionId(event.target.value)}
              >
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                  </option>
                ))}
              </select>
            </label>
            {loading ? <span>Loading...</span> : null}
          </div>
          {activeVersion ? (
            <iframe
              title={`${artifact.title} preview`}
              className="artifact-preview-frame"
              sandbox="allow-scripts"
              src={previewUrl}
            />
          ) : (
            <div className="artifact-empty">No preview version available.</div>
          )}
        </main>

        <aside className="artifact-evidence-rail">
          <button type="button" className="artifact-task-open" onClick={() => onOpenTask(artifact.taskId)}>
            Open task
          </button>
          <label className="artifact-reject-note">
            <span>Review note</span>
            <textarea
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
              placeholder="Reason for request changes"
            />
          </label>
          <ArtifactMetaList title="Source events" items={artifact.sourceEventIds} />
          <ArtifactMetaList title="Evidence refs" items={artifact.sourceEvidenceIds} />
          <ArtifactMetaList title="Changed files" items={artifact.changedFiles || []} />
          <ArtifactMetaList title="Validation refs" items={artifact.validationRefs || []} />
          <ArtifactMetaList title="Risks" items={artifact.risks || []} />
        </aside>
      </div>
    </section>
  );
}

function ArtifactMetaList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="artifact-meta-list">
      <strong>{title}</strong>
      {items.length === 0 ? (
        <span>No entries</span>
      ) : (
        <ul>
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}
