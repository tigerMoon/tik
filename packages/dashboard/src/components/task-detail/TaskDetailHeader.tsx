import React from 'react';
import type { WorkbenchTaskResponse } from '../../api/client';
import { buildWorkbenchAgentLoopSummary } from '../../view-models/workbench';

interface TaskDetailHeaderProps {
  task: WorkbenchTaskResponse;
}

export function TaskDetailHeader({ task }: TaskDetailHeaderProps) {
  const identifier = task.identifier || task.shortIdentifier || task.id.slice(0, 8).toUpperCase();
  const lastActivity = task.lastProgressAt || task.updatedAt;
  const agentLoopSummary = buildWorkbenchAgentLoopSummary(task.agentLoop);
  const meta: string[] = [];
  if (agentLoopSummary) {
    meta.push(agentLoopSummary.label);
    meta.push(agentLoopSummary.shortHeadSha);
  }
  if (task.parentTaskId) {
    meta.push(`parent ${task.parentTaskId.slice(0, 8)}`);
  }
  if ((task.blockedByTaskIds || []).length > 0) {
    meta.push(`${task.blockedByTaskIds!.length} blocker${task.blockedByTaskIds!.length === 1 ? '' : 's'}`);
  }
  if (lastActivity) {
    meta.push(formatRelative(lastActivity));
  }

  return (
    <header className="task-detail-header">
      <div className="task-detail-header-top">
        <span className="task-detail-header-identifier">{identifier}</span>
        <h1 className="task-detail-header-title">{task.title}</h1>
      </div>
      {meta.length > 0 ? (
        <div className="task-detail-header-meta">{meta.join(' · ')}</div>
      ) : null}
    </header>
  );
}

function formatRelative(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `updated ${days}d ago`;
  return `updated ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
