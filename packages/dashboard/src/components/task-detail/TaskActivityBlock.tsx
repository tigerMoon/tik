import React, { useEffect, useMemo, useRef } from 'react';
import type { WorkbenchTaskResponse, WorkbenchTimelineResponseItem } from '../../api/client';
import { buildWorkbenchLiveRunEntries } from '../../view-models/workbench';

interface TaskActivityBlockProps {
  task: WorkbenchTaskResponse;
  timeline: WorkbenchTimelineResponseItem[];
}

export function TaskActivityBlock({ task, timeline }: TaskActivityBlockProps) {
  const liveRunEntries = useMemo(() => buildWorkbenchLiveRunEntries(timeline, { limit: 16 }), [timeline]);
  const liveRunScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = liveRunScrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [liveRunEntries.length, task.id]);

  const headline = task.activeSessionId
    ? `run-${task.activeSessionId.slice(0, 8)}`
    : task.attempts && task.attempts.length > 0
      ? `attempt #${task.attempts.at(-1)!.attemptNumber}`
      : 'No active run';

  return (
    <section className="task-detail-activity">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Activity</span>
        <span className="task-detail-block-meta">{headline}</span>
      </div>

      <div className="task-detail-activity-stream live-run-terminal" ref={liveRunScrollRef}>
        {liveRunEntries.length === 0 ? (
          <div className="live-run-empty">
            No runtime output yet. As the supervisor plans, calls tools, or pauses for review, the latest lines stream here.
          </div>
        ) : (
          liveRunEntries.map((entry) => (
            <div key={entry.id} className={`live-run-row tone-${entry.tone}`}>
              <div className="live-run-row-meta">
                <span>{formatLogTimestamp(entry.createdAt)}</span>
                <span className="live-run-row-label">{entry.label}</span>
              </div>
              <div className="live-run-row-text">{entry.text}</div>
              {entry.detail ? (
                <div className="live-run-row-detail">{entry.detail}</div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function formatLogTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
