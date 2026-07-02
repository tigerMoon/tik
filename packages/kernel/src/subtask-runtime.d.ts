import type { AgentEvent, ExecutionMode, WorkflowSubtaskHandle, WorkflowSubtaskResult, WorkflowSubtaskSpec } from '@tik/shared';
import type { ExecutionKernel } from './execution-kernel.js';
export interface SubtaskKernelInstance {
    kernel: ExecutionKernel;
    dispose?: () => void;
}
export type SubtaskKernelFactory = (projectPath: string) => SubtaskKernelInstance;
export interface SubtaskRuntimeEventContext {
    taskId: string;
    projectName: string;
    projectPath: string;
    phase: WorkflowSubtaskSpec['phase'];
    contract: WorkflowSubtaskSpec['contract'];
    role: WorkflowSubtaskSpec['role'];
    skillName: WorkflowSubtaskSpec['skillName'];
}
export type SubtaskRuntimeEventHandler = (event: AgentEvent, context: SubtaskRuntimeEventContext) => void | Promise<void>;
export declare class WorkflowSubtaskRuntime {
    private readonly kernelFactory;
    private readonly executionMode;
    private readonly onEvent?;
    constructor(kernelFactory: SubtaskKernelFactory, executionMode?: ExecutionMode, onEvent?: SubtaskRuntimeEventHandler | undefined);
    create(spec: WorkflowSubtaskSpec): WorkflowSubtaskHandle;
    executeBatch(specs: WorkflowSubtaskSpec[]): Promise<WorkflowSubtaskResult[]>;
    private executeHandle;
    private normalizeStatus;
}
//# sourceMappingURL=subtask-runtime.d.ts.map