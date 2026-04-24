import React, { useEffect, useMemo, useState } from 'react';
import type { WorkbenchDecisionResponse } from '../api/client';

interface DecisionCardProps {
  decision: WorkbenchDecisionResponse;
  resolving?: boolean;
  onResolve?: (body: { optionId?: string; message?: string }) => Promise<void>;
  compact?: boolean;
}

export function DecisionCard({
  decision,
  resolving = false,
  onResolve,
  compact = false,
}: DecisionCardProps) {
  const recommended = useMemo(
    () => decision.options.find((option) => option.id === decision.recommendedOptionId),
    [decision.options, decision.recommendedOptionId],
  );
  const [note, setNote] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setNote('');
    setErrorMessage(null);
  }, [decision.id]);

  const interactive = typeof onResolve === 'function';

  return (
    <div className={`decision-card-shell ${compact ? 'is-compact' : ''}`}>
      <div className="decision-card-header">
        <div className="decision-card-kicker">Decision needed</div>
        <div className={`decision-card-risk risk-${decision.risk}`}>{decision.risk} risk</div>
      </div>

      <div className="decision-card-title">{decision.title}</div>
      <div className="decision-card-summary">{decision.summary}</div>

      {recommended ? (
        <div className="decision-card-recommended">
          Recommended: {recommended.label}
          {recommended.description ? ` - ${recommended.description}` : ''}
        </div>
      ) : null}

      {interactive ? (
        <label className="decision-card-note">
          <span className="task-launch-label">Operator note</span>
          <textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setErrorMessage(null);
            }}
            rows={compact ? 2 : 3}
            className="task-launch-field task-launch-textarea decision-card-note-input"
            placeholder="Optional note for the supervisor"
          />
        </label>
      ) : null}

      <div className="decision-card-options">
        {decision.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`decision-option-button ${option.recommended ? 'is-recommended' : ''}`}
            onClick={async () => {
              if (!onResolve) {
                return;
              }
              try {
                setErrorMessage(null);
                await onResolve({
                  optionId: option.id,
                  message: note.trim() || undefined,
                });
              } catch (error) {
                setErrorMessage((error as Error).message || 'Unable to resolve this decision.');
              }
            }}
            disabled={!interactive || resolving}
          >
            <div className="decision-option-title">
              {option.label}
              {option.recommended ? ' (recommended)' : ''}
            </div>
            {option.description ? (
              <div className="decision-option-description">{option.description}</div>
            ) : null}
            {resolving ? (
              <div className="decision-option-progress">Resolving…</div>
            ) : null}
          </button>
        ))}
      </div>

      {errorMessage ? <div className="decision-card-error">{errorMessage}</div> : null}
    </div>
  );
}
