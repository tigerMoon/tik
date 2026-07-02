import { type TrackerWorkflowDefinition, type TrackedTask } from '@tik/kernel';
export interface WorkflowInitOptions {
    workspaceRoot: string;
    file?: string;
    force?: boolean;
}
export interface WorkflowValidateOptions {
    workspaceRoot: string;
    file?: string;
}
export interface WorkflowExplainOptions {
    workspaceRoot: string;
    file?: string;
    taskId: string;
    task?: Partial<TrackedTask>;
}
export declare function initWorkflowV2(options: WorkflowInitOptions): Promise<{
    path: string;
    content: string;
    created: boolean;
}>;
export declare function validateWorkflow(options: WorkflowValidateOptions): Promise<string>;
export declare function explainWorkflowTask(options: WorkflowExplainOptions): Promise<string>;
export declare function defaultTrackerWorkflowV2Content(): string;
export declare function formatWorkflowValidation(workflow: TrackerWorkflowDefinition): string;
export declare function formatWorkflowExplain(workflow: TrackerWorkflowDefinition, task: TrackedTask, routing: {
    runner: string;
    mode: string;
    matchedSource: string;
    projectPath: string;
}): string;
//# sourceMappingURL=workflow-command.d.ts.map