/**
 * Metrics Collector
 *
 * Extracts real evaluation metrics from tool execution results.
 * Listens to EventBus for TOOL_RESULT events and aggregates metrics per iteration.
 */
import type { IEventBus, EvaluationMetrics } from '@tik/shared';
export declare class MetricsCollector {
    private iterationResults;
    constructor(eventBus?: IEventBus);
    /** Get metrics for a task's current iteration */
    getMetrics(taskId: string): EvaluationMetrics;
    /** Record metrics externally (e.g., from test runner) */
    recordMetrics(taskId: string, partial: Partial<EvaluationMetrics>): void;
    private onIterationStart;
    private onToolResult;
    private onToolError;
    private ensureData;
    private defaultMetrics;
}
//# sourceMappingURL=metrics-collector.d.ts.map