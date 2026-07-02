import React, { useMemo, useState } from 'react';
import { buildWorkbenchArtifactLinkPreviewUrl, } from '../../api/client';
import { buildWorkbenchAcceptanceDigest, buildWorkbenchAcceptanceSummary, } from '../../view-models/workbench';
export function TaskAcceptanceBlock({ task, timeline, decisions, artifacts = [] }) {
    const rawItems = useMemo(() => timeline.filter((item) => item.kind === 'raw'), [timeline]);
    const evidenceDigest = useMemo(() => buildWorkbenchAcceptanceDigest(rawItems, artifacts), [artifacts, rawItems]);
    const acceptanceSummary = useMemo(() => buildWorkbenchAcceptanceSummary(task.status, evidenceDigest, decisions.length), [decisions.length, evidenceDigest, task.status]);
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
    const primaryRegistryArtifact = artifacts[0] || null;
    const primaryPreviewUrl = buildWorkbenchArtifactLinkPreviewUrl({
        artifactId: primaryRegistryArtifact?.id || task.evidenceSummary?.latestArtifactId,
        versionId: primaryRegistryArtifact?.latestVersionId || task.evidenceSummary?.latestArtifactVersionId,
        filePath: primaryArtifact?.path,
    });
    const primaryPreviewLabel = primaryRegistryArtifact?.title || (primaryArtifact ? formatArtifactLabel(primaryArtifact.path) : '');
    const previewRows = artifacts.length > 0
        ? artifacts.slice(1, 4).map((artifact) => ({
            key: artifact.id,
            href: buildWorkbenchArtifactLinkPreviewUrl({
                artifactId: artifact.id,
                versionId: artifact.latestVersionId,
            }),
            title: artifact.title,
            detail: `${artifact.kind} · v${artifact.version} · ${artifact.status.replace(/_/g, ' ')}`,
        }))
        : evidenceDigest.previewableArtifacts.slice(1, 4).map((artifact) => ({
            key: artifact.path,
            href: buildWorkbenchArtifactLinkPreviewUrl({ filePath: artifact.path }),
            title: formatArtifactLabel(artifact.path),
            detail: artifact.path,
        }));
    return (<section className="task-detail-acceptance">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Acceptance</span>
        <button type="button" className="task-detail-block-toggle" onClick={() => setExpanded((current) => !current)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      <div className={`task-detail-acceptance-summary tone-${acceptanceSummary.tone}`}>
        <strong>{acceptanceSummary.headline}</strong>
        <span>{acceptanceSummary.detail}</span>
      </div>

      {expanded ? (<>
          {primaryPreviewUrl ? (<div className="task-detail-acceptance-preview">
              <div className="task-detail-acceptance-preview-head">
                <div>
                  <div className="task-detail-block-meta">Interactive preview</div>
                  <strong>{primaryPreviewLabel}</strong>
                </div>
                <a href={primaryPreviewUrl} target="_blank" rel="noreferrer" className="task-detail-link-button">
                  Open full preview
                </a>
              </div>
              <iframe key={primaryPreviewUrl} className="task-detail-acceptance-frame" src={primaryPreviewUrl} title={`Artifact preview: ${primaryPreviewLabel}`} loading="lazy" sandbox="allow-scripts"/>
            </div>) : null}

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

          {previewRows.length > 0 ? (<div className="task-detail-acceptance-list">
              {previewRows.map((artifact) => artifact.href ? (<a key={artifact.key} href={artifact.href} target="_blank" rel="noreferrer" className="task-detail-acceptance-list-row">
                  <strong>{artifact.title}</strong>
                  <span>{artifact.detail}</span>
                </a>) : null)}
            </div>) : null}

          {evidenceDigest.modifiedFiles.length > 0 ? (<div className="task-detail-acceptance-list">
              {evidenceDigest.modifiedFiles.slice(0, 5).map((filePath) => (<div key={filePath} className="task-detail-acceptance-list-row">
                  <span>{filePath}</span>
                </div>))}
            </div>) : null}

          {evidenceDigest.latestDiffExcerpt ? (<div className="task-detail-acceptance-diff">
              <div className="task-detail-block-meta">Latest diff</div>
              <pre>{evidenceDigest.latestDiffExcerpt}</pre>
            </div>) : null}

          {evidenceDigest.latestErrorExcerpt || evidenceDigest.latestOutputExcerpt ? (<div className="task-detail-acceptance-output">
              <div className="task-detail-block-meta">
                Latest {evidenceDigest.latestErrorExcerpt ? 'error' : 'output'}
                {evidenceDigest.latestToolName ? ` · ${evidenceDigest.latestToolName}` : ''}
              </div>
              <pre>{evidenceDigest.latestErrorExcerpt || evidenceDigest.latestOutputExcerpt}</pre>
            </div>) : null}
        </>) : null}
    </section>);
}
function formatArtifactLabel(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() || filePath;
}
//# sourceMappingURL=TaskAcceptanceBlock.js.map