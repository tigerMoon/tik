import React from 'react';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { AvailableWorkspace, WorkbenchTaskResponse } from '../api/client';
import type { WorkbenchLens } from '../view-models/workbench';

interface WorkbenchConsoleHeaderProps {
  packs: EnvironmentPackManifest[];
  activePackId: string | null;
  activeTask: WorkbenchTaskResponse | null;
  activeApiBaseUrl: string;
  workspaces: AvailableWorkspace[];
  waitingCount: number;
  highRiskCount: number;
  selectedLens: WorkbenchLens;
  bootstrapping?: boolean;
  refreshing?: boolean;
  liveStatus?: 'live' | 'connecting' | 'offline' | 'idle';
  publishingReviewRound?: boolean;
  onToggleFilter: () => void;
  onNewTask: () => void;
  onSelectWorkspace?: (apiBaseUrl: string) => void;
  onOpenWorkspace?: (apiBaseUrl: string) => void;
  onPublishReviewRound?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
}

export function WorkbenchConsoleHeader({
  packs,
  activePackId,
  activeTask,
  activeApiBaseUrl,
  workspaces,
  waitingCount,
  highRiskCount,
  selectedLens,
  bootstrapping = false,
  refreshing = false,
  liveStatus = 'idle',
  publishingReviewRound = false,
  onToggleFilter,
  onNewTask,
  onSelectWorkspace,
  onOpenWorkspace,
  onPublishReviewRound,
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
    : selectedLens === 'active'
    ? 'Active'
    : selectedLens === 'review-loop'
      ? 'Review loop'
    : selectedLens === 'completed'
      ? 'Completed'
      : selectedLens === 'archived'
        ? 'Archived'
        : selectedLens === 'today'
          ? 'Today'
          : selectedLens === 'backlog'
            ? 'Backlog'
            : 'Tasks';
  const activeWorkspace = workspaces.find((workspace) => workspace.apiBaseUrl === activeApiBaseUrl)
    || workspaces[0]
    || null;

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
        <div className="workspace-switcher">
          <label className="workspace-switcher-label" htmlFor="workspace-switcher-select">
            Workspace
          </label>
          <select
            id="workspace-switcher-select"
            className="workspace-switcher-select"
            value={activeWorkspace?.apiBaseUrl || activeApiBaseUrl}
            onChange={(event) => onSelectWorkspace?.(event.target.value)}
          >
            {workspaces.length === 0 ? (
              <option value={activeApiBaseUrl}>Current workspace</option>
            ) : workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.apiBaseUrl}>
                {workspace.workspaceName}
              </option>
            ))}
          </select>
          {activeWorkspace ? (
            <span className="workspace-switcher-path">{activeWorkspace.workspaceRoot}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="console-ghost-button"
          onClick={() => onOpenWorkspace?.(activeWorkspace?.apiBaseUrl || activeApiBaseUrl)}
        >
          Open
        </button>
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
          disabled={publishingReviewRound}
          onClick={() => {
            void onPublishReviewRound?.();
          }}
        >
          {publishingReviewRound ? 'Publishing' : 'Publish review'}
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
