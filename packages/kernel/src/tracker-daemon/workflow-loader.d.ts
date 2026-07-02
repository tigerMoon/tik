import type { TrackerWorkflowDefinition } from './types.js';
export declare function loadTrackerWorkflow(rootPath: string, fileName?: string): Promise<TrackerWorkflowDefinition>;
export declare function resolveTrackerWorkflowPath(workspaceRoot: string, explicitPath?: string): Promise<string>;
export declare function defaultTrackerWorkflowContent(): string;
export declare function readTrackerWorkflowFile(workspaceRoot: string): Promise<{
    path: string;
    exists: boolean;
    content: string;
}>;
export declare function writeTrackerWorkflowFile(workspaceRoot: string, content: string): Promise<{
    path: string;
    content: string;
}>;
//# sourceMappingURL=workflow-loader.d.ts.map