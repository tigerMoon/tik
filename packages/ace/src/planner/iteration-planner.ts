/**
 * Iteration Planner
 *
 * Generates iteration plans based on evaluation metrics and failures.
 * Includes multi-plan search (3 candidates) for optimal convergence.
 */

import type {
  FitnessResult,
  DriftResult,
  EntropyResult,
  ConvergenceStrategy,
} from '@tik/shared';

// ─── Plan Types ──────────────────────────────────────────────

export type PlannedTaskType =
  | 'FIX_TEST'
  | 'FIX_BUILD'
  | 'FIX_CONSTRAINT'
  | 'REDUCE_DRIFT'
  | 'REDUCE_COMPLEXITY'
  | 'IMPROVE_COVERAGE'
  | 'FIX_LAYER_VIOLATION'
  | 'GENERAL_IMPROVEMENT';

export interface IterationPlan {
  /** Plan goals */
  goals: string[];
  /** Ordered tasks */
  tasks: PlannedTask[];
  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high';
  /** Strategy used */
  strategy: ConvergenceStrategy;
  /** Estimated fitness improvement */
  estimatedImprovement: number;
}

export interface PlannedTask {
  type: PlannedTaskType;
  description: string;
  priority: number;
  target?: string;
  estimatedImpact: number;
}

export interface PlannerInput {
  fitness: FitnessResult;
  drift: DriftResult;
  entropy: EntropyResult;
  failures: Array<{ type: string; target: string; message: string }>;
  iteration: number;
  maxIterations: number;
  strategy: ConvergenceStrategy;
}

// ─── Candidate Plan (Multi-Plan Search) ──────────────────────

export interface CandidatePlan {
  plan: IterationPlan;
  score: number;
  reasoning: string;
}

// ─── Iteration Planner ──────────────────────────────────────

