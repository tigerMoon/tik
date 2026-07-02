/**
 * Display Utilities
 *
 * Terminal output formatting for Tik CLI.
 */
import type { Task, TaskResult, AgentEvent, EvaluationSnapshot } from '@tik/shared';
export declare function displayTask(task: Task): void;
export declare function displayTaskResult(result: TaskResult): void;
export declare function displayEvent(event: AgentEvent): void;
export declare function displayEvaluation(eval_: EvaluationSnapshot, iteration: number): void;
export declare function fitnessBar(value: number, width?: number): string;
//# sourceMappingURL=display.d.ts.map