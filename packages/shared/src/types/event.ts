/**
 * Event System Types
 *
 * All state changes in Tik are expressed through events.
 * Events are the single source of truth (SSOT) for system state.
 */

// ─── Event Types ─────────────────────────────────────────────

export enum EventType {
  // Task lifecycle
  TASK_CREATED = 'task.created',
  TASK_STARTED = 'task.started',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  TASK_CANCELLED = 'task.cancelled',
  TASK_PAUSED = 'task.paused',
  TASK_RESUMED = 'task.resumed',

  // Planning
  PLAN_STARTED = 'plan.started',
  PLAN_GENERATED = 'plan.generated',
  PLAN_UPDATED = 'plan.updated',

  // Tool execution
  EXECUTION_STARTED = 'execution.started',
  TOOL_CALLED = 'tool.called',
  TOOL_RESULT = 'tool.result',
  TOOL_ERROR = 'tool.error',

  // Context (SIGHT)
  CONTEXT_BUILT = 'context.built',
  CONTEXT_UPDATED = 'context.updated',
  MEMORY_RECORDED = 'memory.recorded',

  // Evaluation (ACE)
  EVALUATION_STARTED = 'evaluation.started',
  EVALUATED = 'evaluation.completed',
  FITNESS_CALCULATED = 'evaluation.fitness',
  DRIFT_DETECTED = 'evaluation.drift',
  ENTROPY_CALCULATED = 'evaluation.entropy',

  // Convergence
  ITERATION_STARTED = 'iteration.started',
  ITERATION_COMPLETED = 'iteration.completed',
  CONVERGED = 'convergence.achieved',
  DIVERGED = 'convergence.failed',

  // Human-in-the-loop
  HUMAN_INTERVENTION = 'human.intervention',
  CONTROL_RECEIVED = 'human.control',
  CONSTRAINT_INJECTED = 'human.constraint',
  STRATEGY_CHANGED = 'human.strategy',

  // Session (Phase 2)
  SESSION_STARTED = 'session.started',
  SESSION_MESSAGE = 'session.message',
  SESSION_USAGE = 'session.usage',
  AGENT_SWITCHED = 'session.agent_switched',

  // System
  ERROR = 'system.error',
  WARNING = 'system.warning',
}

// ─── Event Model ─────────────────────────────────────────────

export interface AgentEvent<T = unknown> {
  /** Unique event ID */
  id: string;
  /** Event type */
  type: EventType;
  /** Associated task ID */
  taskId: string;
  /** Event payload (type-specific) */
  payload: T;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ─── Event Payloads ──────────────────────────────────────────

export interface ToolCalledPayload {
  toolName: string;
  toolType: string;
  input: unknown;
  approvalDecisionId?: string;
}

export interface ToolResultPayload {
  toolName: string;
  output: unknown;
  durationMs: number;
  success: boolean;
  error?: string;
  filesModified?: string[];
  truncated?: boolean;
  originalSize?: number;
}

export interface EvaluationPayload {
  iteration: number;
  fitness: number;
  drift: number;
  entropy: number;
  converged: boolean;
}

export interface PlanPayload {
  goals: string[];
  actions: Array<{
    tool: string;
    input: unknown;
    reason: string;
  }>;
  strategy: string;
}

export interface HumanInterventionPayload {
  action: 'stop' | 'modify_plan' | 'inject_constraint' | 'change_strategy';
  detail: unknown;
}

// ─── EventBus Interface ─────────────────────────────────────

export type EventHandler<T = unknown> = (event: AgentEvent<T>) => void | Promise<void>;
export type UnsubscribeFn = () => void;

export interface IEventBus {
  /** Emit an event to all subscribers */
  emit(event: AgentEvent): void;

  /** Subscribe to a specific event type */
  on(type: EventType, handler: EventHandler): UnsubscribeFn;

  /** Subscribe to all events */
  onAny(handler: EventHandler): UnsubscribeFn;

  /** Get an async iterator of events for a specific task */
  stream(taskId: string): AsyncIterableIterator<AgentEvent>;

  /** Get an async iterator of all events across tasks */
  streamAll(): AsyncIterableIterator<AgentEvent>;

  /** Get event history for a task */
  history(taskId: string): AgentEvent[];

  /** Clear all subscriptions */
  dispose(): void;
}
