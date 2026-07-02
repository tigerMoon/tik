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
export declare function IterationHistory({ metrics }: Props): React.JSX.Element;
export {};
//# sourceMappingURL=IterationHistory.d.ts.map