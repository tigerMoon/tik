/**
 * Execution Kernel (Phase 2.7 - Agent Registry)
 *
 * The main orchestrator of Tik.
 * Wires together: EventBus + TaskManager + ToolScheduler + AgentLoop + SIGHT + ACE
 *
 * Phase 2.7 additions:
 * - AgentRegistry for managing agent specifications
 * - AgentFactory for creating agent runtimes
 * - Agents no longer hardcoded in kernel
 */
import type { Task, TaskResult, CreateTaskInput, ControlCommand, IEventBus, ILLMProvider, IContextBuilder, AgentSession, ExecutionMode } from '@tik/shared';
import { ToolRegistry } from './tool-scheduler.js';
import { TaskManager } from './task-manager.js';
import type { IACEEngine, IContextRenderer, IToolResultStore, StreamChunkHandler } from './agent-loop.js';
import { AgentRegistry } from './agent/agent-registry.js';
import { WorkbenchService } from './workbench/workbench-service.js';
import { EnvironmentPackRegistry } from './environment-pack-registry.js';
export interface KernelConfig {
    llm: ILLMProvider;
    contextBuilder: IContextBuilder;
    ace: IACEEngine;
    projectPath?: string;
    sight?: any;
    contextRenderer?: IContextRenderer;
    toolResultStore?: IToolResultStore;
    onStreamChunk?: StreamChunkHandler;
}
export interface CreateTaskInputV2 extends CreateTaskInput {
    mode?: ExecutionMode;
}
export declare class ExecutionKernel {
    readonly projectPath: string;
    readonly eventBus: IEventBus;
    readonly taskManager: TaskManager;
    readonly toolRegistry: ToolRegistry;
    readonly agentRegistry: AgentRegistry;
    readonly workbench: WorkbenchService;
    readonly environmentPacks: EnvironmentPackRegistry;
    private toolScheduler;
    private llm;
    private contextBuilder;
    private ace;
    private sight?;
    private contextRenderer?;
    private toolResultStore?;
    private onStreamChunk?;
    private agentFactory;
    private activeLoops;
    private pendingControls;
    constructor(config: KernelConfig);
    /**
     * Create a task and start execution.
     * Used by CLI direct mode.
     */
    submitTask(input: CreateTaskInputV2): Promise<TaskResult>;
    /**
     * Run an already-created task.
     * Used by API server (which creates the task first).
     */
    runTask(task: Task, mode?: ExecutionMode): Promise<TaskResult>;
    /**
     * Plan-only mode: generate a plan via LLM without executing tools.
     */
    planTask(input: CreateTaskInput): Promise<Task>;
    /**
     * Send a control command to a running task.
     */
    control(taskId: string, command: ControlCommand): void;
    getTask(taskId: string): Task | undefined;
    listTasks(): Task[];
    getEvents(taskId: string): import("@tik/shared").AgentEvent<unknown>[];
    streamEvents(taskId: string): AsyncIterableIterator<import("@tik/shared").AgentEvent<unknown>>;
    streamAllEvents(): AsyncIterableIterator<import("@tik/shared").AgentEvent<unknown>>;
    /**
     * Get the active session for a task (debug/observation only).
     */
    getSession(taskId: string): AgentSession | undefined;
    dispose(): void;
    private withEnvironmentPackSnapshot;
    private setupRuntimeLogging;
    private createSession;
    private createAgents;
}
//# sourceMappingURL=execution-kernel.d.ts.map