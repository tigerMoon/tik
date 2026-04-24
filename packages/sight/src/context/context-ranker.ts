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

const DEFAULT_WEIGHTS: RankerWeights = {
  relevance: 0.5,
  recency: 0.3,
  importance: 0.2,
};

export class ContextRanker {
  private weights: RankerWeights;

  constructor(weights?: Partial<RankerWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  rank(fragments: ContextFragment[]): ContextFragment[] {
    // Compute priority for each fragment
    const scored = fragments.map(f => ({
      ...f,
      priority:
        f.relevance * this.weights.relevance +
        f.recency * this.weights.recency +
        f.importance * this.weights.importance,
    }));

    // Sort by priority descending
    scored.sort((a, b) => b.priority - a.priority);
    return scored;
  }
}
