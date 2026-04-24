import React, { useEffect, useMemo, useState } from 'react';
import type {
  WorkbenchDecisionResponse,
  WorkbenchTaskResponse,
  WorkbenchTimelineResponseItem,
} from '../api/client';
import {
  buildTimelineFeedMetrics,
  buildTimelineGroups,
  filterStaleTimelineGroupsForTask,
  filterTimelineGroupsByLens,
  getDefaultWorkbenchFeedLens,
  type WorkbenchFeedLens,
  type WorkbenchTimelineNode,
} from '../view-models/workbench';
import { DecisionCard } from './DecisionCard';
import { EvidencePanel } from './EvidencePanel';

interface WorkbenchTimelineProps {
  task: WorkbenchTaskResponse | null;
  items: WorkbenchTimelineResponseItem[];
  decisions: WorkbenchDecisionResponse[];
  resolvingDecisionId?: string | null;
  onResolveDecision?: (
    taskId: string,
    decisionId: string,
    body: { optionId?: string; message?: string },
  ) => Promise<void>;
}

export function WorkbenchTimeline({
  task,
  items,
  decisions,
  resolvingDecisionId,
  onResolveDecision,
}: WorkbenchTimelineProps) {
  const [feedLens, setFeedLens] = useState<WorkbenchFeedLens>('all');
  const [feedPinned, setFeedPinned] = useState(false);
  const decisionMap = useMemo(() => new Map(decisions.map((decision) => [decision.id, decision])), [decisions]);
  const groups = useMemo(() => {
    const decisionItems: WorkbenchTimelineNode[] = decisions.map((decision) => ({
      id: `decision-${decision.id}`,
      kind: 'decision',
      actor: 'supervisor',
      body: decision.summary,
      createdAt: decision.updatedAt || decision.createdAt,
      decisionId: decision.id,
    }));

    const merged = [...items, ...decisionItems].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return filterStaleTimelineGroupsForTask(
      buildTimelineGroups(merged),
      task?.status,
    ).slice().reverse();
  }, [decisions, items, task?.status]);
  const feedMetrics = useMemo(() => buildTimelineFeedMetrics(groups), [groups]);
  const visibleGroups = useMemo(() => filterTimelineGroupsByLens(groups, feedLens), [feedLens, groups]);

  useEffect(() => {
    setFeedPinned(false);
  }, [task?.id]);

  useEffect(() => {
    if (feedPinned) {
      return;
    }

    setFeedLens(getDefaultWorkbenchFeedLens(groups, {
      taskStatus: task?.status || null,
      hasPendingDecision: decisions.length > 0,
    }));
  }, [decisions.length, feedPinned, groups, task?.status]);

  const feedOptions: Array<{ lens: WorkbenchFeedLens; label: string; count: number }> = [
    { lens: 'all', label: 'All', count: feedMetrics.allCount },
    { lens: 'operator', label: 'Operator', count: feedMetrics.operatorCount },
    { lens: 'agents', label: 'Agents', count: feedMetrics.agentCount },
    { lens: 'evidence', label: 'Evidence', count: feedMetrics.evidenceCount },
    { lens: 'decisions', label: 'Decisions', count: feedMetrics.decisionCount },
  ];

  return (
    <div className="console-conversation">
      <div className="console-conversation-header">
        <div>
          <div className="console-conversation-kicker">Activity Feed</div>
          <div className="console-conversation-title">{task ? task.title : 'No active task'}</div>
        </div>
        <div className="console-conversation-meta">
          {task
            ? `Task ${task.id.slice(0, 8)} · showing ${visibleGroups.length} of ${groups.length} timeline groups`
            : 'Select a task'}
        </div>
      </div>

      <div className="console-conversation-toolbar">
        <div className="console-feed-filter-bar">
          {feedOptions.map((option) => (
            <button
              key={option.lens}
              type="button"
              className={`console-feed-filter ${feedLens === option.lens ? 'is-active' : ''}`}
              onClick={() => {
                setFeedPinned(true);
                setFeedLens(option.lens);
              }}
            >
              {option.label} {option.count}
            </button>
          ))}
        </div>
        <div className="console-conversation-meta">
          {feedLens === 'all'
            ? 'Full operator + agent history'
            : feedLens === 'operator'
              ? 'Only manual steering and revert actions'
              : feedLens === 'agents'
                ? 'Supervisor and specialist execution summaries for the active pass'
                : feedLens === 'evidence'
                  ? 'Reviewable artifacts, file changes, and raw evidence'
                  : 'Only pending or recorded decision cards that need operator attention'}
        </div>
      </div>

      <div className="console-message-scroll">
        {groups.length === 0 ? (
          <div className="console-conversation-empty">
            No adjustments or execution events yet. Use the task brief editor above to refine the mission and steer the next pass.
          </div>
        ) : visibleGroups.length === 0 ? (
          <div className="console-conversation-empty">
            Nothing matches the current activity filter yet. Switch the feed lens to inspect a different slice of the mission history.
          </div>
        ) : (
          <div className="console-message-stack">
            {visibleGroups.map((group) => {
              const decision = group.summary.decisionId ? decisionMap.get(group.summary.decisionId) : undefined;

              return (
                <section
                  key={group.summary.id}
                  className={`console-message-card actor-${group.summary.kind === 'decision' ? 'decision' : group.summary.actor}`}
                >
                  {group.summary.kind === 'decision' && decision ? (
                    <DecisionCard
                      decision={decision}
                      resolving={resolvingDecisionId === decision.id}
                      onResolve={task && onResolveDecision
                        ? async (body) => onResolveDecision(task.id, decision.id, body)
                        : undefined}
                    />
                  ) : (
                    <div className="console-message-body">
                      <div className="console-message-label">{actorLabel(group.summary.actor)}</div>
                      <div className="console-message-text">{group.summary.body}</div>
                    </div>
                  )}
                  <EvidencePanel items={group.rawItems} />
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function actorLabel(actor: WorkbenchTimelineResponseItem['actor']): string {
  switch (actor) {
    case 'system':
      return 'System';
    case 'coder':
      return 'Agent: Coder';
    case 'researcher':
      return 'Agent: Researcher';
    case 'reviewer':
      return 'Agent: Reviewer';
    case 'user':
      return 'Operator adjustment';
    default:
      return 'Agent: Supervisor';
  }
}
