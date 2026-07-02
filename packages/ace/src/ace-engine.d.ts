/**
 * ACE Engine
 *
 * The main ACE (Autonomous Convergence Engine) that orchestrates
 * fitness evaluation, drift detection, entropy control, and convergence.
 */
import type { EvaluationSnapshot, EvaluationMetrics, ConvergenceStrategy, IEventBus } from '@tik/shared';
import { FitnessEvaluator } from './fitness/fitness-evaluator.js';
import { DriftDetector } from './drift/drift-detector.js';
import { EntropyCalculator } from './entropy/entropy-calculator.js';
import { ConvergenceGate } from './convergence/convergence-gate.js';
import { IterationPlanner } from './planner/iteration-planner.js';
import { MetricsCollector } from './metrics/metrics-collector.js';
export interface IACEEngine {
    evaluateIteration(taskId: string, iteration: number): Promise<EvaluationSnapshot>;
    checkConvergence(evaluation: EvaluationSnapshot, stableCount: number, strategy: ConvergenceStrategy): boolean;
}
export declare class ACEEngine implements IACEEngine {
    readonly fitnessEvaluator: FitnessEvaluator;
    readonly driftDetector: DriftDetector;
    readonly entropyCalculator: EntropyCalculator;
    readonly convergenceGate: ConvergenceGate;
    readonly planner: IterationPlanner;
    readonly metricsCollector: MetricsCollector;
    private eventBus?;
    private iterationMetrics;
    private driftBaselines;
    private entropyBaselines;
    constructor(strategy?: ConvergenceStrategy, eventBus?: IEventBus);
    /**
     * Evaluate a single iteration.
     * In production, metrics would be collected from actual test/build results.
     * This provides the evaluation pipeline structure.
     */
    evaluateIteration(taskId: string, iteration: number): Promise<EvaluationSnapshot>;
    /**
     * Check convergence criteria.
     */
    checkConvergence(evaluation: EvaluationSnapshot, stableCount: number, strategy: ConvergenceStrategy): boolean;
    /**
     * Record metrics for a task iteration.
     */
    recordMetrics(taskId: string, metrics: EvaluationMetrics): void;
    private getOrCreateMetrics;
    private getCurrentDriftSnapshot;
    private getCurrentEntropySnapshot;
    private createMetricsFromSnapshot;
    private emitEvent;
}
//# sourceMappingURL=ace-engine.d.ts.map