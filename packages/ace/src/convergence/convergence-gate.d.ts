/**
 * Convergence Gate
 *
 * Determines whether the system has converged.
 * Criteria:
 *   - integration_pass_rate === 1.0
 *   - fitness >= 0.80
 *   - driftMagnitude < 3.0
 *   - entropyDelta < 0.5
 *   - breaking_changes === 0
 *   - stableCount >= 2
 */
import type { FitnessResult, DriftResult, EntropyResult, ConvergenceResult, IConvergenceGate } from '@tik/shared';
import type { ConvergenceStrategy } from '@tik/shared';
export declare class ConvergenceGate implements IConvergenceGate {
    private config;
    constructor(strategy?: ConvergenceStrategy);
    setStrategy(strategy: ConvergenceStrategy): void;
    check(fitness: FitnessResult, drift: DriftResult, entropy: EntropyResult, stableCount: number): ConvergenceResult;
}
//# sourceMappingURL=convergence-gate.d.ts.map