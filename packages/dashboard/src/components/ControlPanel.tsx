/**
 * Control Panel Component
 *
 * Human-in-the-loop controls: pause, resume, stop, inject constraint, change strategy.
 */

import React, { useState } from 'react';

interface Props {
  taskId: string | null;
  onControl: (taskId: string, command: unknown) => void;
}

export function ControlPanel({ taskId, onControl }: Props) {
  const [constraint, setConstraint] = useState('');
  const [strategy, setStrategy] = useState('incremental');

  if (!taskId) {
    return (
      <div style={{ padding: '16px', color: '#666', fontSize: '12px' }}>
        Select a task to control.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' }}>
      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <ControlButton label="⏸ Pause" color="#ffd43b" onClick={() => onControl(taskId, { type: 'pause' })} />
        <ControlButton label="▶ Resume" color="#51cf66" onClick={() => onControl(taskId, { type: 'resume' })} />
        <ControlButton label="⏹ Stop" color="#ff6b6b" onClick={() => onControl(taskId, { type: 'stop' })} />
      </div>

      {/* Strategy selector */}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          style={{
            flex: 1, padding: '6px 8px', background: '#1a1a1a',
            border: '1px solid #333', borderRadius: '4px', color: '#e0e0e0', fontSize: '11px',
          }}
        >
          <option value="incremental">Incremental</option>
          <option value="aggressive">Aggressive</option>
          <option value="defensive">Defensive</option>
        </select>
        <ControlButton
          label="Apply"
          color="#74c0fc"
          onClick={() => onControl(taskId, { type: 'change_strategy', strategy })}
        />
      </div>

      {/* Constraint injection */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          type="text"
          value={constraint}
          onChange={(e) => setConstraint(e.target.value)}
          placeholder="Inject constraint..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && constraint.trim()) {
              onControl(taskId, { type: 'inject_constraint', constraint: constraint.trim() });
              setConstraint('');
            }
          }}
          style={{
            flex: 1, padding: '6px 8px', background: '#1a1a1a',
            border: '1px solid #333', borderRadius: '4px', color: '#e0e0e0', fontSize: '11px',
          }}
        />
        <ControlButton
          label="Inject"
          color="#da77f2"
          onClick={() => {
            if (constraint.trim()) {
              onControl(taskId, { type: 'inject_constraint', constraint: constraint.trim() });
              setConstraint('');
            }
          }}
        />
      </div>
    </div>
  );
}

function ControlButton({ label, color, onClick }: { label: string; color: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 10px', background: `${color}22`, border: `1px solid ${color}44`,
        borderRadius: '4px', color, fontSize: '11px', cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
