/**
 * Structural Drift Detector
 *
 * Detects 6 dimensions of structural drift:
 * - interface: API contract changes
 * - dto: Data transfer object changes
 * - dependency: Dependency graph changes
 * - complexity: Cyclomatic complexity changes
 * - semantic: Naming/convention changes
 * - architecture: Layer/module boundary changes
 */
// ─── Drift Detector ──────────────────────────────────────────
export class DriftDetector {
    history = [];
    detect(current, baseline) {
        const currentSnapshot = current;
        const baselineSnapshot = baseline;
        const dimensions = this.computeDimensions(currentSnapshot, baselineSnapshot);
        const magnitude = this.computeMagnitude(dimensions);
        const trend = this.detectTrend(magnitude);
        const result = { magnitude, dimensions, trend };
        this.history.push(result);
        return result;
    }
    /** Apply drift penalty to fitness */
    applyPenalty(driftMagnitude) {
        if (driftMagnitude >= 5.0)
            return 0.6;
        if (driftMagnitude >= 3.0)
            return 0.8;
        return 1.0;
    }
    getHistory() {
        return [...this.history];
    }
    computeDimensions(current, baseline) {
        return [
            this.computeDimension('interface', current.interfaces, baseline.interfaces, 3.0),
            this.computeDimension('dto', current.dtos, baseline.dtos, 3.0),
            this.computeDimension('dependency', current.dependencies, baseline.dependencies, 4.0),
            this.computeComplexityDrift(current.complexityMetrics, baseline.complexityMetrics),
            this.computeDimension('semantic', current.conventions, baseline.conventions, 5.0),
            this.computeDimension('architecture', current.layerBoundaries, baseline.layerBoundaries, 2.0),
        ];
    }
    computeDimension(name, current, baseline, threshold) {
        const added = current.filter(c => !baseline.includes(c));
        const removed = baseline.filter(b => !current.includes(b));
        const value = added.length + removed.length;
        return {
            name,
            value,
            threshold,
            exceeded: value > threshold,
        };
    }
    computeComplexityDrift(current, baseline) {
        let totalDelta = 0;
        const allKeys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
        for (const key of allKeys) {
            const curr = current[key] || 0;
            const base = baseline[key] || 0;
            totalDelta += Math.abs(curr - base);
        }
        return {
            name: 'complexity',
            value: totalDelta,
            threshold: 5.0,
            exceeded: totalDelta > 5.0,
        };
    }
    computeMagnitude(dimensions) {
        // Weighted sum of dimension values
        const weights = {
            interface: 0.25,
            dto: 0.15,
            dependency: 0.20,
            complexity: 0.15,
            semantic: 0.10,
            architecture: 0.15,
        };
        return dimensions.reduce((sum, d) => sum + d.value * (weights[d.name] || 0.1), 0);
    }
    detectTrend(magnitude) {
        if (this.history.length < 2)
            return 'stable';
        const prev = this.history[this.history.length - 1].magnitude;
        if (magnitude > prev + 1.0)
            return 'degrading';
        if (magnitude > prev)
            return 'regression';
        if (magnitude < prev - 0.5)
            return 'improving';
        return 'stable';
    }
}
//# sourceMappingURL=drift-detector.js.map