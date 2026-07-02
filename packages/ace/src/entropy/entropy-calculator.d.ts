/**
 * Entropy Calculator
 *
 * 3-dimensional Shannon entropy:
 * - complexity entropy: distribution of complexity across modules
 * - dependency entropy: distribution of dependencies
 * - module entropy: distribution of changes across modules
 *
 * Budget: entropy delta < 0.5
 */
import type { EntropyResult, IEntropyCalculator } from '@tik/shared';
export interface EntropySnapshot {
    /** Complexity per module */
    complexityDistribution: Record<string, number>;
    /** Dependencies per module */
    dependencyDistribution: Record<string, number>;
    /** Change frequency per module */
    changeDistribution: Record<string, number>;
}
export declare class EntropyCalculator implements IEntropyCalculator {
    private baseline;
    setBaseline(snapshot: EntropySnapshot): void;
    calculate(current: unknown, baseline: unknown): EntropyResult;
    /** Apply entropy penalty to fitness */
    applyPenalty(entropyDelta: number): number;
    private computeDimension;
    /**
     * Shannon entropy: H = -sum(p * log2(p))
     * Higher entropy = more uniform distribution (more chaos)
     */
    private shannonEntropy;
}
//# sourceMappingURL=entropy-calculator.d.ts.map