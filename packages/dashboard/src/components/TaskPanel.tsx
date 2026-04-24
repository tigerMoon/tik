/**
 * Task Panel Component
 *
 * Displays task list with status and allows task submission.
 */

import React, { useState } from 'react';
import type { Task } from '../api/client';

const statusColors: Record<string, string> = {
  pending: '#868e96',
  planning: '#74c0fc',
  executing: '#74c0fc',
  evaluating: '#ffd43b',
  converged: '#51cf66',
  failed: '#ff6b6b',
  cancelled: '#868e96',
};

const statusIcons: Record<string, string> = {
  pending: '⏳',
  planning: '📋',
  executing: '⚡',
  evaluating: '📊',
  converged: '🎯',
  failed: '❌',
  cancelled: '⏹',
};

interface Props {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onSubmitTask: (description: string, mode: 'single' | 'multi') => void;
}

export function TaskPanel({ tasks, activeTaskId, onSelectTask, onSubmitTask }: Props) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'single' | 'multi'>('single');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      onSubmitTask(input.trim(), mode);
      setInput('');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h3 style={{ padding: '12px 16px', borderBottom: '1px solid #333', margin: 0, fontSize: '14px' }}>
        Tasks
      </h3>

      {/* Submit form */}
      <form onSubmit={handleSubmit} style={{ padding: '8px 16px', borderBottom: '1px solid #333' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe a task..."
          style={{
            width: '100%',
            padding: '8px 12px',
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '4px',
            color: '#e0e0e0',
            fontSize: '12px',
            outline: 'none',
            marginBottom: '8px',
          }}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#999' }}>
            <input
              type="radio"
              value="single"
              checked={mode === 'single'}
              onChange={(e) => setMode(e.target.value as 'single' | 'multi')}
            />
            Single Agent
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#999' }}>
            <input
              type="radio"
              value="multi"
              checked={mode === 'multi'}
              onChange={(e) => setMode(e.target.value as 'single' | 'multi')}
            />
            Multi Agent
          </label>
        </div>
      </form>

      {/* Task list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tasks.length === 0 && (
          <div style={{ color: '#666', padding: '20px', textAlign: 'center', fontSize: '12px' }}>
            No tasks yet
          </div>
        )}
        {tasks.map((task) => (
          <div
            key={task.id}
            onClick={() => onSelectTask(task.id)}
            style={{
              padding: '10px 16px',
              borderBottom: '1px solid #1a1a1a',
              cursor: 'pointer',
              background: task.id === activeTaskId ? '#1a1a2e' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>{statusIcons[task.status] || '📌'}</span>
              <span style={{ fontSize: '12px', flex: 1 }}>{task.description}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px', fontSize: '10px' }}>
              <span style={{ color: statusColors[task.status] || '#888' }}>{task.status}</span>
              <span style={{ color: '#666' }}>{task.iterations.length}/{task.maxIterations}</span>
              <span style={{ color: '#666' }}>{task.strategy}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
