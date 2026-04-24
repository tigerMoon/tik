import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';

interface WorkbenchConsoleHeaderProps {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  activeTask: WorkbenchTaskResponse | null;
  waitingCount: number;
  highRiskCount: number;
  selectedLens: WorkbenchLens;
  bootstrapping?: boolean;
  refreshing?: boolean;
  liveStatus?: 'live' | 'connecting' | 'offline' | 'idle';
  onToggleFilter: () => void;
  onNewTask: () => void;
  onRefresh?: () => Promise<void>;
}

export function WorkbenchConsoleHeader({
  packs,
  activePackId,
  activeTask,
  waitingCount,
  highRiskCount,
  selectedLens,
  bootstrapping = false,
  refreshing = false,
  liveStatus = 'idle',
  onToggleFilter,
  onNewTask,
  onRefresh,
}: WorkbenchConsoleHeaderProps) {
  const activePack = activeTask?.environmentPackSnapshot
    ? packs.find((pack) => pack.id === activeTask.environmentPackSnapshot?.id) || null
    : packs.find((pack) => pack.id === activePackId) || null;
  const liveLabel = liveStatus === 'live'
    ? 'Live'
    : liveStatus === 'connecting'
      ? 'Connecting'
      : liveStatus === 'offline'
        ? 'Offline'
        : 'Idle';
  const laneLabel = selectedLens === 'inbox'
    ? 'Inbox'
    : selectedLens === 'completed'
      ? 'Completed'
      : selectedLens === 'archived'
        ? 'Archived'
        : selectedLens === 'today'
          ? 'Today'
          : 'Tasks';

  return (
    <header className="console-topbar">
      <div className="console-topbar-left">
        <div className="console-topbar-title-wrap">
          <h1 className="console-topbar-title">{laneLabel}</h1>
          <div className="console-topbar-chips">
            {activePack ? (
              <span className="console-chip">{activePack.id}</span>
            ) : null}
            {bootstrapping ? (
              <span className="console-chip">
                <span className="console-chip-dot is-blue" />
                Syncing queue
              </span>
            ) : (
              <>
                <span className="console-chip">
                  <span className="console-chip-dot is-blue" />
                  {waitingCount} waiting
                </span>
                <span className="console-chip">
                  <span className="console-chip-dot is-red" />
                  {highRiskCount} high risk
                </span>
              </>
            )}
            <span className="console-chip">
              <span className={`console-chip-dot is-${liveStatus}`} />
              Feed {liveLabel}
            </span>
          </div>
        </div>
        <div className="console-topbar-context">
          {bootstrapping && !activeTask
            ? `Restoring single-workspace operator console${activePack ? ` · ${activePack.id}` : ''}`
            : activeTask
            ? `Decision-ready surface for ${activeTask.id.slice(0, 8).toUpperCase()}`
            : `Single-workspace operator console${activePack ? ` · ${activePack.id}` : ''}`}
        </div>
      </div>

      <div className="console-topbar-actions">
        <button
          type="button"
          className="console-ghost-button"
          onClick={onToggleFilter}
        >
          Filter
        </button>
        <button
          type="button"
          className="console-primary-button"
          onClick={onNewTask}
        >
          New task
        </button>
        <button
          type="button"
          className="console-ghost-button"
          aria-label="Sync workbench state"
          onClick={() => {
            void onRefresh?.();
          }}
          disabled={refreshing}
        >
          {refreshing ? 'Syncing' : 'Sync'}
        </button>
      </div>
    </header>
  );
}
