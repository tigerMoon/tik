/**
 * SIGHT Runtime (Agent Context Layer)
 *
 * High-level API for agents to interact with the SIGHT system.
 * Provides unified access to context, memory, and adaptive feedback.
 */
import { ContextEngine } from '../context/context-engine.js';
import { MemoryEngine } from '../memory/memory-engine.js';
import { AdaptiveContextInjector } from '../adaptive/adaptive-context.js';
import { PluginRegistry } from '../plugin/registry.js';
import { LocalContextProvider } from '../plugin/local-provider.js';
import { ContextGraph } from '../graph/context-graph.js';
// ─── SIGHT Runtime ───────────────────────────────────────────
export class SIGHTRuntime {
    contextEngine;
    memoryEngine;
    contextGraph;
    adaptiveInjector;
    pluginRegistry;
    config;
    constructor(config) {
        this.config = config;
        this.contextEngine = new ContextEngine(config.projectPath, config.eventBus);
        this.memoryEngine = new MemoryEngine(config.projectPath);
        this.contextGraph = new ContextGraph();
        this.adaptiveInjector = new AdaptiveContextInjector();
        this.pluginRegistry = new PluginRegistry();
        // Register default local provider
        const localProvider = new LocalContextProvider();
        this.contextEngine.addProvider(localProvider);
    }
    // ── Context API ───────────────────────────────────────────
    /** Build unified agent context */
    async getAgentContext(taskId, iteration) {
        return this.contextEngine.buildContext(taskId, iteration);
    }
    // ── Memory API ────────────────────────────────────────────
    /** Record a run start */
    async recordRunStart(taskId, featureName) {
        return this.memoryEngine.recordRun({
            taskId,
            featureName,
            iterations: 0,
            finalState: 'NOT_CONVERGED',
            finalFitness: 0,
            startedAt: Date.now(),
            completedAt: 0,
        });
    }
    /** Record a run completion */
    async recordRunEnd(taskId, finalState, finalFitness, iterations) {
        return this.memoryEngine.recordRun({
            taskId,
            iterations,
            finalState,
            finalFitness,
            startedAt: 0,
            completedAt: Date.now(),
        });
    }
    /** Record a failure */
    async recordFailure(taskId, runId, type, target, message) {
        return this.memoryEngine.recordFailure({
            taskId,
            runId,
            type,
            target,
            message,
            timestamp: Date.now(),
        });
    }
    /** Record an architectural decision */
    async recordDecision(taskId, type, description, rationale, impact) {
        return this.memoryEngine.recordDecision({
            taskId,
            type,
            description,
            rationale,
            impact,
            timestamp: Date.now(),
        });
    }
    /** Get learning insights */
    async getInsights() {
        return this.memoryEngine.getInsights();
    }
    // ── Adaptive Feedback API ─────────────────────────────────
    /** Record feedback from execution */
    recordFeedback(event) {
        this.adaptiveInjector.recordFeedback(event);
    }
    /** Get adaptive fragments for next iteration */
    getAdaptiveFragments(lastIteration) {
        return this.adaptiveInjector.getAdaptiveFragments(lastIteration);
    }
    // ── Graph API ─────────────────────────────────────────────
    /** Get the context graph */
    getGraph() {
        return this.contextGraph;
    }
    // ── Lifecycle ─────────────────────────────────────────────
    async dispose() {
        await this.pluginRegistry.dispose();
    }
}
//# sourceMappingURL=sight-runtime.js.map