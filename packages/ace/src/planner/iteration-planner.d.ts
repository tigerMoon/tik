/**
 * Iteration Planner
 *
 * Generates iteration plans based on evaluation metrics and failures.
 * Includes multi-plan search (3 candidates) for optimal convergence.
 */
import type { FitnessResult, DriftResult, EntropyResult, ConvergenceStrategy } from '@tik/shared';
export type PlannedTaskType = 'FIX_TEST' | 'FIX_BUILD' | 'FIX_CONSTRAINT' | 'REDUCE_DRIFT' | 'REDUCE_COMPLEXITY' | 'IMPROVE_COVERAGE' | 'FIX_LAYER_VIOLATION' | 'GENERAL_IMPROVEMENT';
export interface IterationPlan {
    /** Plan goals */
    goals: string[];
    /** Ordered tasks */
    tasks: PlannedTask[];
    /** Risk level */
    riskLevel: 'low' | 'medium' | 'high';
    /** Strategy used */
    strategy: ConvergenceStrategy;
    /** Estimated fitness improvement */
    estimatedImprovement: number;
}
export interface PlannedTask {
    type: PlannedTaskType;
    description: string;
    priority: number;
    target?: string;
    estimatedImpact: number;
}
export interface PlannerInput {
    fitness: FitnessResult;
    drift: DriftResult;
    entropy: EntropyResult;
    failures: Array<{
        type: string;
        target: string;
        message: string;
    }>;
    iteration: number;
    maxIterations: number;
    strategy: ConvergenceStrategy;
}
export interface CandidatePlan {
    plan: IterationPlan;
    score: number;
    reasoning: string;
}
export declare class IterationPlanner {
    /**
     * Generate an iteration plan from current metrics.
     * Uses multi-plan search to find optimal strategy.
     */
    generatePlan(input: PlannerInput): IterationPlan;
    /**
     * Multi-plan search: generate 3 candidates and score them.
     */
    searchCandidates(input: PlannerInput): CandidatePlan[];
    private generateFixFirstPlan;
    private generateQualityFirstPlan;
    private generateBalancedPlan;
    private scorePlan;
}
//# sourceMappingURL=iteration-planner.d.ts.map