export class IterationPlanner {
  /**
   * Generate an iteration plan from current metrics.
   * Uses multi-plan search to find optimal strategy.
   */
  generatePlan(input: PlannerInput): IterationPlan {
    const candidates = this.searchCandidates(input);
    // Select best candidate
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].plan;
  }

  /**
   * Multi-plan search: generate 3 candidates and score them.
   */
  searchCandidates(input: PlannerInput): CandidatePlan[] {
    const candidates: CandidatePlan[] = [];

    // Candidate 1: Fix-first (prioritize blocking issues)
    candidates.push(this.generateFixFirstPlan(input));

    // Candidate 2: Quality-first (prioritize overall quality)
    candidates.push(this.generateQualityFirstPlan(input));

    // Candidate 3: Balanced (mix of fixes and improvements)
    candidates.push(this.generateBalancedPlan(input));

    return candidates;
  }

  private generateFixFirstPlan(input: PlannerInput): CandidatePlan {
    const tasks: PlannedTask[] = [];
    const goals: string[] = [];

    // Priority 1: Fix build failures
    if (!input.fitness.criticalGatesPassed) {
      tasks.push({
        type: 'FIX_BUILD',
        description: 'Fix build failures to pass critical gates',
        priority: 10,
        estimatedImpact: 0.3,
      });
      goals.push('Fix build failures');
    }

    // Priority 2: Fix test failures
    for (const failure of input.failures.filter(f => f.type === 'test')) {
      tasks.push({
        type: 'FIX_TEST',
        description: `Fix test failure: ${failure.message}`,
        priority: 9,
        target: failure.target,
        estimatedImpact: 0.1,
      });
    }
    if (tasks.some(t => t.type === 'FIX_TEST')) {
      goals.push('Fix failing tests');
    }

    // Priority 3: Fix constraint violations
    for (const failure of input.failures.filter(f => f.type === 'constraint')) {
      tasks.push({
        type: 'FIX_CONSTRAINT',
        description: `Fix constraint: ${failure.message}`,
        priority: 8,
        target: failure.target,
        estimatedImpact: 0.05,
      });
    }

    // Priority 4: Reduce drift if needed
    if (input.drift.magnitude >= 3.0) {
      tasks.push({
        type: 'REDUCE_DRIFT',
        description: `Reduce structural drift (current: ${input.drift.magnitude.toFixed(1)})`,
        priority: 7,
        estimatedImpact: 0.1,
      });
      goals.push('Reduce structural drift');
    }

    if (goals.length === 0) goals.push('General improvements');

    const plan: IterationPlan = {
      goals,
      tasks: tasks.sort((a, b) => b.priority - a.priority),
      riskLevel: tasks.some(t => t.priority >= 9) ? 'high' : 'medium',
      strategy: input.strategy,
      estimatedImprovement: tasks.reduce((sum, t) => sum + t.estimatedImpact, 0),
    };

    return {
      plan,
      score: this.scorePlan(plan, input),
      reasoning: 'Fix-first: Prioritize blocking issues for faster convergence',
    };
  }

  private generateQualityFirstPlan(input: PlannerInput): CandidatePlan {
    const tasks: PlannedTask[] = [];
    const goals: string[] = ['Improve overall code quality'];

    // Improve coverage
    const qualityComponent = input.fitness.components.find(c => c.name === 'quality');
    if (qualityComponent && qualityComponent.score < 0.8) {
      tasks.push({
        type: 'IMPROVE_COVERAGE',
        description: 'Add test coverage for untested code paths',
        priority: 8,
        estimatedImpact: 0.15,
      });
    }

    // Reduce complexity
    if (input.entropy.delta > 0.3) {
      tasks.push({
        type: 'REDUCE_COMPLEXITY',
        description: 'Refactor complex code to reduce entropy',
        priority: 7,
        estimatedImpact: 0.1,
      });
      goals.push('Reduce code complexity');
    }

    // Fix layer violations
    for (const dim of input.drift.dimensions.filter(d => d.name === 'architecture' && d.exceeded)) {
      tasks.push({
        type: 'FIX_LAYER_VIOLATION',
        description: 'Fix architecture layer violations',
        priority: 6,
        estimatedImpact: 0.08,
      });
    }

    // Always include test fixes
    for (const failure of input.failures.filter(f => f.type === 'test').slice(0, 3)) {
      tasks.push({
        type: 'FIX_TEST',
        description: `Fix: ${failure.message}`,
        priority: 9,
        target: failure.target,
        estimatedImpact: 0.1,
      });
    }

    const plan: IterationPlan = {
      goals,
      tasks: tasks.sort((a, b) => b.priority - a.priority),
      riskLevel: 'medium',
      strategy: input.strategy,
      estimatedImprovement: tasks.reduce((sum, t) => sum + t.estimatedImpact, 0),
    };

    return {
      plan,
      score: this.scorePlan(plan, input),
      reasoning: 'Quality-first: Focus on long-term quality improvement',
    };
  }

  private generateBalancedPlan(input: PlannerInput): CandidatePlan {
    const tasks: PlannedTask[] = [];
    const goals: string[] = ['Balanced improvement across all dimensions'];

    // Mix of fixes and improvements
    // Take top 2 failures
    for (const failure of input.failures.slice(0, 2)) {
      const type: PlannedTaskType = failure.type === 'test' ? 'FIX_TEST' :
        failure.type === 'build' ? 'FIX_BUILD' :
        failure.type === 'constraint' ? 'FIX_CONSTRAINT' : 'GENERAL_IMPROVEMENT';

      tasks.push({
        type,
        description: `Fix: ${failure.message}`,
        priority: 8,
        target: failure.target,
        estimatedImpact: 0.1,
      });
    }

    // One improvement task
    if (input.drift.magnitude > 2.0) {
      tasks.push({
        type: 'REDUCE_DRIFT',
        description: 'Minor drift reduction',
        priority: 5,
        estimatedImpact: 0.05,
      });
    }

    if (input.entropy.delta > 0.2) {
      tasks.push({
        type: 'REDUCE_COMPLEXITY',
        description: 'Minor complexity reduction',
        priority: 5,
        estimatedImpact: 0.05,
      });
    }

    const plan: IterationPlan = {
      goals,
      tasks: tasks.sort((a, b) => b.priority - a.priority),
      riskLevel: 'low',
      strategy: input.strategy,
      estimatedImprovement: tasks.reduce((sum, t) => sum + t.estimatedImpact, 0),
    };

    return {
      plan,
      score: this.scorePlan(plan, input),
      reasoning: 'Balanced: Even split between fixes and improvements',
    };
  }

  private scorePlan(plan: IterationPlan, input: PlannerInput): number {
    let score = 0;

    // Higher improvement estimate = better
    score += plan.estimatedImprovement * 3;

    // Lower risk = better (for defensive strategy)
    if (input.strategy === 'defensive') {
      score += plan.riskLevel === 'low' ? 0.3 : plan.riskLevel === 'medium' ? 0.1 : -0.2;
    }

    // More tasks addressing failures = better
    const failureTaskCount = plan.tasks.filter(
      t => t.type.startsWith('FIX_'),
    ).length;
    score += failureTaskCount * 0.1;

    // Penalize plans with too many tasks (parallelism limit)
    if (plan.tasks.length > 5) {
      score -= (plan.tasks.length - 5) * 0.05;
    }

    return score;
  }
}
