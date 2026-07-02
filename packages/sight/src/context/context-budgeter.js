/**
 * Context Budgeter
 *
 * Allocates token budget across context categories.
 * Adaptive fragments get priority allocation (max 50% of run budget).
 */
import { DEFAULT_CONTEXT_BUDGET } from './types.js';
export class ContextBudgeter {
    budget;
    constructor(budget) {
        this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
    }
    /**
     * Select fragments that fit within the token budget.
     * Fragments must be pre-sorted by priority (highest first).
     */
    allocate(rankedFragments) {
        const categoryUsed = {
            spec: 0,
            repo: 0,
            guardrail: 0,
            run: 0,
            memory: 0,
            adaptive: 0,
        };
        let totalUsed = 0;
        const selected = [];
        // First pass: adaptive fragments (priority allocation)
        const adaptive = rankedFragments.filter(f => f.category === 'adaptive');
        const maxAdaptive = Math.floor(this.budget.run * 0.5);
        for (const fragment of adaptive) {
            if (categoryUsed.adaptive >= maxAdaptive)
                break;
            if (totalUsed + fragment.tokenCount > this.budget.total)
                break;
            selected.push(fragment);
            categoryUsed.adaptive += fragment.tokenCount;
            totalUsed += fragment.tokenCount;
        }
        // Second pass: all other fragments by priority
        const others = rankedFragments.filter(f => f.category !== 'adaptive');
        for (const fragment of others) {
            const categoryBudget = this.budget[fragment.category];
            if (categoryUsed[fragment.category] + fragment.tokenCount > categoryBudget)
                continue;
            if (totalUsed + fragment.tokenCount > this.budget.total)
                break;
            selected.push(fragment);
            categoryUsed[fragment.category] += fragment.tokenCount;
            totalUsed += fragment.tokenCount;
        }
        return selected;
    }
    /** Get budget utilization stats */
    getStats(selected) {
        const usage = {
            spec: 0, repo: 0, guardrail: 0, run: 0, memory: 0, adaptive: 0,
        };
        let total = 0;
        for (const f of selected) {
            usage[f.category] += f.tokenCount;
            total += f.tokenCount;
        }
        return {
            totalTokens: total,
            totalBudget: this.budget.total,
            utilization: total / this.budget.total,
            categoryUsage: usage,
            categoryBudgets: { ...this.budget },
        };
    }
}
//# sourceMappingURL=context-budgeter.js.map