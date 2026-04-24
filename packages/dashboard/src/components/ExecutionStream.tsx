/**
 * Execution Stream Component
 *
 * Real-time display of tool calls, results, and events.
 * The core differentiating feature of Tik.
 */

import React from 'react';
import type { AgentEvent } from '../api/client';

const eventIcons: Record<string, string> = {
  'tool.called': '🔧',
  'tool.result': '✅',
  'tool.error': '❌',
  'plan.generated': '📋',
  'context.built': '🧠',
  'evaluation.completed': '📊',
  'evaluation.fitness': '💪',
  'evaluation.drift': '📐',
  'evaluation.entropy': '🌡️',
  'convergence.achieved': '🎯',
  'iteration.started': '🔄',
  'iteration.completed': '✓',
  'task.created': '📌',
  'task.started': '▶️',
  'task.completed': '🏁',
  'task.failed': '💥',
  'human.intervention': '👤',
};

function getEventColor(type: string): string {
  if (type.includes('error') || type.includes('failed')) return '#ff6b6b';
  if (type.includes('completed') || type.includes('converge') || type.includes('result')) return '#51cf66';
  if (type.includes('started') || type.includes('called')) return '#74c0fc';
  if (type.includes('evaluation') || type.includes('fitness')) return '#ffd43b';
  return '#adb5bd';
}

function formatPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'number') {
      parts.push(`${key}=${value.toFixed(3)}`);
    } else if (typeof value === 'string') {
      parts.push(`${key}="${value.length > 30 ? value.slice(0, 30) + '...' : value}"`);
    } else if (typeof value === 'boolean') {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(' ');
}

interface Props {
  events: AgentEvent[];
}

export function ExecutionStream({ events }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h3 style={{ padding: '12px 16px', borderBottom: '1px solid #333', margin: 0, fontSize: '14px' }}>
        Execution Stream
      </h3>
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px 16px',
          fontFamily: 'monospace',
          fontSize: '12px',
          lineHeight: '20px',
        }}
      >
        {events.length === 0 && (
          <div style={{ color: '#666', padding: '20px', textAlign: 'center' }}>
            No events yet. Submit a task to start.
          </div>
        )}
        {events.map((event) => (
          <div key={event.id} style={{ display: 'flex', gap: '8px', padding: '2px 0' }}>
            <span style={{ color: '#666', flexShrink: 0 }}>
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
            <span style={{ flexShrink: 0 }}>
              {eventIcons[event.type] || '  '}
            </span>
            <span style={{ color: getEventColor(event.type), flexShrink: 0 }}>
              {event.type}
            </span>
            <span style={{ color: '#888' }}>
              {formatPayload(event.payload)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
