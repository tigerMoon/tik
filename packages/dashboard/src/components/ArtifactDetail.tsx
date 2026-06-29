import React, { useEffect, useMemo, useState } from 'react';
import {
  buildWorkbenchArtifactVersionPreviewUrl,
  type WorkbenchArtifactRecord,
  type WorkbenchArtifactVersion,
  type WorkbenchTaskResponse,
} from '../api/client';
import {
  classifyArtifactPreviewMode,
  parseArtifactDiff,
  parseArtifactDiffStat,
  parseArtifactLogSections,
  shouldFetchArtifactPreviewText,
  type ArtifactPreviewMode,
} from '../view-models/artifact-preview';

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
  const [previewText, setPreviewText] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const activeVersion = useMemo(() => {
    if (!artifact) {
      return null;
    }
    return versions.find((version) => version.id === (selectedVersionId || artifact.latestVersionId))
      || versions.find((version) => version.id === artifact.latestVersionId)
      || versions[versions.length - 1]
      || null;
  }, [artifact, selectedVersionId, versions]);

  const previewUrl = artifact && activeVersion
    ? buildWorkbenchArtifactVersionPreviewUrl(artifact.id, activeVersion.id)
    : '';
  const previewMode = artifact ? classifyArtifactPreviewMode(artifact) : 'embed';

  useEffect(() => {
    if (!previewUrl || !shouldFetchArtifactPreviewText(previewMode)) {
      setPreviewText('');
      setPreviewError(null);
      return;
    }

    const controller = new AbortController();
    setPreviewError(null);
    setPreviewText('');
    fetch(previewUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Preview request failed: ${response.status}`);
        }
        return response.text();
      })
      .then((content) => setPreviewText(content))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setPreviewError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => controller.abort();
  }, [previewMode, previewUrl]);

  if (!artifact) {
    return (
      <section className="artifact-detail panel">
        <div className="artifact-empty">Select an artifact to inspect its preview and evidence.</div>
      </section>
    );
  }

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
            <ArtifactPreview
              artifact={artifact}
              mode={previewMode}
              previewUrl={previewUrl}
              previewText={previewText}
              previewError={previewError}
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

function ArtifactPreview({
  artifact,
  mode,
  previewUrl,
  previewText,
  previewError,
}: {
  artifact: WorkbenchArtifactRecord;
  mode: ArtifactPreviewMode;
  previewUrl: string;
  previewText: string;
  previewError: string | null;
}) {
  if (previewError) {
    return <div className="artifact-empty">Preview failed: {previewError}</div>;
  }

  if (shouldFetchArtifactPreviewText(mode) && !previewText) {
    return <div className="artifact-empty">Loading preview...</div>;
  }

  switch (mode) {
    case 'diff':
      return <ArtifactDiffPreview content={previewText} />;
    case 'diff-stat':
      return <ArtifactDiffStatPreview content={previewText} />;
    case 'log':
      return <ArtifactLogPreview content={previewText} />;
    case 'text':
      return <ArtifactTextPreview content={previewText} />;
    default:
      return (
        <iframe
          title={`${artifact.title} preview`}
          className="artifact-preview-frame"
          sandbox="allow-scripts"
          src={previewUrl}
        />
      );
  }
}

function ArtifactDiffPreview({ content }: { content: string }) {
  const model = useMemo(() => parseArtifactDiff(content), [content]);
  return (
    <div className="artifact-formatted-preview artifact-diff-preview">
      {model.files.map((file, fileIndex) => (
        <section key={`${file.path}-${fileIndex}`} className="artifact-diff-file">
          <div className="artifact-diff-file-header">{file.path}</div>
          <pre>
            {file.lines.map((line, lineIndex) => (
              <span key={`${file.path}-${lineIndex}`} className={`artifact-diff-line is-${line.kind}`}>
                {line.text || ' '}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function ArtifactDiffStatPreview({ content }: { content: string }) {
  const model = useMemo(() => parseArtifactDiffStat(content), [content]);
  return (
    <div className="artifact-formatted-preview artifact-stat-preview">
      {model.summary ? <div className="artifact-stat-summary">{model.summary}</div> : null}
      {model.rows.length ? (
        <div className="artifact-stat-table" role="table" aria-label="Diff stat">
          {model.rows.map((row) => (
            <div key={row.filePath} className="artifact-stat-row" role="row">
              <span className="artifact-stat-path" role="cell">{row.filePath}</span>
              <strong role="cell">{row.changes}</strong>
              <span className="artifact-stat-bars" role="cell" aria-label={`${row.additions} additions, ${row.deletions} deletions`}>
                <span className="artifact-stat-add" style={{ flexGrow: Math.max(row.additions, 0) }} />
                <span className="artifact-stat-remove" style={{ flexGrow: Math.max(row.deletions, 0) }} />
              </span>
              <span className="artifact-stat-counts" role="cell">+{row.additions} -{row.deletions}</span>
            </div>
          ))}
        </div>
      ) : (
        <ArtifactTextPreview content={content} />
      )}
    </div>
  );
}

function ArtifactLogPreview({ content }: { content: string }) {
  const sections = useMemo(() => parseArtifactLogSections(content), [content]);
  return (
    <div className="artifact-formatted-preview artifact-log-preview">
      {sections.map((section) => (
        <section key={section.title} className="artifact-log-section">
          <div className="artifact-log-heading">{section.title}</div>
          <pre>
            {section.lines.map((line) => (
              <span key={line.number} className="artifact-log-line">
                <span>{line.number}</span>
                <code>{line.text || ' '}</code>
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function ArtifactTextPreview({ content }: { content: string }) {
  return (
    <div className="artifact-formatted-preview artifact-text-preview">
      <pre>{content}</pre>
    </div>
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
