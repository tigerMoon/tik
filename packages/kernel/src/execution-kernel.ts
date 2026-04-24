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

import type {
  Task,
  TaskResult,
  TaskStatus,
  CreateTaskInput,
  ControlCommand,
  IEventBus,
  ILLMProvider,
  IContextBuilder,
  AgentSession,
  ExecutionMode,
  ChatMessage,
  AgentRole,
} from '@tik/shared';
import { EventType, createEnvironmentPackSelection, generateId, now, toEnvironmentPackSnapshot } from '@tik/shared';
import { EventBus } from './event-bus.js';
import { ToolRegistry, ToolScheduler } from './tool-scheduler.js';
import { TaskManager } from './task-manager.js';
import { AgentLoop } from './agent-loop.js';
import type { IACEEngine, IContextRenderer, IToolResultStore, StreamChunkHandler } from './agent-loop.js';
import { AgentRegistry } from './agent/agent-registry.js';
import { AgentFactory } from './agent/agent-factory.js';
import { AgentRuntime } from './agent/agent-runtime.js';
import { BUILTIN_AGENTS } from './agent/builtin-agents.js';
import { selectCoderAgentId } from './agent/coder-routing.js';
import { WorkbenchStore } from './workbench/workbench-store.js';
import { WorkbenchService } from './workbench/workbench-service.js';
import { shouldRequestDecisionForTool } from './workbench/workbench-decision-policy.js';
import { EnvironmentPackRegistry } from './environment-pack-registry.js';

// ─── Kernel Configuration ────────────────────────────────────

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

// ─── Extended Task Input ─────────────────────────────────────

export interface CreateTaskInputV2 extends CreateTaskInput {
  mode?: ExecutionMode;
}

// ─── Execution Kernel ────────────────────────────────────────

export class ExecutionKernel {
  readonly projectPath: string;
  readonly eventBus: IEventBus;
  readonly taskManager: TaskManager;
  readonly toolRegistry: ToolRegistry;
  readonly agentRegistry: AgentRegistry;
  readonly workbench: WorkbenchService;
  readonly environmentPacks: EnvironmentPackRegistry;
  private toolScheduler: ToolScheduler;
  private llm: ILLMProvider;
  private contextBuilder: IContextBuilder;
  private ace: IACEEngine;
  private sight?: any;
  private contextRenderer?: IContextRenderer;
  private toolResultStore?: IToolResultStore;
  private onStreamChunk?: StreamChunkHandler;
  private agentFactory: AgentFactory;
  private activeLoops: Map<string, { loop: AgentLoop; session?: AgentSession }> = new Map();
  private pendingControls: Map<string, ControlCommand[]> = new Map();

  constructor(config: KernelConfig) {
    this.projectPath = config.projectPath || process.cwd();
    this.eventBus = new EventBus();
    this.taskManager = new TaskManager(this.eventBus);
    this.toolRegistry = new ToolRegistry();
    const workbenchStore = new WorkbenchStore(this.projectPath);
    this.workbench = new WorkbenchService({
      rootPath: this.projectPath,
      eventBus: this.eventBus,
      store: workbenchStore,
    });
    this.toolScheduler = new ToolScheduler(this.toolRegistry, this.eventBus, {
      awaitToolApproval: async ({ taskId, toolName, input }) => {
        if (!shouldRequestDecisionForTool(toolName, input)) {
          return null;
        }

        const decision = await this.workbench.requestToolApproval(taskId, toolName);
        if (!decision) {
          return null;
        }

        const resolution = await this.workbench.waitForDecisionResolution(decision.id);
        return {
          decisionId: decision.id,
          approved: resolution.approved,
          optionId: resolution.decision.recommendedOptionId,
        };
      },
    });
    this.environmentPacks = new EnvironmentPackRegistry(this.projectPath);
    this.llm = config.llm;
    this.contextBuilder = config.contextBuilder;
    this.ace = config.ace;
    this.sight = config.sight;
    this.contextRenderer = config.contextRenderer;
    this.toolResultStore = config.toolResultStore;
    this.onStreamChunk = config.onStreamChunk;

    // Initialize agent registry with builtin agents
    this.agentRegistry = new AgentRegistry();
    for (const spec of BUILTIN_AGENTS) {
      this.agentRegistry.register(spec);
    }

    // Create agent factory
    this.agentFactory = new AgentFactory(this.agentRegistry, () => this.llm);

    // Setup runtime logging if SIGHT is available
    if (this.sight) {
      this.setupRuntimeLogging();
    }
  }

