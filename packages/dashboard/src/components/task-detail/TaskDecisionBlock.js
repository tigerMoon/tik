import React, { useState } from 'react';
export function TaskDecisionBlock({ task, decision, resolvingDecisionId, onResolveDecision, }) {
    const [error, setError] = useState(null);
    if (!decision) {
        return null;
    }
    const resolving = resolvingDecisionId === decision.id;
    const recommendedId = decision.recommendedOptionId;
    return (<section className="task-detail-decision">
      <div className="task-detail-decision-head">
        <span className={`task-detail-decision-risk tone-${decision.risk === 'high' ? 'red' : decision.risk === 'medium' ? 'yellow' : 'neutral'}`}>
          Risk · {decision.risk}
        </span>
        <strong className="task-detail-decision-title">{decision.title}</strong>
      </div>
      {decision.summary ? (<p className="task-detail-decision-summary">{decision.summary}</p>) : null}
      <div className="task-detail-decision-options">
        {decision.options.map((option) => {
            const recommended = option.id === recommendedId;
            return (<button key={option.id} type="button" className={recommended ? 'task-launch-button' : 'console-secondary-button'} disabled={resolving || !onResolveDecision} title={option.description} onClick={async () => {
                    if (!onResolveDecision) {
                        return;
                    }
                    setError(null);
                    try {
                        await onResolveDecision(task.id, decision.id, { optionId: option.id });
                    }
                    catch (err) {
                        setError(err.message || 'Unable to resolve this decision.');
                    }
                }}>
              {resolving ? 'Applying…' : option.label}
              {recommended ? <span className="task-detail-decision-recommended" aria-hidden> · recommended</span> : null}
            </button>);
        })}
      </div>
      {error ? <div className="task-detail-decision-error">{error}</div> : null}
    </section>);
}
//# sourceMappingURL=TaskDecisionBlock.js.map