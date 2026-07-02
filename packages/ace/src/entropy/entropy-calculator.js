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
// ─── Entropy Calculator ──────────────────────────────────────
export class EntropyCalculator {
    baseline = null;
    setBaseline(snapshot) {
        this.baseline = snapshot;
    }
    calculate(current, baseline) {
        const currentSnapshot = current;
        const baselineSnapshot = (baseline || this.baseline);
        const dimensions = [
            this.computeDimension('complexity', currentSnapshot.complexityDistribution, baselineSnapshot?.complexityDistribution || {}),
            this.computeDimension('dependency', currentSnapshot.dependencyDistribution, baselineSnapshot?.dependencyDistribution || {}),
            this.computeDimension('module', currentSnapshot.changeDistribution, baselineSnapshot?.changeDistribution || {}),
        ];
        const delta = dimensions.reduce((sum, d) => sum + Math.abs(d.delta), 0) / dimensions.length;
        const budgetRemaining = Math.max(0, 0.5 - delta);
        return { delta, dimensions, budgetRemaining };
    }
    /** Apply entropy penalty to fitness */
    applyPenalty(entropyDelta) {
        if (entropyDelta >= 1.0)
            return 0.5;
        if (entropyDelta >= 0.5)
            return 0.7;
        return 1.0;
    }
    computeDimension(name, current, baseline) {
        const currentEntropy = this.shannonEntropy(current);
        const baselineEntropy = this.shannonEntropy(baseline);
        return {
            name,
            value: currentEntropy,
            baseline: baselineEntropy,
            delta: currentEntropy - baselineEntropy,
        };
    }
    /**
     * Shannon entropy: H = -sum(p * log2(p))
     * Higher entropy = more uniform distribution (more chaos)
     */
    shannonEntropy(distribution) {
        const values = Object.values(distribution);
        if (values.length === 0)
            return 0;
        const total = values.reduce((sum, v) => sum + v, 0);
        if (total === 0)
            return 0;
        let entropy = 0;
        for (const value of values) {
            if (value <= 0)
                continue;
            const p = value / total;
            entropy -= p * Math.log2(p);
        }
        return entropy;
    }
}
//# sourceMappingURL=entropy-calculator.js.map