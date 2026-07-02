/**
 * Evaluation Types
 *
 * Re-exports from ACE Convergence Engine.
 * Defines fitness, drift, entropy, and convergence criteria.
 */
export const DEFAULT_EVALUATION_CONFIG = {
    incremental: {
        strategy: 'incremental',
        minFitness: 0.80,
        maxDrift: 3.0,
        maxEntropy: 0.5,
        requiredStableCount: 2,
        maxIterations: 5,
    },
    aggressive: {
        strategy: 'aggressive',
        minFitness: 0.70,
        maxDrift: 4.0,
        maxEntropy: 0.7,
        requiredStableCount: 1,
        maxIterations: 7,
    },
    defensive: {
        strategy: 'defensive',
        minFitness: 0.85,
        maxDrift: 2.0,
        maxEntropy: 0.3,
        requiredStableCount: 3,
        maxIterations: 5,
    },
};
//# sourceMappingURL=evaluation.js.map