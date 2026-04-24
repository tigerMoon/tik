/**
 * @tik/ace
 *
 * ACE Convergence Engine for Tik.
 */

// Main Engine
export { ACEEngine } from './ace-engine.js';
export type { IACEEngine } from './ace-engine.js';

// Fitness
export { FitnessEvaluator } from './fitness/fitness-evaluator.js';

// Drift
export { DriftDetector } from './drift/drift-detector.js';
export type { DriftSnapshot } from './drift/drift-detector.js';

// Entropy
export { EntropyCalculator } from './entropy/entropy-calculator.js';
export type { EntropySnapshot } from './entropy/entropy-calculator.js';

// Convergence
export { ConvergenceGate } from './convergence/convergence-gate.js';

// Planner
export { IterationPlanner } from './planner/iteration-planner.js';
export type {
  IterationPlan,
  PlannedTask,
  PlannedTaskType,
  PlannerInput,
  CandidatePlan,
} from './planner/iteration-planner.js';

// Control
export { StrategyController } from './control/strategy-controller.js';
export type { StrategyRecommendation } from './control/strategy-controller.js';

// Metrics
export { MetricsCollector } from './metrics/metrics-collector.js';
