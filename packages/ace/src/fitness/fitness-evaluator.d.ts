/**
 * Non-Linear Fitness Aggregator
 *
 * Computes fitness using geometric mean with curve-based scoring.
 * Formula:
 *   fitness_vector = (quality * correctness * stability * complexity)^(1/4)
 *   drift_penalty: drift >= 5.0 -> *0.6; drift >= 3.0 -> *0.8
 *   entropy_penalty: delta >= 1.0 -> *0.5; delta >= 0.5 -> *0.7
 *   constraint_penalty = min(soft_failures * 0.05, 0.50)
 *   final = fitness_vector * drift_penalty * entropy_penalty * (1 - constraint_penalty)
 */
import type { FitnessResult, EvaluationMetrics, IFitnessEvaluator } from '@tik/shared';
export declare class FitnessEvaluator implements IFitnessEvaluator {
    evaluate(metrics: EvaluationMetrics): FitnessResult;
    private computeComponents;
    private computeQuality;
    private computeCorrectness;
    private computeStability;
    private computeComplexity;
    private checkCriticalGates;
    private computePenalties;
}
//# sourceMappingURL=fitness-evaluator.d.ts.map