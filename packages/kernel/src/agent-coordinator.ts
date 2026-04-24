/**
 * Agent Coordinator
 *
 * Multi-agent orchestration layer.
 * Routes tasks to specialized agent roles and coordinates execution.
 *
 * Roles:
 * - planner: generates the initial plan
 * - coder: executes implementation actions
 * - reviewer: validates results
 * - tester: runs tests
 *
 * In single-agent mode (default), all roles are handled by one AgentLoop.
 */

import type {
  Task,
  TaskResult,
  Plan,
  IEventBus,
  ILLMProvider,
  IContextBuilder,
} from '@tik/shared';
import { EventType, generateId, now } from '@tik/shared';
import { AgentLoop } from './agent-loop.js';
import type { IACEEngine } from './agent-loop.js';
import type { ToolScheduler } from './tool-scheduler.js';

// ─── Agent Role ──────────────────────────────────────────────

export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'tester';

export interface AgentConfig {
  role: AgentRole;
  llmProvider: ILLMProvider;
  /** Optional role-specific system prompt override */
  systemPrompt?: string;
}

// ─── Coordinator Mode ────────────────────────────────────────

export type CoordinatorMode = 'single' | 'multi';

// ─── Agent Coordinator ──────────────────────────────────────

export class AgentCoordinator {
  private eventBus: IEventBus;
  private toolScheduler: ToolScheduler;
  private contextBuilder: IContextBuilder;
  private aceEngine: IACEEngine;
  private agents: Map<AgentRole, AgentConfig> = new Map();
  private mode: CoordinatorMode;

  constructor(
    eventBus: IEventBus,
    toolScheduler: ToolScheduler,
    contextBuilder: IContextBuilder,
    aceEngine: IACEEngine,
    mode: CoordinatorMode = 'single',
  ) {
    this.eventBus = eventBus;
    this.toolScheduler = toolScheduler;
    this.contextBuilder = contextBuilder;
    this.aceEngine = aceEngine;
    this.mode = mode;
  }

  /** Register an agent for a specific role */
  registerAgent(config: AgentConfig): void {
    this.agents.set(config.role, config);
  }

  /** Execute a task using the configured agents */
  async execute(task: Task, defaultLLM: ILLMProvider): Promise<TaskResult> {
    if (this.mode === 'single' || this.agents.size === 0) {
      return this.executeSingleAgent(task, defaultLLM);
    }
    return this.executeMultiAgent(task, defaultLLM);
  }

  // ─── Single Agent Mode ────────────────────────────────────

  private async executeSingleAgent(task: Task, llm: ILLMProvider): Promise<TaskResult> {
    const loop = new AgentLoop(
      this.eventBus,
      this.toolScheduler,
      this.contextBuilder,
      llm,
      this.aceEngine,
    );
    return loop.run(task);
  }

  // ─── Multi Agent Mode ─────────────────────────────────────

  private async executeMultiAgent(task: Task, defaultLLM: ILLMProvider): Promise<TaskResult> {
    this.emitEvent('agent.coordination_started', task.id, {
      mode: 'multi',
      agents: Array.from(this.agents.keys()),
    });

    // Phase 1: Planner agent generates the plan
    const plannerLLM = this.agents.get('planner')?.llmProvider || defaultLLM;
    const plannerLoop = new AgentLoop(
      this.eventBus,
      this.toolScheduler,
      this.contextBuilder,
      plannerLLM,
      this.aceEngine,
    );

    // Run planner for 1 iteration to get the plan
    const planTask = { ...task, maxIterations: 1 };
    const planResult = await plannerLoop.run(planTask);

    if (planResult.status === 'failed' || task.iterations.length === 0) {
      return planResult;
    }

    this.emitEvent('agent.plan_delegated', task.id, {
      fromAgent: 'planner',
      toAgent: 'coder',
    });

    // Phase 2: Coder agent executes the remaining iterations
    const coderLLM = this.agents.get('coder')?.llmProvider || defaultLLM;
    const coderLoop = new AgentLoop(
      this.eventBus,
      this.toolScheduler,
      this.contextBuilder,
      coderLLM,
      this.aceEngine,
    );

    // Coder gets remaining iterations
    const coderTask = { ...task, maxIterations: task.maxIterations - 1 };
    const coderResult = await coderLoop.run(coderTask);

    // Phase 3: Reviewer agent validates (if available)
    if (this.agents.has('reviewer') && coderResult.status !== 'failed') {
      const reviewerLLM = this.agents.get('reviewer')!.llmProvider;

      this.emitEvent('agent.review_started', task.id, {
        fromAgent: 'coder',
        toAgent: 'reviewer',
      });

      const reviewerLoop = new AgentLoop(
        this.eventBus,
        this.toolScheduler,
        this.contextBuilder,
        reviewerLLM,
        this.aceEngine,
      );

      const reviewTask = {
        ...task,
        description: `Review the changes made for: ${task.description}`,
        maxIterations: 1,
      };
      await reviewerLoop.run(reviewTask);
    }

    this.emitEvent('agent.coordination_completed', task.id, {
      finalStatus: coderResult.status,
      totalIterations: coderResult.totalIterations + 1, // +1 for planner
    });

    return coderResult;
  }

  // ─── Helper ───────────────────────────────────────────────

  private emitEvent(type: string, taskId: string, payload: unknown): void {
    this.eventBus.emit({
      id: generateId(),
      type: type as any,
      taskId,
      payload,
      timestamp: now(),
    });
  }
}
