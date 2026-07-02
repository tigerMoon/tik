/**
 * Context Budgeter
 *
 * Allocates token budget across context categories.
 * Adaptive fragments get priority allocation (max 50% of run budget).
 */
import type { ContextFragment, ContextBudget, ContextCategory } from './types.js';
export declare class ContextBudgeter {
    private budget;
    constructor(budget?: Partial<ContextBudget>);
    /**
     * Select fragments that fit within the token budget.
     * Fragments must be pre-sorted by priority (highest first).
     */
    allocate(rankedFragments: ContextFragment[]): ContextFragment[];
    /** Get budget utilization stats */
    getStats(selected: ContextFragment[]): BudgetStats;
}
export interface BudgetStats {
    totalTokens: number;
    totalBudget: number;
    utilization: number;
    categoryUsage: Record<ContextCategory, number>;
    categoryBudgets: ContextBudget;
}
//# sourceMappingURL=context-budgeter.d.ts.map