  /**
   * Create a task and start execution.
   * Used by CLI direct mode.
   */
  async submitTask(input: CreateTaskInputV2): Promise<TaskResult> {
    const task = this.taskManager.create(await this.withEnvironmentPackSnapshot(input));
    return this.runTask(task, input.mode);
  }

  /**
   * Run an already-created task.
   * Used by API server (which creates the task first).
   */
  async runTask(task: Task, mode: ExecutionMode = 'single'): Promise<TaskResult> {
    const onPhaseChange = (status: string) => {
      try { this.taskManager.updateStatus(task.id, status as TaskStatus); } catch {}
    };

    const loop = new AgentLoop(
      this.eventBus,
      this.toolScheduler,
      this.contextBuilder,
      this.llm,
      this.ace,
      onPhaseChange,
      this.contextRenderer,
      this.toolResultStore,
      this.onStreamChunk,
    );

    // Create session for session-based execution
    const session = this.createSession(task, mode);
    const queuedControls = this.pendingControls.get(task.id) || [];
    this.pendingControls.delete(task.id);

    for (const command of queuedControls) {
      loop.handleControl(command, session);
    }

    this.activeLoops.set(task.id, { loop, session });

    // Emit session started event
    this.eventBus.emit({
      id: generateId(),
      type: EventType.SESSION_STARTED,
      taskId: task.id,
      payload: {
        sessionId: session.sessionId,
        mode,
        agents: Object.keys(session.agents),
        currentAgent: session.currentAgent,
      },
      timestamp: now(),
    });

    try {
      const initialTaskState = this.taskManager.get(task.id);
      if (initialTaskState && initialTaskState.status !== 'paused' && initialTaskState.status !== 'cancelled') {
        this.taskManager.updateStatus(task.id, 'planning');
      }
      const result = await loop.run(task, session);

      // Final status transition
      const finalTaskState = this.taskManager.get(task.id);
      if (finalTaskState && !['completed', 'converged', 'failed', 'cancelled'].includes(finalTaskState.status)) {
        this.taskManager.updateStatus(task.id, result.status);
      }
      return result;
    } finally {
      this.activeLoops.delete(task.id);
    }
  }

  /**
   * Plan-only mode: generate a plan via LLM without executing tools.
   */
  async planTask(input: CreateTaskInput): Promise<Task> {
    const task = this.taskManager.create(await this.withEnvironmentPackSnapshot(input));
    this.taskManager.updateStatus(task.id, 'planning');

    try {
      const context = await this.contextBuilder.buildContext(task.id, 1, {
        agent: 'planner',
        environmentPackId: task.environmentPackSnapshot?.id,
        environmentPackSelection: task.environmentPackSelection,
      });
      const contextStr = JSON.stringify(context, null, 2);
      const response = await this.llm.plan(
        `Task: ${task.description}\nStrategy: ${task.strategy}`,
        contextStr,
      );
      task.plan = {
        goals: response.goals,
        actions: response.actions.map(a => ({ tool: a.tool, input: a.input, reason: a.reason })),
        riskLevel: 'medium',
        complexity: response.actions.length,
      };
    } catch (err) {
      task.plan = {
        goals: ['Plan generation failed'],
        actions: [],
        riskLevel: 'high',
        complexity: 0,
      };
    }

    return task;
  }

  /**
   * Send a control command to a running task.
   */
  control(taskId: string, command: ControlCommand): void {
    const active = this.activeLoops.get(taskId);
    this.taskManager.handleControl(taskId, command);
    if (active) {
      active.loop.handleControl(command, active.session);
    } else {
      const queued = this.pendingControls.get(taskId) || [];
      queued.push(command);
      this.pendingControls.set(taskId, queued);
    }
  }

