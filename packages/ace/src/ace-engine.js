/**
 * ACE Engine
 *
 * The main ACE (Autonomous Convergence Engine) that orchestrates
 * fitness evaluation, drift detection, entropy control, and convergence.
 */
import { EventType, generateId, now } from '@tik/shared';
import { FitnessEvaluator } from './fitness/fitness-evaluator.js';
import { DriftDetector } from './drift/drift-detector.js';
import { EntropyCalculator } from './entropy/entropy-calculator.js';
import { ConvergenceGate } from './convergence/convergence-gate.js';
import { IterationPlanner } from './planner/iteration-planner.js';
import { MetricsCollector } from './metrics/metrics-collector.js';
// ─── ACE Engine ──────────────────────────────────────────────
export class ACEEngine {
    fitnessEvaluator;
    driftDetector;
    entropyCalculator;
    convergenceGate;
    planner;
    metricsCollector;
    eventBus;
    iterationMetrics = new Map();
    driftBaselines = new Map();
    entropyBaselines = new Map();
    constructor(strategy = 'incremental', eventBus) {
        this.fitnessEvaluator = new FitnessEvaluator();
        this.driftDetector = new DriftDetector();
        this.entropyCalculator = new EntropyCalculator();
        this.convergenceGate = new ConvergenceGate(strategy);
        this.planner = new IterationPlanner();
        this.metricsCollector = new MetricsCollector(eventBus);
        this.eventBus = eventBus;
    }
    /**
     * Evaluate a single iteration.
     * In production, metrics would be collected from actual test/build results.
     * This provides the evaluation pipeline structure.
     */
    async evaluateIteration(taskId, iteration) {
        // Get metrics for this task (in real use, these come from actual execution)
        const metrics = this.getOrCreateMetrics(taskId, iteration);
        // Step 1: Fitness evaluation
        const fitness = this.fitnessEvaluator.evaluate(metrics);
        this.emitEvent(EventType.FITNESS_CALCULATED, taskId, {
            iteration,
            score: fitness.score,
            components: fitness.components.map(c => ({ name: c.name, score: c.score })),
            criticalGatesPassed: fitness.criticalGatesPassed,
        });
        // Step 2: Drift detection
        const currentDrift = this.getCurrentDriftSnapshot(taskId);
        const baselineDrift = this.driftBaselines.get(taskId) || currentDrift;
        const drift = this.driftDetector.detect(currentDrift, baselineDrift);
        this.emitEvent(EventType.DRIFT_DETECTED, taskId, {
            iteration,
            magnitude: drift.magnitude,
            trend: drift.trend,
            dimensions: drift.dimensions.map(d => ({ name: d.name, value: d.value, exceeded: d.exceeded })),
        });
        // Step 3: Entropy calculation
        const currentEntropy = this.getCurrentEntropySnapshot(taskId);
        const baselineEntropy = this.entropyBaselines.get(taskId) || currentEntropy;
        const entropy = this.entropyCalculator.calculate(currentEntropy, baselineEntropy);
        this.emitEvent(EventType.ENTROPY_CALCULATED, taskId, {
            iteration,
            delta: entropy.delta,
            budgetRemaining: entropy.budgetRemaining,
        });
        // Step 4: Apply penalties
        const driftPenalty = this.driftDetector.applyPenalty(drift.magnitude);
        const entropyPenalty = this.entropyCalculator.applyPenalty(entropy.delta);
        const penalizedFitness = fitness.score * driftPenalty * entropyPenalty;
        // Store baseline for first iteration
        if (iteration === 1) {
            this.driftBaselines.set(taskId, currentDrift);
            this.entropyBaselines.set(taskId, currentEntropy);
        }
        return {
            fitness: penalizedFitness,
            drift: drift.magnitude,
            entropy: entropy.delta,
            converged: false, // Determined by checkConvergence
            stableCount: 0, // Tracked externally
            breakdown: {
                quality: fitness.components.find(c => c.name === 'quality')?.score || 0,
                correctness: fitness.components.find(c => c.name === 'correctness')?.score || 0,
                stability: fitness.components.find(c => c.name === 'stability')?.score || 0,
                complexity: fitness.components.find(c => c.name === 'complexity')?.score || 0,
            },
        };
    }
    /**
     * Check convergence criteria.
     */
    checkConvergence(evaluation, stableCount, strategy) {
        this.convergenceGate.setStrategy(strategy);
        const fitness = this.fitnessEvaluator.evaluate(this.createMetricsFromSnapshot(evaluation));
        const drift = {
            magnitude: evaluation.drift,
            dimensions: [],
            trend: 'stable',
        };
        const entropy = {
            delta: evaluation.entropy,
            dimensions: [],
            budgetRemaining: Math.max(0, 0.5 - evaluation.entropy),
        };
        const result = this.convergenceGate.check(fitness, drift, entropy, stableCount);
        return result.converged;
    }
    /**
     * Record metrics for a task iteration.
     */
    recordMetrics(taskId, metrics) {
        if (!this.iterationMetrics.has(taskId)) {
            this.iterationMetrics.set(taskId, []);
        }
        this.iterationMetrics.get(taskId).push(metrics);
    }
    // ─── Private Methods ──────────────────────────────────────
    getOrCreateMetrics(taskId, _iteration) {
        // First check if metrics were manually recorded
        const history = this.iterationMetrics.get(taskId) || [];
        if (history.length >= _iteration) {
            return history[_iteration - 1];
        }
        // Use real metrics from MetricsCollector (collected from tool execution events)
        return this.metricsCollector.getMetrics(taskId);
    }
    getCurrentDriftSnapshot(taskId) {
        // Build drift snapshot from real tool execution data
        const metrics = this.metricsCollector.getMetrics(taskId);
        return {
            interfaces: metrics.breakingChanges > 0 ? ['api-change'] : [],
            dtos: [],
            dependencies: metrics.newDependencies > 0
                ? Array.from({ length: metrics.newDependencies }, (_, i) => `dep-${i}`)
                : [],
            complexityMetrics: {
                delta: metrics.complexityDelta,
                churn: metrics.codeChurnRatio,
            },
            conventions: metrics.layerViolationCount > 0 ? ['layer-violation'] : [],
            layerBoundaries: metrics.layerViolationCount > 0
                ? Array.from({ length: metrics.layerViolationCount }, (_, i) => `violation-${i}`)
                : [],
        };
    }
    getCurrentEntropySnapshot(taskId) {
        // Build entropy snapshot from real tool execution data
        const metrics = this.metricsCollector.getMetrics(taskId);
        const data = this.metricsCollector.iterationResults?.get(taskId);
        const filesRead = data?.filesRead || 0;
        const filesModified = data?.filesModified || 0;
        const successCount = data?.successCount || 0;
        const failureCount = data?.failureCount || 0;
        return {
            complexityDistribution: {
                reads: filesRead,
                writes: filesModified,
                complexity: metrics.complexityDelta,
            },
            dependencyDistribution: {
                existing: 10, // base
                new: metrics.newDependencies,
            },
            changeDistribution: {
                success: successCount,
                failure: failureCount,
                modified: filesModified,
            },
        };
    }
    createMetricsFromSnapshot(snapshot) {
        return {
            buildSuccess: true,
            coverageRatio: snapshot.breakdown?.quality || 0.5,
            integrationTestPassRate: snapshot.breakdown?.correctness || 0.8,
            codeChurnRatio: 1 - (snapshot.breakdown?.stability || 0.5),
            complexityDelta: 0,
            newDependencies: 0,
            breakingChanges: 0,
            layerViolationCount: 0,
            blockerCount: 0,
            criticalCount: 0,
            majorCount: 0,
            specTraceabilityRatio: 0.7,
            constraintSoftFailures: 0,
        };
    }
    emitEvent(type, taskId, payload) {
        if (!this.eventBus)
            return;
        this.eventBus.emit({
            id: generateId(),
            type,
            taskId,
            payload,
            timestamp: now(),
        });
    }
}
//# sourceMappingURL=ace-engine.js.map