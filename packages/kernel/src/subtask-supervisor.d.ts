import type { WorkflowSubtaskHandle, WorkflowSubtaskResult, WorkflowSubtaskSpec } from '@tik/shared';
import { WorkflowSubtaskRuntime } from './subtask-runtime.js';
export interface PreparedSubtaskExecutionRecord {
    taskId: string;
    projectName: string;
    projectPath: string;
    phase: WorkflowSubtaskSpec['phase'];
    contract: WorkflowSubtaskSpec['contract'];
    role: WorkflowSubtaskSpec['role'];
    skillName: WorkflowSubtaskSpec['skillName'];
    state: 'prepared' | 'running' | 'completed' | 'blocked' | 'failed';
    attempt: number;
    summary?: string;
    startedAt?: string;
    completedAt?: string;
}
export interface PreparedWorkflowSubtasks {
    handles: WorkflowSubtaskHandle[];
    records: PreparedSubtaskExecutionRecord[];
}
export type SubtaskTransitionHandler = (record: PreparedSubtaskExecutionRecord) => void | Promise<void>;
export declare class WorkflowSubtaskSupervisor {
    private readonly runtime;
    constructor(runtime: WorkflowSubtaskRuntime);
    prepare(specs: WorkflowSubtaskSpec[]): PreparedWorkflowSubtasks;
    executePrepared(prepared: PreparedWorkflowSubtasks, onTransition?: SubtaskTransitionHandler): Promise<WorkflowSubtaskResult[]>;
    execute(specs: WorkflowSubtaskSpec[], onTransition?: SubtaskTransitionHandler): Promise<{
        prepared: PreparedWorkflowSubtasks;
        results: WorkflowSubtaskResult[];
    }>;
    cancelPrepared(prepared: PreparedWorkflowSubtasks): Promise<void>;
    private mapResultState;
}
//# sourceMappingURL=subtask-supervisor.d.ts.map