  getTask(taskId: string): Task | undefined {
    return this.taskManager.get(taskId);
  }

  listTasks(): Task[] {
    return this.taskManager.list();
  }

  getEvents(taskId: string) {
    return this.eventBus.history(taskId);
  }

  streamEvents(taskId: string) {
    return this.eventBus.stream(taskId);
  }

  streamAllEvents() {
    return this.eventBus.streamAll();
  }

  /**
   * Get the active session for a task (debug/observation only).
   */
  getSession(taskId: string): AgentSession | undefined {
    return this.activeLoops.get(taskId)?.session;
  }

  dispose(): void {
    for (const [taskId] of this.activeLoops) {
      try { this.control(taskId, { type: 'stop' }); } catch {}
    }
    this.eventBus.dispose();
  }

  private async withEnvironmentPackSnapshot<T extends CreateTaskInput>(
    input: T,
  ): Promise<T> {
    if (input.environmentPackSnapshot) {
      return input;
    }

    const activePack = await this.environmentPacks.getActivePack();
    if (!activePack) {
      return input;
    }

    return {
      ...input,
      environmentPackSnapshot: toEnvironmentPackSnapshot(activePack),
      environmentPackSelection: input.environmentPackSelection || createEnvironmentPackSelection(activePack),
    };
  }

  // ─── Runtime Logging Setup ────────────────────────────────

  private setupRuntimeLogging(): void {
    if (!this.sight) return;

    // Record task start
    this.eventBus.on(EventType.TASK_STARTED, async (event) => {
      if (event.payload && typeof event.payload === 'object' && 'status' in event.payload) {
        if (event.payload.status === 'planning') {
          try {
            await this.sight.recordRunStart(event.taskId);
          } catch (err) {
            // Silently fail - logging is non-critical
          }
        }
      }
    });

    // Record tool errors as failures
    this.eventBus.on(EventType.TOOL_ERROR, async (event) => {
      try {
        const payload = event.payload as any;
        await this.sight.recordFailure(
          event.taskId,
          event.taskId, // Use taskId as runId for now
          'build',
          payload.toolName || 'unknown',
          payload.error || 'Tool execution failed',
        );
      } catch (err) {
        // Silently fail
      }
    });

    // Record task completion
    this.eventBus.on(EventType.TASK_COMPLETED, async (event) => {
      try {
        const task = this.taskManager.get(event.taskId);
        if (task) {
          const finalState = task.status === 'converged' ? 'CONVERGED' :
                           task.status === 'completed' ? 'COMPLETED' :
                           task.status === 'failed' ? 'FAILED' : 'MAX_ITERATIONS';
          const finalFitness = task.evaluation?.fitness || 0;
          await this.sight.recordRunEnd(
            event.taskId,
            finalState,
            finalFitness,
            task.iterations.length,
          );
        }
      } catch (err) {
        // Silently fail
      }
    });
  }

  // ─── Session Factory ──────────────────────────────────────

  private createSession(task: Task, mode: ExecutionMode): AgentSession {
    const agents = this.createAgents(task, mode);
    const initialAgent: AgentRole = mode === 'multi' ? 'planner' : 'coder';

    return {
      sessionId: generateId(),
      taskId: task.id,
      messages: [
        { role: 'user', content: `Task: ${task.description}` } as ChatMessage,
      ],
      loopState: 'running',
      mode,
      agents,
      currentAgent: initialAgent,
      step: 0,
    };
  }

  private createAgents(task: Task, mode: ExecutionMode): Partial<Record<AgentRole, AgentRuntime>> {
    const coder = this.agentFactory.create(selectCoderAgentId(task.description, task.projectPath));

    if (mode === 'single') {
      return { coder };
    }

    return {
      planner: this.agentFactory.create('planner'),
      coder,
      reviewer: this.agentFactory.create('reviewer'),
    };
  }
}
