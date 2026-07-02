/**
 * Context Ranker
 *
 * Ranks context fragments by priority.
 * Priority = relevance * 0.5 + recency * 0.3 + importance * 0.2
 */
import type { ContextFragment } from './types.js';
export interface RankerWeights {
    relevance: number;
    recency: number;
    importance: number;
}
export declare class ContextRanker {
    private weights;
    constructor(weights?: Partial<RankerWeights>);
    rank(fragments: ContextFragment[]): ContextFragment[];
}
//# sourceMappingURL=context-ranker.d.ts.map