/**
 * Evaluation Types
 *
 * Re-exports from ACE Convergence Engine.
 * Defines fitness, drift, entropy, and convergence criteria.
 */

// ─── Fitness ─────────────────────────────────────────────────

export interface FitnessResult {
  /** Final fitness score (0.0 - 1.0) */
  score: number;
  /** Component scores */
  components: FitnessComponent[];
  /** Whether all critical gates passed */
  criticalGatesPassed: boolean;
  /** Applied penalties */
  penalties: FitnessPenalty[];
}

export interface FitnessComponent {
  name: string;
  score: number;
  weight: number;
  /** Scoring curve type */
  curve: 'linear' | 'exponential' | 'sigmoid' | 'threshold';
}

export interface FitnessPenalty {
  type: 'drift' | 'entropy' | 'constraint';
  factor: number;
  reason: string;
}

/**
 * Fitness formula:
 * fitness_vector = (quality * correctness * stability * complexity)^(1/4)
 * drift_penalty: drift >= 5.0 -> *0.6; drift >= 3.0 -> *0.8
 * entropy_penalty: delta >= 1.0 -> *0.5; delta >= 0.5 -> *0.7
 * constraint_penalty = min(soft_failures * 0.05, 0.50)
 * final_fitness = fitness_vector * drift_penalty * entropy_penalty * (1 - constraint_penalty)
 */

// ─── Drift ───────────────────────────────────────────────────

export interface DriftResult {
  /** Total drift magnitude */
  magnitude: number;
  /** Per-dimension drift */
  dimensions: DriftDimension[];
  /** Drift trend */
  trend: 'improving' | 'stable' | 'degrading' | 'regression';
}

export interface DriftDimension {
  /** Dimension name */
  name: DriftDimensionName;
  /** Drift value */
  value: number;
  /** Threshold for concern */
  threshold: number;
  /** Whether exceeded */
  exceeded: boolean;
}

export type DriftDimensionName =
  | 'interface'
  | 'dto'
  | 'dependency'
  | 'complexity'
  | 'semantic'
  | 'architecture';

// ─── Entropy ─────────────────────────────────────────────────

export interface EntropyResult {
  /** Total entropy delta */
  delta: number;
  /** Per-dimension entropy */
  dimensions: EntropyDimension[];
  /** Entropy budget remaining */
  budgetRemaining: number;
}

export interface EntropyDimension {
  name: 'complexity' | 'dependency' | 'module';
  value: number;
  baseline: number;
  delta: number;
}

// ─── Convergence ─────────────────────────────────────────────

/**
 * Convergence criteria:
 * - integration_pass_rate === 1.0
 * - fitness >= 0.80
 * - driftMagnitude < 3.0
 * - entropyDelta < 0.5
 * - breaking_changes === 0
 * - stableCount >= 2
 */

export interface ConvergenceResult {
  /** Whether all criteria met */
  converged: boolean;
  /** Individual criteria results */
  criteria: ConvergenceCriterion[];
  /** Number of consecutive stable iterations */
  stableCount: number;
  /** Recommended action if not converged */
  recommendation?: string;
}

export interface ConvergenceCriterion {
  name: string;
  /** Current value */
  value: number;
  /** Required threshold */
  threshold: number;
  /** Whether this criterion is met */
  met: boolean;
  /** Comparison operator */
  operator: '>=' | '<' | '<=' | '===' | '>';
}

// ─── Evaluation Strategy ─────────────────────────────────────

export type EvaluationStrategy = 'incremental' | 'aggressive' | 'defensive';

export interface EvaluationConfig {
  strategy: EvaluationStrategy;
  /** Minimum fitness to pass */
  minFitness: number;
  /** Maximum drift allowed */
  maxDrift: number;
  /** Maximum entropy delta */
  maxEntropy: number;
  /** Required stable iterations */
  requiredStableCount: number;
  /** Maximum iterations */
  maxIterations: number;
}

export const DEFAULT_EVALUATION_CONFIG: Record<EvaluationStrategy, EvaluationConfig> = {
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

// ─── Evaluator Interfaces ────────────────────────────────────

export interface IFitnessEvaluator {
  evaluate(metrics: EvaluationMetrics): FitnessResult;
}

export interface IDriftDetector {
  detect(current: unknown, baseline: unknown): DriftResult;
}

export interface IEntropyCalculator {
  calculate(current: unknown, baseline: unknown): EntropyResult;
}

export interface IConvergenceGate {
  check(fitness: FitnessResult, drift: DriftResult, entropy: EntropyResult, stableCount: number): ConvergenceResult;
}

// ─── Evaluation Metrics (input) ──────────────────────────────

export interface EvaluationMetrics {
  /** Build succeeded */
  buildSuccess: boolean;
  /** Test coverage ratio */
  coverageRatio: number;
  /** Integration test pass rate */
  integrationTestPassRate: number;
  /** Code churn ratio */
  codeChurnRatio: number;
  /** Complexity delta */
  complexityDelta: number;
  /** New dependencies added */
  newDependencies: number;
  /** Breaking changes count */
  breakingChanges: number;
  /** Layer violation count */
  layerViolationCount: number;
  /** Blocker count */
  blockerCount: number;
  /** Critical issue count */
  criticalCount: number;
  /** Major issue count */
  majorCount: number;
  /** Spec traceability ratio */
  specTraceabilityRatio: number;
  /** Constraint soft failures */
  constraintSoftFailures: number;
}
