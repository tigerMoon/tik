/**
 * Non-Linear Fitness Aggregator
 *
 * Computes fitness using geometric mean with curve-based scoring.
 * Formula:
 *   fitness_vector = (quality * correctness * stability * complexity)^(1/4)
 *   drift_penalty: drift >= 5.0 -> *0.6; drift >= 3.0 -> *0.8
 *   entropy_penalty: delta >= 1.0 -> *0.5; delta >= 0.5 -> *0.7
 *   constraint_penalty = min(soft_failures * 0.05, 0.50)
 *   final = fitness_vector * drift_penalty * entropy_penalty * (1 - constraint_penalty)
 */

import type {
  FitnessResult,
  FitnessComponent,
  FitnessPenalty,
  EvaluationMetrics,
  IFitnessEvaluator,
} from '@tik/shared';
import { clamp } from '@tik/shared';

// ─── Scoring Curves ──────────────────────────────────────────

type CurveType = 'linear' | 'exponential' | 'sigmoid' | 'threshold';

function applyCurve(value: number, curve: CurveType): number {
  switch (curve) {
    case 'linear':
      return clamp(value, 0, 1);
    case 'exponential':
      return 1 - Math.exp(-3 * value);
    case 'sigmoid':
      return 1 / (1 + Math.exp(-10 * (value - 0.5)));
    case 'threshold':
      return value >= 0.8 ? 1.0 : value >= 0.5 ? 0.5 : 0;
  }
}

// ─── Fitness Evaluator ───────────────────────────────────────

export class FitnessEvaluator implements IFitnessEvaluator {
  evaluate(metrics: EvaluationMetrics): FitnessResult {
    // Step 1: Compute component scores
    const components = this.computeComponents(metrics);

    // Step 2: Geometric mean
    const scores = components.map(c => c.score * c.weight);
    const weightSum = components.reduce((sum, c) => sum + c.weight, 0);
    const weightedProduct = scores.reduce((prod, s, i) => prod * Math.pow(s > 0 ? s : 0.001, components[i].weight / weightSum), 1);
    const fitnessVector = Math.pow(weightedProduct, 1);

    // Step 3: Critical gates
    const criticalGatesPassed = this.checkCriticalGates(metrics);

    // Step 4: Penalties
    const penalties = this.computePenalties(metrics);
    const penaltyFactor = penalties.reduce((factor, p) => factor * p.factor, 1);

    const finalScore = clamp(fitnessVector * penaltyFactor, 0, 1);

    return {
      score: finalScore,
      components,
      criticalGatesPassed,
      penalties,
    };
  }

  private computeComponents(metrics: EvaluationMetrics): FitnessComponent[] {
    return [
      {
        name: 'quality',
        score: applyCurve(this.computeQuality(metrics), 'sigmoid'),
        weight: 0.3,
        curve: 'sigmoid',
      },
      {
        name: 'correctness',
        score: applyCurve(this.computeCorrectness(metrics), 'threshold'),
        weight: 0.3,
        curve: 'threshold',
      },
      {
        name: 'stability',
        score: applyCurve(this.computeStability(metrics), 'linear'),
        weight: 0.2,
        curve: 'linear',
      },
      {
        name: 'complexity',
        score: applyCurve(this.computeComplexity(metrics), 'exponential'),
        weight: 0.2,
        curve: 'exponential',
      },
    ];
  }

  private computeQuality(metrics: EvaluationMetrics): number {
    const coverageScore = metrics.coverageRatio;
    const layerScore = metrics.layerViolationCount === 0 ? 1.0 : Math.max(0, 1 - metrics.layerViolationCount * 0.1);
    const traceScore = metrics.specTraceabilityRatio;
    return (coverageScore + layerScore + traceScore) / 3;
  }

  private computeCorrectness(metrics: EvaluationMetrics): number {
    if (!metrics.buildSuccess) return 0;
    return metrics.integrationTestPassRate;
  }

  private computeStability(metrics: EvaluationMetrics): number {
    const breakingScore = metrics.breakingChanges === 0 ? 1.0 : 0;
    const churnScore = Math.max(0, 1 - metrics.codeChurnRatio);
    return (breakingScore + churnScore) / 2;
  }

  private computeComplexity(metrics: EvaluationMetrics): number {
    const depScore = Math.max(0, 1 - metrics.newDependencies * 0.1);
    const complexityScore = Math.max(0, 1 - Math.abs(metrics.complexityDelta) * 0.05);
    return (depScore + complexityScore) / 2;
  }

  private checkCriticalGates(metrics: EvaluationMetrics): boolean {
    return (
      metrics.buildSuccess &&
      metrics.blockerCount === 0 &&
      metrics.breakingChanges === 0
    );
  }

  private computePenalties(metrics: EvaluationMetrics): FitnessPenalty[] {
    const penalties: FitnessPenalty[] = [];

    // Constraint soft failure penalty
    if (metrics.constraintSoftFailures > 0) {
      const penalty = Math.min(metrics.constraintSoftFailures * 0.05, 0.50);
      penalties.push({
        type: 'constraint',
        factor: 1 - penalty,
        reason: `${metrics.constraintSoftFailures} soft constraint failures`,
      });
    }

    return penalties;
  }
}
