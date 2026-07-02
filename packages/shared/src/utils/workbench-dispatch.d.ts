import type { WorkbenchTaskRecord } from '../types/workbench.js';
export type WorkbenchDispatchTask = Pick<WorkbenchTaskRecord, 'agentLoop' | 'labels' | 'status'>;
export type WorkbenchDispatchEnvironmentTask = Pick<WorkbenchTaskRecord, 'agentLoop' | 'environmentPackSnapshot' | 'labels' | 'status'>;
export declare function isWorkbenchTaskExternallyOwnedClaudeReview(task: Pick<WorkbenchTaskRecord, 'agentLoop' | 'labels'>): boolean;
export declare function isWorkbenchTaskMaintenance(task: Pick<WorkbenchTaskRecord, 'agentLoop' | 'environmentPackSnapshot' | 'labels'>): boolean;
export declare function isWorkbenchTaskCodexDispatchable(task: WorkbenchDispatchEnvironmentTask): boolean;
export declare function isWorkbenchTaskWorkflowDispatchable(task: WorkbenchDispatchEnvironmentTask): boolean;
//# sourceMappingURL=workbench-dispatch.d.ts.map