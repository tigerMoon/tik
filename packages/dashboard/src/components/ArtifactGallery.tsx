import React, { useMemo, useState } from 'react';
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

type ArtifactGalleryFilter = 'all' | 'needs_review' | 'accepted' | 'rejected';

export function ArtifactGallery({
  artifacts,
  tasks,
  selectedArtifactId,
  loading,
  onSelectArtifact,
  onOpenTask,
  onRefresh,
}: ArtifactGalleryProps) {
  const [filter, setFilter] = useState<ArtifactGalleryFilter>('all');
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const visibleArtifacts = artifacts.filter((artifact) => filter === 'all' || artifact.status === filter);
  const counts = {
    all: artifacts.length,
    needs_review: artifacts.filter((artifact) => artifact.status === 'needs_review').length,
    accepted: artifacts.filter((artifact) => artifact.status === 'accepted').length,
    rejected: artifacts.filter((artifact) => artifact.status === 'rejected').length,
  };

  return (
    <section className="artifact-gallery panel">
      <header className="artifact-surface-header">
        <div>
          <span className="artifact-eyebrow">Artifacts</span>
          <h2>Review Gallery</h2>
        </div>
        <button type="button" className="console-secondary-button" onClick={() => void onRefresh()}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>

      <div className="artifact-filter-row">
        {([
          ['all', 'All'],
          ['needs_review', 'Needs review'],
          ['accepted', 'Accepted'],
          ['rejected', 'Rejected'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`artifact-filter-button ${filter === id ? 'is-active' : ''}`}
            onClick={() => setFilter(id)}
          >
            <span>{label}</span>
            <strong>{counts[id]}</strong>
          </button>
        ))}
      </div>

      <div className="artifact-table" role="list">
        {visibleArtifacts.length === 0 ? (
          <div className="artifact-empty">No artifacts in this view.</div>
        ) : visibleArtifacts.map((artifact) => {
          const task = tasksById.get(artifact.taskId);
          return (
            <div
              key={artifact.id}
              role="button"
              tabIndex={0}
              className={`artifact-row ${artifact.id === selectedArtifactId ? 'is-active' : ''}`}
              onClick={() => onSelectArtifact(artifact.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectArtifact(artifact.id);
                }
              }}
            >
              <span className={`artifact-status is-${artifact.status}`}>{artifact.status.replace(/_/g, ' ')}</span>
              <span className="artifact-row-main">
                <strong>{artifact.title}</strong>
                <span>{task?.shortIdentifier || task?.identifier || artifact.taskId} · {artifact.kind} · v{artifact.version}</span>
              </span>
              <span className="artifact-row-meta">
                <span>{artifact.producedBy.template || artifact.producedBy.tool || artifact.producedBy.provider || 'manual'}</span>
                <span>{formatShortDate(artifact.updatedAt)}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                className="artifact-task-link"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenTask(artifact.taskId);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenTask(artifact.taskId);
                  }
                }}
              >
                Task
              </span>
            </div>
          );
        })}
      </div>
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
