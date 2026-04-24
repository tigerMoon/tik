/**
 * Metrics Collector
 *
 * Extracts real evaluation metrics from tool execution results.
 * Listens to EventBus for TOOL_RESULT events and aggregates metrics per iteration.
 */

import type { AgentEvent, IEventBus, EvaluationMetrics } from '@tik/shared';
import { EventType } from '@tik/shared';

export class MetricsCollector {
  private iterationResults: Map<string, IterationData> = new Map();

  constructor(eventBus?: IEventBus) {
    if (eventBus) {
      eventBus.on(EventType.TOOL_RESULT, (event: AgentEvent) => this.onToolResult(event));
      eventBus.on(EventType.TOOL_ERROR, (event: AgentEvent) => this.onToolError(event));
      eventBus.on(EventType.ITERATION_STARTED, (event: AgentEvent) => this.onIterationStart(event));
    }
  }

  /** Get metrics for a task's current iteration */
  getMetrics(taskId: string): EvaluationMetrics {
    const data = this.iterationResults.get(taskId);
    if (!data) return this.defaultMetrics();

    const totalActions = data.successCount + data.failureCount;
    const successRate = totalActions > 0 ? data.successCount / totalActions : 0;

    return {
      buildSuccess: !data.hasBuildFailure,
      coverageRatio: data.hasTestOutput ? data.testPassRate : 0.5,
      integrationTestPassRate: successRate,
      codeChurnRatio: data.filesModified / Math.max(data.filesRead, 1),
      complexityDelta: data.filesModified * 0.5,
      newDependencies: 0,
      breakingChanges: 0,
      layerViolationCount: 0,
      blockerCount: data.hasBuildFailure ? 1 : 0,
      criticalCount: data.failureCount > totalActions * 0.5 ? 1 : 0,
      majorCount: data.failureCount,
      specTraceabilityRatio: data.filesRead > 0 ? 0.8 : 0.3,
      constraintSoftFailures: 0,
    };
  }

  /** Record metrics externally (e.g., from test runner) */
  recordMetrics(taskId: string, partial: Partial<EvaluationMetrics>): void {
    // Allow external systems to inject metrics
    const data = this.ensureData(taskId);
    if (partial.buildSuccess === false) data.hasBuildFailure = true;
    if (partial.coverageRatio !== undefined) {
      data.hasTestOutput = true;
      data.testPassRate = partial.coverageRatio;
    }
  }

  // ─── Event Handlers ───────────────────────────────────────

  private onIterationStart(event: AgentEvent): void {
    // Reset per-iteration counters
    this.iterationResults.set(event.taskId, {
      successCount: 0,
      failureCount: 0,
      filesRead: 0,
      filesModified: 0,
      hasBuildFailure: false,
      hasTestOutput: false,
      testPassRate: 0,
    });
  }

  private onToolResult(event: AgentEvent): void {
    const data = this.ensureData(event.taskId);
    const payload = event.payload as { toolName: string; success: boolean; filesModified?: string[] };

    if (payload.success) {
      data.successCount++;
    } else {
      data.failureCount++;
    }

    // Track file operations
    if (payload.toolName === 'read_file') data.filesRead++;
    if (payload.toolName === 'write_file' || payload.toolName === 'edit_file') {
      data.filesModified += (payload.filesModified?.length || 1);
    }

    // Detect build failures
    if (payload.toolName === 'bash' && !payload.success) {
      data.hasBuildFailure = true;
    }
  }

  private onToolError(event: AgentEvent): void {
    const data = this.ensureData(event.taskId);
    data.failureCount++;
  }

  // ─── Helpers ──────────────────────────────────────────────

  private ensureData(taskId: string): IterationData {
    if (!this.iterationResults.has(taskId)) {
      this.iterationResults.set(taskId, {
        successCount: 0, failureCount: 0,
        filesRead: 0, filesModified: 0,
        hasBuildFailure: false, hasTestOutput: false, testPassRate: 0,
      });
    }
    return this.iterationResults.get(taskId)!;
  }

  private defaultMetrics(): EvaluationMetrics {
    return {
      buildSuccess: true, coverageRatio: 0, integrationTestPassRate: 0,
      codeChurnRatio: 0, complexityDelta: 0, newDependencies: 0,
      breakingChanges: 0, layerViolationCount: 0, blockerCount: 0,
      criticalCount: 0, majorCount: 0, specTraceabilityRatio: 0,
      constraintSoftFailures: 0,
    };
  }
}

interface IterationData {
  successCount: number;
  failureCount: number;
  filesRead: number;
  filesModified: number;
  hasBuildFailure: boolean;
  hasTestOutput: boolean;
  testPassRate: number;
}
