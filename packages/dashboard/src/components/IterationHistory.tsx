/**
 * Iteration History Component
 *
 * Shows all iteration metrics as a table + mini sparkline.
 */

import React from 'react';

interface MetricPoint {
  iteration: number;
  fitness: number;
  drift: number;
  entropy: number;
}

interface Props {
  metrics: MetricPoint[];
}

export function IterationHistory({ metrics }: Props) {
  if (metrics.length === 0) {
    return (
      <div style={{ color: '#666', padding: '12px', fontSize: '12px', textAlign: 'center' }}>
        No iterations yet.
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 12px', fontSize: '11px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#888', borderBottom: '1px solid #333' }}>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>#</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Fitness</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Drift</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Entropy</th>
            <th style={{ textAlign: 'left', padding: '4px 8px', width: '120px' }}>Bar</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => {
            const fitnessColor = m.fitness >= 0.8 ? '#51cf66' : m.fitness >= 0.5 ? '#ffd43b' : '#ff6b6b';
            const barWidth = Math.round(m.fitness * 100);
            return (
              <tr key={m.iteration} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={{ padding: '4px 8px', color: '#aaa' }}>{m.iteration}</td>
                <td style={{ padding: '4px 8px', textAlign: 'right', color: fitnessColor, fontWeight: 'bold' }}>
                  {(m.fitness * 100).toFixed(1)}%
                </td>
                <td style={{ padding: '4px 8px', textAlign: 'right', color: m.drift < 3 ? '#51cf66' : '#ff6b6b' }}>
                  {m.drift.toFixed(2)}
                </td>
                <td style={{ padding: '4px 8px', textAlign: 'right', color: m.entropy < 0.5 ? '#51cf66' : '#ff6b6b' }}>
                  {m.entropy.toFixed(3)}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <div style={{
                    width: '100px', height: '8px', background: '#1a1a1a',
                    borderRadius: '4px', overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${barWidth}%`, height: '100%',
                      background: fitnessColor, borderRadius: '4px',
                      transition: 'width 0.3s',
                    }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
