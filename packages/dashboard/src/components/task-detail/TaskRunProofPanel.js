import React, { useMemo, useState } from 'react';
import { buildWorkbenchArtifactVersionPreviewUrl, } from '../../api/client';
import { buildRunProofPanelModel } from '../../view-models/workbench';
export function TaskRunProofPanel({ task, artifacts, busyArtifactId, onAcceptArtifact, onRejectArtifact, onOpenArtifact, }) {
    const [reason, setReason] = useState('');
    const model = useMemo(() => buildRunProofPanelModel(task.status, artifacts), [artifacts, task.status]);
    if (!model)
        return null;
    const busy = busyArtifactId === model.reviewArtifactId;
    return (<section className="task-run-proof-panel">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Run proof</span>
        <span className={`artifact-status is-${model.statusLabel.toLowerCase().replace(/\s+/g, '_')}`}>
          {model.statusLabel}
        </span>
      </div>

      <div className="task-run-proof-summary">
        <strong>{model.title}</strong>
        <span>{model.summary}</span>
      </div>

      <div className="task-run-proof-links">
        {Object.entries(model.links).map(([key, link]) => link ? (<a key={key} href={buildWorkbenchArtifactVersionPreviewUrl(link.artifactId, link.versionId)} target="_blank" rel="noreferrer">
            {labelForLink(key)}
          </a>) : null)}
      </div>

      <div className="task-detail-acceptance-metrics">
        <div>
          <span>Files changed</span>
          <strong>{model.changedFiles.length}</strong>
        </div>
        <div>
          <span>Validation refs</span>
          <strong>{model.validationRefs.length}</strong>
        </div>
      </div>

      {model.changedFiles.length ? (<div className="task-detail-acceptance-list">
          {model.changedFiles.slice(0, 5).map((filePath) => (<div key={filePath} className="task-detail-acceptance-list-row">
              <span>{filePath}</span>
            </div>))}
        </div>) : null}

      <div className="task-run-proof-actions">
        <button type="button" className="console-secondary-button" onClick={() => onOpenArtifact?.(model.reviewArtifactId)}>
          Open review
        </button>
        <button type="button" disabled={!model.canDecide || busy || !onAcceptArtifact} onClick={() => void onAcceptArtifact?.(model.reviewArtifactId)}>
          {busy ? 'Accepting...' : 'Accept'}
        </button>
      </div>

      {model.canDecide ? (<label className="task-artifact-reject">
          <span>Reject and retry</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)}/>
          <button type="button" className="task-artifact-request-button" disabled={busy || !reason.trim() || !onRejectArtifact} onClick={() => void onRejectArtifact?.(model.reviewArtifactId, reason)}>
            Send request
          </button>
        </label>) : null}
    </section>);
}
function labelForLink(key) {
    switch (key) {
        case 'diff':
            return 'View patch';
        case 'transcript':
            return 'View transcript';
        case 'validation':
            return 'View validation';
        default:
            return 'View review';
    }
}
//# sourceMappingURL=TaskRunProofPanel.js.map