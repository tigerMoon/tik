/**
 * Task Manager
 *
 * Manages task lifecycle: create, start, pause, resume, cancel.
 * Maintains task state and enforces state transitions.
 *
 * State machine:
 *   pending → planning → executing → evaluating → completed/converged
 *                                  ↗                        ↘ failed
 *   planning/executing/evaluating → cancelled
 *   planning/executing/evaluating → paused → executing
 */

import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  ControlCommand,
  IEventBus,
} from '@tik/shared';
import { EventType, generateTaskId, now } from '@tik/shared';

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private eventBus: IEventBus;

  constructor(eventBus: IEventBus) {
    this.eventBus = eventBus;
  }

  create(input: CreateTaskInput): Task {
    const task: Task = {
      id: generateTaskId(),
      description: input.description,
      status: 'pending',
      projectPath: input.projectPath,
      iterations: [],
      maxIterations: input.maxIterations || 5,
      strategy: input.strategy || 'incremental',
      createdAt: now(),
      updatedAt: now(),
      environmentPackSnapshot: input.environmentPackSnapshot,
      environmentPackSelection: input.environmentPackSelection,
      workspaceBinding: input.workspaceBinding,
    };

    this.tasks.set(task.id, task);

    this.emitEvent(EventType.TASK_CREATED, task.id, task);
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  updateEnvironmentPackSelection(
    taskId: string,
    selection: NonNullable<Task['environmentPackSelection']>,
    snapshot?: Task['environmentPackSnapshot'],
  ): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    task.environmentPackSelection = selection;
    if (snapshot) {
      task.environmentPackSnapshot = snapshot;
    }
    task.updatedAt = now();
    return task;
  }

  updateDescription(taskId: string, description: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    task.description = description;
    task.updatedAt = now();
    return task;
  }

  updateStatus(taskId: string, status: TaskStatus): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const previousStatus = task.status;
    this.validateTransition(previousStatus, status);
    task.status = status;
    task.updatedAt = now();

    this.emitEvent(this.getEventTypeForStatus(status, previousStatus), taskId, { status, previousStatus });
  }

  handleControl(taskId: string, command: ControlCommand): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Emit control received event
    this.emitEvent(EventType.CONTROL_RECEIVED, taskId, command);

    switch (command.type) {
      case 'stop':
        this.updateStatus(taskId, 'cancelled');
        break;
      case 'pause':
        this.updateStatus(taskId, 'paused');
        break;
      case 'resume':
        this.updateStatus(taskId, 'executing');
        break;
      case 'change_strategy':
        task.strategy = command.strategy;
        task.updatedAt = now();
        this.emitEvent(EventType.STRATEGY_CHANGED, taskId, { strategy: command.strategy });
        break;
      case 'inject_constraint':
      case 'modify_plan':
        // Forwarded to agent loop by execution kernel
        break;
    }
  }

  // ─── Private ──────────────────────────────────────────────

  private validateTransition(from: TaskStatus, to: TaskStatus): void {
    const validTransitions: Record<TaskStatus, TaskStatus[]> = {
      pending: ['planning', 'cancelled'],
      planning: ['executing', 'failed', 'cancelled', 'paused'],
      executing: ['evaluating', 'failed', 'cancelled', 'paused'],
      evaluating: ['executing', 'completed', 'converged', 'failed', 'cancelled', 'paused'],
      paused: ['executing', 'cancelled'],
      completed: [],
      converged: [],
      failed: [],
      cancelled: [],
    };

    if (!validTransitions[from]?.includes(to)) {
      throw new Error(`Invalid transition from ${from} to ${to}`);
    }
  }

  private getEventTypeForStatus(status: TaskStatus, previousStatus?: TaskStatus): EventType {
    // paused → executing is a RESUME, not a generic START
    if (status === 'executing' && previousStatus === 'paused') {
      return EventType.TASK_RESUMED;
    }
    switch (status) {
      case 'pending': return EventType.TASK_CREATED;
      case 'planning':
      case 'executing':
      case 'evaluating': return EventType.TASK_STARTED;
      case 'completed': return EventType.TASK_COMPLETED;
      case 'converged': return EventType.TASK_COMPLETED;
      case 'failed': return EventType.TASK_FAILED;
      case 'cancelled': return EventType.TASK_CANCELLED;
      case 'paused': return EventType.TASK_PAUSED;
    }
  }

  private emitEvent(type: EventType, taskId: string, payload: unknown): void {
    this.eventBus.emit({ id: generateTaskId(), type, taskId, payload, timestamp: now() });
  }
}
