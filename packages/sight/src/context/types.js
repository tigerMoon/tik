/**
 * Context Fragment
 *
 * A fragment is the atomic unit of context.
 * Fragments are ranked, budgeted, and packed into AgentContext.
 */
export const DEFAULT_CONTEXT_BUDGET = {
    spec: 25_000,
    repo: 35_000,
    guardrail: 10_000,
    run: 20_000,
    memory: 20_000,
    adaptive: 10_000,
    total: 120_000,
};
//# sourceMappingURL=types.js.map