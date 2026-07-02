import type { WorkbenchPort } from './types.js';
export interface WorkbenchKernelTaskRef {
    id: string;
}
export interface WorkbenchRunTaskFailureHandler {
    taskId: string;
    workbench: WorkbenchPort;
    runTask: (task: WorkbenchKernelTaskRef) => Promise<unknown>;
    logError?: (message: string, error: Error) => void;
}
export declare function runWorkbenchKernelTaskInBackground(task: WorkbenchKernelTaskRef, input: WorkbenchRunTaskFailureHandler): void;
export declare function markWorkbenchRunTaskFailed(workbench: WorkbenchPort, workbenchTaskId: string, kernelTaskId: string, error: Error): Promise<void>;
//# sourceMappingURL=workbench-runner.d.ts.map