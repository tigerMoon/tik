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
import type { Task, TaskStatus, CreateTaskInput, ControlCommand, IEventBus } from '@tik/shared';
export declare class TaskManager {
    private tasks;
    private eventBus;
    constructor(eventBus: IEventBus);
    create(input: CreateTaskInput): Task;
    get(taskId: string): Task | undefined;
    list(): Task[];
    updateEnvironmentPackSelection(taskId: string, selection: NonNullable<Task['environmentPackSelection']>, snapshot?: Task['environmentPackSnapshot']): Task | undefined;
    updateDescription(taskId: string, description: string): Task | undefined;
    updateStatus(taskId: string, status: TaskStatus): void;
    handleControl(taskId: string, command: ControlCommand): void;
    private validateTransition;
    private getEventTypeForStatus;
    private emitEvent;
}
//# sourceMappingURL=task-manager.d.ts.map