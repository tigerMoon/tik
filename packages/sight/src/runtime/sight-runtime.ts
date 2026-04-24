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
import { LocalContextProvider } from '../plugin/local-provider.js';
import { ContextGraph } from '../graph/context-graph.js';

// ─── SIGHT Config ────────────────────────────────────────────

export interface SIGHTConfig {
  projectPath: string;
  eventBus?: IEventBus;
  plugin?: string; // 'local' | 'letta'
}

// ─── SIGHT Runtime ───────────────────────────────────────────

export class SIGHTRuntime {
  readonly contextEngine: ContextEngine;
  readonly memoryEngine: MemoryEngine;
  readonly contextGraph: ContextGraph;
  readonly adaptiveInjector: AdaptiveContextInjector;
  readonly pluginRegistry: PluginRegistry;

  private config: SIGHTConfig;

  constructor(config: SIGHTConfig) {
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
  async getAgentContext(taskId: string, iteration: number): Promise<AgentContext> {
    return this.contextEngine.buildContext(taskId, iteration);
  }

  // ── Memory API ────────────────────────────────────────────

  /** Record a run start */
  async recordRunStart(taskId: string, featureName?: string) {
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
  async recordRunEnd(
    taskId: string,
    finalState: 'CONVERGED' | 'FAILED' | 'MAX_ITERATIONS',
    finalFitness: number,
    iterations: number,
  ) {
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
  async recordFailure(
    taskId: string,
    runId: string,
    type: 'test' | 'build' | 'review' | 'constraint' | 'drift' | 'entropy',
    target: string,
    message: string,
  ) {
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
  async recordDecision(
    taskId: string,
    type: 'architecture' | 'refactoring' | 'complexity' | 'api',
    description: string,
    rationale: string,
    impact: { fitnessChange: number; driftChange: number; entropyChange: number },
  ) {
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
  recordFeedback(event: FeedbackEvent): void {
    this.adaptiveInjector.recordFeedback(event);
  }

  /** Get adaptive fragments for next iteration */
  getAdaptiveFragments(lastIteration: number) {
    return this.adaptiveInjector.getAdaptiveFragments(lastIteration);
  }

  // ── Graph API ─────────────────────────────────────────────

  /** Get the context graph */
  getGraph(): ContextGraph {
    return this.contextGraph;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async dispose(): Promise<void> {
    await this.pluginRegistry.dispose();
  }
}
