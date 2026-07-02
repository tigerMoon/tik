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
import type { DriftResult, IDriftDetector } from '@tik/shared';
export interface DriftSnapshot {
    interfaces: string[];
    dtos: string[];
    dependencies: string[];
    complexityMetrics: Record<string, number>;
    conventions: string[];
    layerBoundaries: string[];
}
export declare class DriftDetector implements IDriftDetector {
    private history;
    detect(current: unknown, baseline: unknown): DriftResult;
    /** Apply drift penalty to fitness */
    applyPenalty(driftMagnitude: number): number;
    getHistory(): DriftResult[];
    private computeDimensions;
    private computeDimension;
    private computeComplexityDrift;
    private computeMagnitude;
    private detectTrend;
}
//# sourceMappingURL=drift-detector.d.ts.map