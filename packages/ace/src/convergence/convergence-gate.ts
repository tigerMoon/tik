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

import type {
  FitnessResult,
  DriftResult,
  EntropyResult,
  ConvergenceResult,
  ConvergenceCriterion,
  IConvergenceGate,
  EvaluationConfig,
} from '@tik/shared';
import { DEFAULT_EVALUATION_CONFIG } from '@tik/shared';
import type { ConvergenceStrategy } from '@tik/shared';

export class ConvergenceGate implements IConvergenceGate {
  private config: EvaluationConfig;

  constructor(strategy: ConvergenceStrategy = 'incremental') {
    this.config = DEFAULT_EVALUATION_CONFIG[strategy];
  }

  setStrategy(strategy: ConvergenceStrategy): void {
    this.config = DEFAULT_EVALUATION_CONFIG[strategy];
  }

  check(
    fitness: FitnessResult,
    drift: DriftResult,
    entropy: EntropyResult,
    stableCount: number,
  ): ConvergenceResult {
    const criteria: ConvergenceCriterion[] = [
      {
        name: 'fitness',
        value: fitness.score,
        threshold: this.config.minFitness,
        met: fitness.score >= this.config.minFitness,
        operator: '>=',
      },
      {
        name: 'drift',
        value: drift.magnitude,
        threshold: this.config.maxDrift,
        met: drift.magnitude < this.config.maxDrift,
        operator: '<',
      },
      {
        name: 'entropy',
        value: entropy.delta,
        threshold: this.config.maxEntropy,
        met: entropy.delta < this.config.maxEntropy,
        operator: '<',
      },
      {
        name: 'critical_gates',
        value: fitness.criticalGatesPassed ? 1 : 0,
        threshold: 1,
        met: fitness.criticalGatesPassed,
        operator: '===',
      },
      {
        name: 'stability',
        value: stableCount,
        threshold: this.config.requiredStableCount,
        met: stableCount >= this.config.requiredStableCount,
        operator: '>=',
      },
    ];

    const converged = criteria.every(c => c.met);
    const failedCriteria = criteria.filter(c => !c.met);

    let recommendation: string | undefined;
    if (!converged && failedCriteria.length > 0) {
      const worst = failedCriteria[0];
      recommendation = `Focus on improving ${worst.name}: current=${worst.value.toFixed(3)}, need ${worst.operator} ${worst.threshold}`;
    }

    return { converged, criteria, stableCount, recommendation };
  }
}
