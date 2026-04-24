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

import type {
  EntropyResult,
  EntropyDimension,
  IEntropyCalculator,
} from '@tik/shared';

// ─── Entropy Snapshot ────────────────────────────────────────

export interface EntropySnapshot {
  /** Complexity per module */
  complexityDistribution: Record<string, number>;
  /** Dependencies per module */
  dependencyDistribution: Record<string, number>;
  /** Change frequency per module */
  changeDistribution: Record<string, number>;
}

// ─── Entropy Calculator ──────────────────────────────────────

export class EntropyCalculator implements IEntropyCalculator {
  private baseline: EntropySnapshot | null = null;

  setBaseline(snapshot: EntropySnapshot): void {
    this.baseline = snapshot;
  }

  calculate(current: unknown, baseline: unknown): EntropyResult {
    const currentSnapshot = current as EntropySnapshot;
    const baselineSnapshot = (baseline || this.baseline) as EntropySnapshot;

    const dimensions: EntropyDimension[] = [
      this.computeDimension(
        'complexity',
        currentSnapshot.complexityDistribution,
        baselineSnapshot?.complexityDistribution || {},
      ),
      this.computeDimension(
        'dependency',
        currentSnapshot.dependencyDistribution,
        baselineSnapshot?.dependencyDistribution || {},
      ),
      this.computeDimension(
        'module',
        currentSnapshot.changeDistribution,
        baselineSnapshot?.changeDistribution || {},
      ),
    ];

    const delta = dimensions.reduce((sum, d) => sum + Math.abs(d.delta), 0) / dimensions.length;
    const budgetRemaining = Math.max(0, 0.5 - delta);

    return { delta, dimensions, budgetRemaining };
  }

  /** Apply entropy penalty to fitness */
  applyPenalty(entropyDelta: number): number {
    if (entropyDelta >= 1.0) return 0.5;
    if (entropyDelta >= 0.5) return 0.7;
    return 1.0;
  }

  private computeDimension(
    name: EntropyDimension['name'],
    current: Record<string, number>,
    baseline: Record<string, number>,
  ): EntropyDimension {
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
  private shannonEntropy(distribution: Record<string, number>): number {
    const values = Object.values(distribution);
    if (values.length === 0) return 0;

    const total = values.reduce((sum, v) => sum + v, 0);
    if (total === 0) return 0;

    let entropy = 0;
    for (const value of values) {
      if (value <= 0) continue;
      const p = value / total;
      entropy -= p * Math.log2(p);
    }

    return entropy;
  }
}
