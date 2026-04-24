import React from 'react';
import { buildWorkbenchArtifactPreviewUrl } from '../api/client';
import type { WorkbenchTimelineResponseItem } from '../api/client';
import { parseWorkbenchEvidence } from '../view-models/workbench';

export function EvidencePanel({ items }: { items: WorkbenchTimelineResponseItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div style={{ borderTop: '1px solid rgba(148, 163, 184, 0.12)', background: 'rgba(2, 6, 23, 0.6)', padding: '12px 14px' }}>
      <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7dd3fc' }}>
        Evidence
      </div>
      <div style={{ marginTop: '10px', display: 'grid', gap: '10px' }}>
        {items.map((item) => (
          <EvidenceCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function EvidenceCard({ item }: { item: WorkbenchTimelineResponseItem }) {
  const parsed = parseWorkbenchEvidence(item);

  return (
    <div
      style={{
        borderRadius: '14px',
        background: 'rgba(15, 23, 42, 0.78)',
        border: '1px solid rgba(148, 163, 184, 0.14)',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '11px', color: '#64748b' }}>
          {item.actor}{parsed.toolName ? ` · ${parsed.toolName}` : ''}
        </div>
        {parsed.previewableArtifacts.map((filePath) => (
          <a
            key={filePath}
            href={buildWorkbenchArtifactPreviewUrl(filePath)}
            target="_blank"
            rel="noreferrer"
            style={{
              borderRadius: '999px',
              padding: '6px 10px',
              background: 'rgba(34, 211, 238, 0.12)',
              color: '#67e8f9',
              fontSize: '11px',
              textDecoration: 'none',
              fontWeight: 700,
            }}
          >
            Preview artifact
          </a>
        ))}
      </div>
      {parsed.filesModified.length > 0 ? (
        <div style={{ marginTop: '8px', display: 'grid', gap: '6px' }}>
          {parsed.filesModified.map((filePath) => (
            <div
              key={filePath}
              style={{
                borderRadius: '8px',
                background: 'rgba(2, 6, 23, 0.72)',
                border: '1px solid rgba(148, 163, 184, 0.14)',
                padding: '8px 10px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '12px',
                color: '#bfdbfe',
                wordBreak: 'break-word',
              }}
            >
              {filePath}
            </div>
          ))}
        </div>
      ) : null}
      <pre
        style={{
          margin: '8px 0 0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          color: '#cbd5e1',
        }}
      >
        {parsed.output || parsed.error || item.body}
      </pre>
    </div>
  );
}
