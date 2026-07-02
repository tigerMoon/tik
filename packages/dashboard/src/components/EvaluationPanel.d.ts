/**
 * Evaluation Panel Component
 *
 * Displays fitness/drift/entropy metrics over iterations as charts.
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
export declare function EvaluationPanel({ metrics }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=EvaluationPanel.d.ts.map