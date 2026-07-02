/**
 * SIGHT Runtime (Agent Context Layer)
 *
 * High-level API for agents to interact with the SIGHT system.
 * Provides unified access to context, memory, and adaptive feedback.
 */
import type { AgentContext, IEventBus } from '@tik/shared';
import { ContextEngine } from '../context/context-engine.js';
import { MemoryEngine } from '../memory/memory-engine.js';
import { AdaptiveContextInjector } from '../adaptive/adaptive-context.js';
import type { FeedbackEvent } from '../adaptive/adaptive-context.js';
import { PluginRegistry } from '../plugin/registry.js';
import { ContextGraph } from '../graph/context-graph.js';
export interface SIGHTConfig {
    projectPath: string;
    eventBus?: IEventBus;
    plugin?: string;
}
export declare class SIGHTRuntime {
    readonly contextEngine: ContextEngine;
    readonly memoryEngine: MemoryEngine;
    readonly contextGraph: ContextGraph;
    readonly adaptiveInjector: AdaptiveContextInjector;
    readonly pluginRegistry: PluginRegistry;
    private config;
    constructor(config: SIGHTConfig);
    /** Build unified agent context */
    getAgentContext(taskId: string, iteration: number): Promise<AgentContext>;
    /** Record a run start */
    recordRunStart(taskId: string, featureName?: string): Promise<import("../memory/memory-engine.js").RunMemoryEntry>;
    /** Record a run completion */
    recordRunEnd(taskId: string, finalState: 'CONVERGED' | 'FAILED' | 'MAX_ITERATIONS', finalFitness: number, iterations: number): Promise<import("../memory/memory-engine.js").RunMemoryEntry>;
    /** Record a failure */
    recordFailure(taskId: string, runId: string, type: 'test' | 'build' | 'review' | 'constraint' | 'drift' | 'entropy', target: string, message: string): Promise<import("../memory/memory-engine.js").FailureMemoryEntry>;
    /** Record an architectural decision */
    recordDecision(taskId: string, type: 'architecture' | 'refactoring' | 'complexity' | 'api', description: string, rationale: string, impact: {
        fitnessChange: number;
        driftChange: number;
        entropyChange: number;
    }): Promise<import("../memory/memory-engine.js").DecisionMemoryEntry>;
    /** Get learning insights */
    getInsights(): Promise<import("../memory/memory-engine.js").LearningInsights>;
    /** Record feedback from execution */
    recordFeedback(event: FeedbackEvent): void;
    /** Get adaptive fragments for next iteration */
    getAdaptiveFragments(lastIteration: number): import("../index.js").ContextFragment[];
    /** Get the context graph */
    getGraph(): ContextGraph;
    dispose(): Promise<void>;
}
//# sourceMappingURL=sight-runtime.d.ts.map