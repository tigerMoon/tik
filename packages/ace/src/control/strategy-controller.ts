/**
 * Strategy Controller
 *
 * Adjusts convergence strategy based on metrics and iteration progress.
 * Supports: INCREMENTAL, AGGRESSIVE, DEFENSIVE
 */

import type { ConvergenceStrategy, EvaluationSnapshot } from '@tik/shared';

export interface StrategyRecommendation {
  current: ConvergenceStrategy;
  recommended: ConvergenceStrategy;
  reason: string;
  shouldSwitch: boolean;
}

export class StrategyController {
  private currentStrategy: ConvergenceStrategy;

  constructor(initial: ConvergenceStrategy = 'incremental') {
    this.currentStrategy = initial;
  }

  get strategy(): ConvergenceStrategy {
    return this.currentStrategy;
  }

  set strategy(value: ConvergenceStrategy) {
    this.currentStrategy = value;
  }

  /**
   * Recommend strategy adjustment based on iteration progress.
   */
  recommend(
    evaluation: EvaluationSnapshot,
    iteration: number,
    maxIterations: number,
  ): StrategyRecommendation {
    const remaining = maxIterations - iteration;
    const progress = evaluation.fitness;

    // If close to max iterations and fitness is low, switch to aggressive
    if (remaining <= 2 && progress < 0.7 && this.currentStrategy !== 'aggressive') {
      return {
        current: this.currentStrategy,
        recommended: 'aggressive',
        reason: `Low fitness (${progress.toFixed(2)}) with only ${remaining} iterations remaining`,
        shouldSwitch: true,
      };
    }

    // If drift is high, switch to defensive
    if (evaluation.drift > 4.0 && this.currentStrategy !== 'defensive') {
      return {
        current: this.currentStrategy,
        recommended: 'defensive',
        reason: `High drift (${evaluation.drift.toFixed(1)}) detected`,
        shouldSwitch: true,
      };
    }

    // If converging well, can be more aggressive
    if (progress > 0.75 && evaluation.drift < 2.0 && remaining > 2 && this.currentStrategy === 'defensive') {
      return {
        current: this.currentStrategy,
        recommended: 'incremental',
        reason: `Good progress (fitness=${progress.toFixed(2)}), can relax to incremental`,
        shouldSwitch: true,
      };
    }

    return {
      current: this.currentStrategy,
      recommended: this.currentStrategy,
      reason: 'Current strategy is appropriate',
      shouldSwitch: false,
    };
  }
}
