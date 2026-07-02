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
import type { Task, TaskResult, IEventBus, ILLMProvider, IContextBuilder } from '@tik/shared';
import type { IACEEngine } from './agent-loop.js';
import type { ToolScheduler } from './tool-scheduler.js';
export type AgentRole = 'planner' | 'coder' | 'reviewer' | 'tester';
export interface AgentConfig {
    role: AgentRole;
    llmProvider: ILLMProvider;
    /** Optional role-specific system prompt override */
    systemPrompt?: string;
}
export type CoordinatorMode = 'single' | 'multi';
export declare class AgentCoordinator {
    private eventBus;
    private toolScheduler;
    private contextBuilder;
    private aceEngine;
    private agents;
    private mode;
    constructor(eventBus: IEventBus, toolScheduler: ToolScheduler, contextBuilder: IContextBuilder, aceEngine: IACEEngine, mode?: CoordinatorMode);
    /** Register an agent for a specific role */
    registerAgent(config: AgentConfig): void;
    /** Execute a task using the configured agents */
    execute(task: Task, defaultLLM: ILLMProvider): Promise<TaskResult>;
    private executeSingleAgent;
    private executeMultiAgent;
    private emitEvent;
}
//# sourceMappingURL=agent-coordinator.d.ts.map