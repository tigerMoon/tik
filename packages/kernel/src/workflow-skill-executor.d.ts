import type { ProviderRuntimeEvent, WorkflowSubtaskContract, WorkflowSubtaskResult, WorkflowSubtaskSpec } from '@tik/shared';
export interface WorkflowSkillExecutionRequest {
    spec: WorkflowSubtaskSpec;
    subtask: WorkflowSubtaskResult;
    onProviderEvent?: (event: ProviderRuntimeEvent) => void;
}
export interface WorkflowSkillExecutionOutcome {
    summary: string;
    outputPath?: string;
    valid?: boolean;
    status?: 'completed' | 'blocked' | 'failed';
    metadata?: Record<string, unknown>;
    executionMode?: 'native';
}
export type WorkflowSkillExecutor = (request: WorkflowSkillExecutionRequest) => Promise<WorkflowSkillExecutionOutcome>;
export declare class WorkflowSkillExecutorRegistry {
    private readonly executors;
    register(contract: WorkflowSubtaskContract, executor: WorkflowSkillExecutor): void;
    has(contract: WorkflowSubtaskContract): boolean;
    get(contract: WorkflowSubtaskContract): WorkflowSkillExecutor;
    execute(contract: WorkflowSubtaskContract, request: WorkflowSkillExecutionRequest): Promise<WorkflowSkillExecutionOutcome>;
}
//# sourceMappingURL=workflow-skill-executor.d.ts.map