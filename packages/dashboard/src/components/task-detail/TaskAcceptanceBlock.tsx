import React, { useMemo, useState } from 'react';
import {
  buildWorkbenchArtifactPreviewUrl,
  type WorkbenchDecisionResponse,
  type WorkbenchTaskResponse,
  type WorkbenchTimelineResponseItem,
} from '../../api/client';
import {
  buildWorkbenchAcceptanceSummary,
  buildWorkbenchEvidenceDigest,
} from '../../view-models/workbench';

interface TaskAcceptanceBlockProps {
  task: WorkbenchTaskResponse;
  timeline: WorkbenchTimelineResponseItem[];
  decisions: WorkbenchDecisionResponse[];
}

export function TaskAcceptanceBlock({ task, timeline, decisions }: TaskAcceptanceBlockProps) {
  const rawItems = useMemo(() => timeline.filter((item) => item.kind === 'raw'), [timeline]);
  const evidenceDigest = useMemo(() => buildWorkbenchEvidenceDigest(rawItems), [rawItems]);
  const acceptanceSummary = useMemo(
    () => buildWorkbenchAcceptanceSummary(task.status, evidenceDigest, decisions.length),
    [decisions.length, evidenceDigest, task.status],
  );

  const showByStatus = task.status === 'completed' || task.status === 'in_review' || task.status === 'verifying';
  const hasArtifact = evidenceDigest.artifactCount > 0;
  const hasFileOutput = evidenceDigest.modifiedFileCount > 0;
  const shouldRender = showByStatus || hasArtifact || hasFileOutput;
  const defaultExpanded = task.status === 'completed' || task.status === 'in_review' || hasArtifact;
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!shouldRender) {
    return null;
  }

  const primaryArtifact = evidenceDigest.previewableArtifacts[0] || null;
  const primaryArtifactPreviewUrl = primaryArtifact
    ? buildWorkbenchArtifactPreviewUrl(primaryArtifact.path)
    : null;

  return (
    <section className="task-detail-acceptance">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Acceptance</span>
        <button
          type="button"
          className="task-detail-block-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <div className={`task-detail-acceptance-summary tone-${acceptanceSummary.tone}`}>
        <strong>{acceptanceSummary.headline}</strong>
        <span>{acceptanceSummary.detail}</span>
      </div>

      {expanded ? (
        <>
          {primaryArtifact && primaryArtifactPreviewUrl ? (
            <div className="task-detail-acceptance-preview">
              <div className="task-detail-acceptance-preview-head">
                <div>
                  <div className="task-detail-block-meta">Interactive preview</div>
                  <strong>{formatArtifactLabel(primaryArtifact.path)}</strong>
                </div>
                <a
                  href={primaryArtifactPreviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="task-detail-link-button"
                >
                  Open full preview
                </a>
              </div>
              <iframe
                key={primaryArtifact.path}
                className="task-detail-acceptance-frame"
                src={primaryArtifactPreviewUrl}
                title={`Artifact preview: ${formatArtifactLabel(primaryArtifact.path)}`}
                loading="lazy"
              />
            </div>
          ) : null}

          <div className="task-detail-acceptance-metrics">
            <div>
              <span>Artifacts</span>
              <strong>{evidenceDigest.artifactCount}</strong>
            </div>
            <div>
              <span>Files touched</span>
              <strong>{evidenceDigest.modifiedFileCount}</strong>
            </div>
            <div>
              <span>Tool events</span>
              <strong>{evidenceDigest.rawEventCount}</strong>
            </div>
          </div>

          {evidenceDigest.previewableArtifacts.length > 1 ? (
            <div className="task-detail-acceptance-list">
              {evidenceDigest.previewableArtifacts.slice(1, 4).map((artifact) => (
                <a
                  key={artifact.path}
                  href={buildWorkbenchArtifactPreviewUrl(artifact.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="task-detail-acceptance-list-row"
                >
                  <strong>{formatArtifactLabel(artifact.path)}</strong>
                  <span>{artifact.path}</span>
                </a>
              ))}
            </div>
          ) : null}

          {evidenceDigest.modifiedFiles.length > 0 ? (
            <div className="task-detail-acceptance-list">
              {evidenceDigest.modifiedFiles.slice(0, 5).map((filePath) => (
                <div key={filePath} className="task-detail-acceptance-list-row">
                  <span>{filePath}</span>
                </div>
              ))}
            </div>
          ) : null}

          {evidenceDigest.latestDiffExcerpt ? (
            <div className="task-detail-acceptance-diff">
              <div className="task-detail-block-meta">Latest diff</div>
              <pre>{evidenceDigest.latestDiffExcerpt}</pre>
            </div>
          ) : null}

          {evidenceDigest.latestErrorExcerpt || evidenceDigest.latestOutputExcerpt ? (
            <div className="task-detail-acceptance-output">
              <div className="task-detail-block-meta">
                Latest {evidenceDigest.latestErrorExcerpt ? 'error' : 'output'}
                {evidenceDigest.latestToolName ? ` · ${evidenceDigest.latestToolName}` : ''}
              </div>
              <pre>{evidenceDigest.latestErrorExcerpt || evidenceDigest.latestOutputExcerpt}</pre>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function formatArtifactLabel(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || filePath;
}
