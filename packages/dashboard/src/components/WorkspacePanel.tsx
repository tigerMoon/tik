import React from 'react';
import type { WorkspaceDecision, WorkspaceManagedWorktree, WorkspaceStatusResponse } from '../api/client';

interface WorkspacePanelProps {
  workspaceRoot: string;
  onWorkspaceRootChange: (value: string) => void;
  onRefresh: () => void;
  status: WorkspaceStatusResponse | null;
  pendingDecisions: WorkspaceDecision[];
  resolutionDrafts: Record<string, string>;
  onResolutionDraftChange: (decisionId: string, value: string) => void;
  onResolve: (decisionId: string, optionId?: string, message?: string) => Promise<void>;
  busyDecisionId?: string | null;
  worktreeLaneDrafts: Record<string, string>;
  onWorktreeLaneDraftChange: (projectKey: string, value: string) => void;
  onCreateWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string) => Promise<void>;
  onUseWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string, force?: boolean) => Promise<void>;
  onRemoveWorktree: (projectName: string, sourceProjectPath?: string, laneId?: string, force?: boolean) => Promise<void>;
  busyWorktreeKey?: string | null;
  loading: boolean;
  error?: string | null;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const {
    workspaceRoot,
    onWorkspaceRootChange,
    onRefresh,
    status,
    pendingDecisions,
    resolutionDrafts,
    onResolutionDraftChange,
    onResolve,
    busyDecisionId,
    worktreeLaneDrafts,
    onWorktreeLaneDraftChange,
    onCreateWorktree,
    onUseWorktree,
    onRemoveWorktree,
    busyWorktreeKey,
    loading,
    error,
  } = props;

  const worktreeGroups = React.useMemo(() => {
    const map = new Map<string, WorkspaceManagedWorktree[]>();
    for (const entry of status?.worktrees?.entries || []) {
      const key = entry.sourceProjectPath || entry.projectName;
      const list = map.get(key) || [];
      list.push(entry);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [status?.worktrees?.entries]);

  return (
    <div style={{ borderBottom: '1px solid #222', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>Workspace Decisions</div>
          <div style={{ fontSize: '11px', color: '#888' }}>
            Phase: {status?.state?.currentPhase || 'N/A'} · Pending: {pendingDecisions.length}
          </div>
        </div>
        <button
          onClick={onRefresh}
          style={{ background: '#1f6feb', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer' }}
        >
          Refresh
        </button>
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', color: '#888' }}>
        Workspace Root
        <input
          value={workspaceRoot}
          onChange={(event) => onWorkspaceRootChange(event.target.value)}
          placeholder="Optional rootPath override"
          style={{
            background: '#111',
            color: '#e0e0e0',
            border: '1px solid #333',
            borderRadius: '6px',
            padding: '8px 10px',
          }}
        />
      </label>

      {loading && <div style={{ fontSize: '11px', color: '#888' }}>Loading workspace status…</div>}
      {error && <div style={{ fontSize: '11px', color: '#ff8787' }}>{error}</div>}

      {status?.settings?.workspaceName && (
        <div style={{ fontSize: '11px', color: '#888', lineHeight: 1.5 }}>
          <div>Workspace: {status.settings.workspaceName}</div>
          <div>Profile: {status.settings.workflowPolicy?.profile || 'balanced'}</div>
          <div>Worktrees: {status.worktrees?.mode || 'managed'} / non-git={status.worktrees?.nonGitStrategy || 'source'}</div>
          <div>Demand: {status.state?.demand || 'N/A'}</div>
        </div>
      )}

      {worktreeGroups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700 }}>Worktree Lanes</div>
          {worktreeGroups.map(([projectKey, entries]) => {
            const projectName = entries[0]?.projectName || projectKey;
            const sourceProjectPath = entries[0]?.sourceProjectPath;
            const draftKey = sourceProjectPath || projectKey;
            return (
            <div
              key={projectKey}
              style={{
                background: '#111',
                border: '1px solid #333',
                borderRadius: '8px',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 700 }}>{projectName}</div>
              {sourceProjectPath ? (
                <div style={{ fontSize: '10px', color: '#888' }}>{sourceProjectPath}</div>
              ) : null}
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  value={worktreeLaneDrafts[draftKey] || ''}
                  onChange={(event) => onWorktreeLaneDraftChange(draftKey, event.target.value)}
                  placeholder="lane id (default: primary)"
                  style={{
                    flex: 1,
                    background: '#0d1117',
                    color: '#e0e0e0',
                    border: '1px solid #333',
                    borderRadius: '6px',
                    padding: '6px 8px',
                  }}
                />
                <button
                  onClick={() => onCreateWorktree(projectName, sourceProjectPath, worktreeLaneDrafts[draftKey] || 'primary')}
                  disabled={busyWorktreeKey === `${draftKey}:${(worktreeLaneDrafts[draftKey] || 'primary').trim() || 'primary'}:create`}
                  style={{
                    background: '#1f6feb',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Create lane
                </button>
              </div>
              {entries.map((entry) => (
                <div
                  key={`${entry.sourceProjectPath}:${entry.laneId || 'primary'}`}
                  style={{
                    border: '1px solid #222',
                    borderRadius: '6px',
                    padding: '8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700 }}>
                      {(entry.laneId || 'primary')}
                      {entry.active ? ' *' : ''}
                      {' · '}
                      {entry.kind}
                      {' · '}
                      {entry.worktree?.status || 'disabled'}
                    </div>
                    <div style={{ fontSize: '10px', color: '#888' }}>
                      {entry.projectPhase || 'n/a'} / {entry.projectStatus || 'n/a'}
                    </div>
                  </div>
                  <div style={{ fontSize: '10px', color: '#888' }}>
                    exec: {entry.effectiveProjectPath}
                  </div>
                  {typeof entry.dirtyFileCount === 'number' && (
                    <div style={{ fontSize: '10px', color: entry.dirtyFileCount > 0 ? '#ffd43b' : '#888' }}>
                      dirty files: {entry.dirtyFileCount}
                    </div>
                  )}
                  {entry.warnings?.length ? (
                    <div style={{ fontSize: '10px', color: '#ffb366', lineHeight: 1.5 }}>
                      {entry.warnings.join(' | ')}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => onUseWorktree(entry.projectName, entry.sourceProjectPath, entry.laneId, false)}
                      disabled={entry.active || !entry.safeToActivate || busyWorktreeKey === `${entry.sourceProjectPath || entry.projectName}:${entry.laneId || 'primary'}:use`}
                      style={{
                        background: entry.safeToActivate ? '#0d1117' : '#1a1a1a',
                        color: '#e0e0e0',
                        border: '1px solid #333',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        cursor: entry.safeToActivate ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Use
                    </button>
                    {!entry.safeToActivate && !entry.active && (
                      <button
                        onClick={() => onUseWorktree(entry.projectName, entry.sourceProjectPath, entry.laneId, true)}
                        disabled={busyWorktreeKey === `${entry.sourceProjectPath || entry.projectName}:${entry.laneId || 'primary'}:use`}
                        style={{
                          background: '#3b2f0b',
                          color: '#fff',
                          border: '1px solid #6b560e',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        Force use
                      </button>
                    )}
                    <button
                      onClick={() => onRemoveWorktree(entry.projectName, entry.sourceProjectPath, entry.laneId, false)}
                      disabled={!entry.safeToRemove || busyWorktreeKey === `${entry.sourceProjectPath || entry.projectName}:${entry.laneId || 'primary'}:remove`}
                      style={{
                        background: '#2a1215',
                        color: '#ff8787',
                        border: '1px solid #5c1f24',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        cursor: entry.safeToRemove ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Remove
                    </button>
                    {!entry.safeToRemove && (
                      <button
                        onClick={() => onRemoveWorktree(entry.projectName, entry.sourceProjectPath, entry.laneId, true)}
                        disabled={busyWorktreeKey === `${entry.sourceProjectPath || entry.projectName}:${entry.laneId || 'primary'}:remove`}
                        style={{
                          background: '#4a1d1d',
                          color: '#fff',
                          border: '1px solid #7a2d2d',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        Force remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )})}
        </div>
      )}

      {pendingDecisions.length === 0 ? (
        <div style={{ fontSize: '11px', color: '#888' }}>No pending decisions.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {pendingDecisions.map((decision) => {
            const draft = resolutionDrafts[decision.id] || '';
            return (
              <div
                key={decision.id}
                style={{
                  background: '#111',
                  border: '1px solid #333',
                  borderRadius: '8px',
                  padding: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700 }}>{decision.title}</div>
                    <div style={{ fontSize: '11px', color: '#888' }}>
                      {decision.projectName || 'workspace'} · {decision.kind} · {decision.phase}
                    </div>
                  </div>
                  {decision.confidence && (
                    <span style={{ fontSize: '10px', color: '#74c0fc' }}>{decision.confidence}</span>
                  )}
                </div>

                <div style={{ fontSize: '11px', color: '#ddd', lineHeight: 1.5 }}>{decision.prompt}</div>
                {decision.rationale && (
                  <div style={{ fontSize: '11px', color: '#888', lineHeight: 1.5 }}>{decision.rationale}</div>
                )}
                {decision.signals?.length ? (
                  <div style={{ fontSize: '10px', color: '#666' }}>signals: {decision.signals.join(', ')}</div>
                ) : null}

                {decision.options?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {decision.options.map((option) => (
                      <button
                        key={option.id}
                        onClick={() => onResolve(decision.id, option.id, draft || undefined)}
                        disabled={busyDecisionId === decision.id}
                        style={{
                          textAlign: 'left',
                          background: option.recommended ? '#16324f' : '#0d1117',
                          color: '#e0e0e0',
                          border: `1px solid ${option.recommended ? '#1f6feb' : '#333'}`,
                          borderRadius: '6px',
                          padding: '8px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        <div style={{ fontSize: '11px', fontWeight: 700 }}>
                          {option.label}
                          {option.recommended ? ' (recommended)' : ''}
                          {option.nextPhase ? ` -> ${option.nextPhase}` : ''}
                        </div>
                        {option.description && (
                          <div style={{ fontSize: '10px', color: '#888', marginTop: '4px' }}>{option.description}</div>
                        )}
                      </button>
                    ))}
                  </div>
                ) : null}

                {decision.allowFreeform && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <textarea
                      value={draft}
                      onChange={(event) => onResolutionDraftChange(decision.id, event.target.value)}
                      placeholder="Add optional note or clarification"
                      style={{
                        minHeight: '72px',
                        resize: 'vertical',
                        background: '#0d1117',
                        color: '#e0e0e0',
                        border: '1px solid #333',
                        borderRadius: '6px',
                        padding: '8px 10px',
                      }}
                    />
                    {!decision.options?.length && (
                      <button
                        onClick={() => onResolve(decision.id, undefined, draft || undefined)}
                        disabled={busyDecisionId === decision.id}
                        style={{
                          alignSelf: 'flex-start',
                          background: '#1f6feb',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          cursor: 'pointer',
                        }}
                      >
                        Resolve with note
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
