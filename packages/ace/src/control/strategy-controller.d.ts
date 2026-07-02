/**
 * Strategy Controller
 *
 * Adjusts convergence strategy based on metrics and iteration progress.
 * Supports: INCREMENTAL, AGGRESSIVE, DEFENSIVE
 */
import type { ConvergenceStrategy, EvaluationSnapshot } from '@tik/shared';
export interface StrategyRecommendation {
    current: ConvergenceStrategy;
    recommended: ConvergenceStrategy;
    reason: string;
    shouldSwitch: boolean;
}
export declare class StrategyController {
    private currentStrategy;
    constructor(initial?: ConvergenceStrategy);
    get strategy(): ConvergenceStrategy;
    set strategy(value: ConvergenceStrategy);
    /**
     * Recommend strategy adjustment based on iteration progress.
     */
    recommend(evaluation: EvaluationSnapshot, iteration: number, maxIterations: number): StrategyRecommendation;
}
//# sourceMappingURL=strategy-controller.d.ts.map