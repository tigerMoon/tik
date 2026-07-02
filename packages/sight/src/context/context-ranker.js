/**
 * Context Ranker
 *
 * Ranks context fragments by priority.
 * Priority = relevance * 0.5 + recency * 0.3 + importance * 0.2
 */
const DEFAULT_WEIGHTS = {
    relevance: 0.5,
    recency: 0.3,
    importance: 0.2,
};
export class ContextRanker {
    weights;
    constructor(weights) {
        this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    }
    rank(fragments) {
        // Compute priority for each fragment
        const scored = fragments.map(f => ({
            ...f,
            priority: f.relevance * this.weights.relevance +
                f.recency * this.weights.recency +
                f.importance * this.weights.importance,
        }));
        // Sort by priority descending
        scored.sort((a, b) => b.priority - a.priority);
        return scored;
    }
}
//# sourceMappingURL=context-ranker.js.map