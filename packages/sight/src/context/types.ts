/**
 * Context Fragment
 *
 * A fragment is the atomic unit of context.
 * Fragments are ranked, budgeted, and packed into AgentContext.
 */

export interface ContextFragment {
  /** Unique fragment ID */
  id: string;
  /** Fragment category */
  category: ContextCategory;
  /** Content text */
  content: string;
  /** Estimated token count */
  tokenCount: number;
  /** Relevance score (0-1) */
  relevance: number;
  /** Recency score (0-1) */
  recency: number;
  /** Importance score (0-1) */
  importance: number;
  /** Combined priority (computed) */
  priority: number;
  /** Source identifier */
  source: string;
  /** Tags for filtering */
  tags: string[];
}

export type ContextCategory = 'spec' | 'repo' | 'guardrail' | 'run' | 'memory' | 'adaptive';

/** Token budget allocation per category */
export interface ContextBudget {
  spec: number;
  repo: number;
  guardrail: number;
  run: number;
  memory: number;
  adaptive: number;
  total: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  spec: 25_000,
  repo: 35_000,
  guardrail: 10_000,
  run: 20_000,
  memory: 20_000,
  adaptive: 10_000,
  total: 120_000,
};
