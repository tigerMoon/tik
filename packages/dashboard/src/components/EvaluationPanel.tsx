/**
 * Evaluation Panel Component
 *
 * Displays fitness/drift/entropy metrics over iterations as charts.
 */

import React from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface MetricPoint {
  iteration: number;
  fitness: number;
  drift: number;
  entropy: number;
}

interface Props {
  metrics: MetricPoint[];
}

export function EvaluationPanel({ metrics }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <h3 style={{ padding: '12px 16px', borderBottom: '1px solid #333', margin: 0, fontSize: '14px' }}>
        Evaluation Metrics
      </h3>
      <div style={{ flex: 1, padding: '16px' }}>
        {metrics.length === 0 ? (
          <div style={{ color: '#666', textAlign: 'center', padding: '40px' }}>
            No evaluation data yet.
          </div>
        ) : (
          <>
            {/* Fitness Chart */}
            <div style={{ marginBottom: '16px' }}>
              <h4 style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>Fitness Score</h4>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={metrics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="iteration" stroke="#666" tick={{ fontSize: 10 }} />
                  <YAxis domain={[0, 1]} stroke="#666" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                  <Line type="monotone" dataKey="fitness" stroke="#51cf66" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Drift & Entropy Chart */}
            <div>
              <h4 style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>Drift & Entropy</h4>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={metrics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis dataKey="iteration" stroke="#666" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#666" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333' }} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="drift" stroke="#ff6b6b" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="entropy" stroke="#ffd43b" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Current Values */}
            <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
              {metrics.length > 0 && (() => {
                const latest = metrics[metrics.length - 1];
                return (
                  <>
                    <MetricCard label="Fitness" value={latest.fitness} threshold={0.8} format="percent" good="high" />
                    <MetricCard label="Drift" value={latest.drift} threshold={3.0} format="number" good="low" />
                    <MetricCard label="Entropy" value={latest.entropy} threshold={0.5} format="number" good="low" />
                  </>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, threshold, format, good }: {
  label: string;
  value: number;
  threshold: number;
  format: 'percent' | 'number';
  good: 'high' | 'low';
}) {
  const isGood = good === 'high' ? value >= threshold : value < threshold;
  const color = isGood ? '#51cf66' : '#ff6b6b';
  const display = format === 'percent' ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);

  return (
    <div style={{
      flex: 1,
      background: '#1a1a1a',
      borderRadius: '8px',
      padding: '12px',
      border: `1px solid ${color}33`,
    }}>
      <div style={{ fontSize: '10px', color: '#888', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 'bold', color, marginTop: '4px' }}>{display}</div>
      <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
        threshold: {format === 'percent' ? `${(threshold * 100)}%` : threshold}
      </div>
    </div>
  );
}
