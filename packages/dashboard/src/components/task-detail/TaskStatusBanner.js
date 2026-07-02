import React from 'react';
export function TaskStatusBanner({ spec, busyActionId, onAction }) {
    if (!spec) {
        return null;
    }
    return (<section className={`task-detail-banner is-${spec.tone}`}>
      <span className="task-detail-banner-icon" aria-hidden>{spec.icon}</span>
      <div className="task-detail-banner-body">
        <strong className="task-detail-banner-headline">{spec.headline}</strong>
        {spec.detail ? (<span className="task-detail-banner-detail">{spec.detail}</span>) : null}
      </div>
      {spec.actions.length > 0 ? (<div className="task-detail-banner-actions">
          {spec.actions.map((action) => {
                const busy = busyActionId === action.id;
                const className = action.kind === 'primary'
                    ? 'task-launch-button'
                    : action.kind === 'danger'
                        ? 'console-danger-button'
                        : 'console-secondary-button';
                return (<button key={action.id} type="button" className={className} disabled={busy || !onAction} onClick={() => onAction?.(action)}>
                {busy ? 'Working…' : action.label}
              </button>);
            })}
        </div>) : null}
    </section>);
}
//# sourceMappingURL=TaskStatusBanner.js.map