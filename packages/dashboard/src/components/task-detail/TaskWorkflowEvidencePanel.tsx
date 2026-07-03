import React, { useMemo } from 'react';
import type { MultiAgentWorkflowBundle } from '../../api/client';
import {
  buildTaskWorkflowPanelModel,
  type TaskWorkflowRow,
} from '../../view-models/workbench';

interface TaskWorkflowEvidencePanelProps {
  bundle: MultiAgentWorkflowBundle | null;
}

export function TaskWorkflowEvidencePanel({ bundle }: TaskWorkflowEvidencePanelProps) {
  const model = useMemo(() => buildTaskWorkflowPanelModel(bundle), [bundle]);

  if (!model) {
    return null;
  }

  return (
    <section className="task-detail-workflow">
      <div className="task-detail-block-head">
        <span className="task-detail-block-label">Workflow evidence</span>
        <span className="task-detail-block-meta">{model.workflowId} · {model.statusLabel}</span>
      </div>

      <div className="task-detail-workflow-summary">
        <div>
          <strong>{model.title}</strong>
          <span>{model.refLabel} · head {model.headLabel || 'unknown'}</span>
        </div>
        <div>
          <span>root {model.rootTaskLabel}</span>
          <span>last decision {model.lastDecisionLabel}</span>
        </div>
      </div>

      <div className="task-detail-acceptance-metrics task-detail-workflow-metrics">
        {model.metrics.map((metric) => (
          <div key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      {model.hasDetails ? (
        <div className="task-detail-workflow-grid">
          <WorkflowSection title="Plan" rows={model.plan} emptyLabel="No task graph recorded." />
          <WorkflowSection title="Contracts" rows={model.contracts} emptyLabel="No sprint contracts recorded." />
          <WorkflowSection title="Subtasks" rows={model.subtasks} emptyLabel="No subtasks recorded." />
          <WorkflowSection title="Evidence" rows={model.evidence} emptyLabel="No evidence recorded." />
          <WorkflowSection title="Decisions" rows={model.decisions} emptyLabel="No decisions recorded." />
          <WorkflowSection title="Runtime" rows={model.runtime} emptyLabel="No evaluator, questioner, or invocation records." />
        </div>
      ) : (
        <div className="task-detail-workflow-empty">Workflow exists, but no evidence has been recorded yet.</div>
      )}
    </section>
  );
}

function WorkflowSection({ title, rows, emptyLabel }: { title: string; rows: TaskWorkflowRow[]; emptyLabel: string }) {
  return (
    <div className="task-detail-workflow-section">
      <div className="task-detail-block-meta">{title}</div>
      {rows.length > 0 ? (
        <div className="task-detail-acceptance-list">
          {rows.map((row) => (
            <div key={row.id} className={`task-detail-acceptance-list-row workflow-row tone-${row.tone || 'neutral'}`}>
              <strong>{row.title}</strong>
              <span>{row.detail}</span>
              {row.meta ? <em>{row.meta}</em> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="task-detail-workflow-empty">{emptyLabel}</div>
      )}
    </div>
  );
}
