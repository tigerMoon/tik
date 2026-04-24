import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';
import { buildWorkbenchFocusSummary, buildWorkbenchOverview, filterWorkbenchTasksByLens } from '../view-models/workbench';

interface WorkbenchOverviewBarProps {
  tasks: WorkbenchTaskResponse[];
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  activeTask: WorkbenchTaskResponse | null;
  selectedLens: WorkbenchLens;
  onSelectLens: (lens: WorkbenchLens) => void;
}

export function WorkbenchOverviewBar({
  tasks,
  packs,
  activePackId,
  activeTask,
  selectedLens,
  onSelectLens,
}: WorkbenchOverviewBarProps) {
  const metrics = buildWorkbenchOverview(tasks);
  const focus = buildWorkbenchFocusSummary(tasks);
  const activePack = packs.find((pack) => pack.id === activePackId) || null;
  const todayCount = filterWorkbenchTasksByLens(tasks, 'today').length;

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        borderBottom: '1px solid #1e293b',
        background: 'linear-gradient(180deg, rgba(2,6,23,0.98), rgba(8,17,32,0.96))',
        backdropFilter: 'blur(18px)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: '16px',
          padding: '18px 20px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '12px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#67e8f9' }}>
              Single Workspace Control Plane
            </div>
            <div style={{ marginTop: '6px', fontSize: '26px', fontWeight: 800, color: '#f8fafc' }}>
              Agent Workbench
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              flexWrap: 'wrap',
            }}
          >
            <Pill label="Environment" value={activePack ? `${activePack.name} · v${activePack.version}` : 'No pack'} tone="cyan" />
            <Pill label="Focused task" value={activeTask?.title || 'None selected'} tone="slate" />
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 1.25fr) repeat(auto-fit, minmax(140px, 1fr))',
            gap: '12px',
          }}
        >
          <FocusCard
            headline={focus.headline}
            detail={focus.detail}
            selected={selectedLens === focus.lens}
            onClick={() => onSelectLens(focus.lens)}
          />
          <MetricCard label="Inbox" value={metrics.attentionCount} hint="waiting, failed, blocked" tone="rose" active={selectedLens === 'inbox'} onClick={() => onSelectLens('inbox')} />
          <MetricCard label="Today" value={todayCount} hint="touched or active today" tone="cyan" active={selectedLens === 'today'} onClick={() => onSelectLens('today')} />
          <MetricCard label="Completed" value={metrics.completedCount} hint="ready to review or archive" tone="emerald" active={selectedLens === 'completed'} onClick={() => onSelectLens('completed')} />
          <MetricCard label="Archived" value={metrics.archivedCount} hint="hidden from default queue" tone="slate" active={selectedLens === 'archived'} onClick={() => onSelectLens('archived')} />
        </div>
      </div>
    </header>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone,
  active = false,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'rose' | 'cyan' | 'amber' | 'emerald' | 'slate';
  active?: boolean;
  onClick?: () => void;
}) {
  const accent = {
    rose: '#fb7185',
    cyan: '#67e8f9',
    amber: '#fbbf24',
    emerald: '#4ade80',
    slate: '#cbd5e1',
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        borderRadius: '18px',
        border: active ? `1px solid ${accent}` : '1px solid rgba(51, 65, 85, 0.95)',
        background: active ? 'linear-gradient(180deg, rgba(8,47,73,0.92), rgba(2,6,23,0.88))' : 'linear-gradient(180deg, rgba(15,23,42,0.92), rgba(2,6,23,0.88))',
        padding: '14px 16px',
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.04), 0 10px 30px rgba(2,6,23,0.26)`,
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
      }}
    >
      <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b' }}>
        {label}
      </div>
      <div style={{ marginTop: '8px', fontSize: '28px', fontWeight: 800, color: accent }}>{value}</div>
      <div style={{ marginTop: '6px', fontSize: '12px', color: '#94a3b8' }}>{hint}</div>
    </button>
  );
}

function FocusCard({
  headline,
  detail,
  selected,
  onClick,
}: {
  headline: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        borderRadius: '18px',
        border: selected ? '1px solid #67e8f9' : '1px solid rgba(51, 65, 85, 0.95)',
        background: 'linear-gradient(135deg, rgba(8,47,73,0.96), rgba(15,23,42,0.92))',
        padding: '16px 18px',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: '11px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#67e8f9' }}>
        Focus lane
      </div>
      <div style={{ marginTop: '8px', fontSize: '20px', fontWeight: 800, color: '#f8fafc' }}>
        {headline}
      </div>
      <div style={{ marginTop: '8px', fontSize: '13px', color: '#cbd5e1', lineHeight: 1.55 }}>
        {detail}
      </div>
    </button>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone: 'cyan' | 'slate' }) {
  return (
    <div
      style={{
        minWidth: '160px',
        borderRadius: '999px',
        padding: '8px 12px',
        border: '1px solid #334155',
        background: tone === 'cyan' ? 'rgba(8,47,73,0.9)' : 'rgba(15,23,42,0.92)',
      }}
    >
      <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94a3b8' }}>{label}</div>
      <div style={{ marginTop: '3px', fontSize: '12px', color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}
      </div>
    </div>
  );
}
