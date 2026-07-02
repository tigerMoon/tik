import type { TaskWorkspaceBinding } from '@tik/shared';
import type { WorkbenchTaskResponse, WorkspaceStatusResponse } from '../api/client';
export type WorkspaceScopeKey = 'workspace' | `project:${string}`;
export interface WorkspaceProjectNode {
    key: WorkspaceScopeKey;
    name: string;
    path?: string;
    sourceProjectPath?: string;
    effectiveProjectPath?: string;
    taskCount: number;
    activeTaskCount: number;
    completedTaskCount: number;
    binding?: TaskWorkspaceBinding;
}
export interface WorkspaceHierarchy {
    workspace: {
        key: WorkspaceScopeKey;
        name: string;
        rootPath: string;
        workspaceFile?: string;
        taskCount: number;
        activeTaskCount: number;
        completedTaskCount: number;
    };
    projects: WorkspaceProjectNode[];
    defaultScopeKey: WorkspaceScopeKey;
}
export interface WorkspaceBindingOption {
    key: WorkspaceScopeKey;
    label: string;
    detail: string;
    kind: 'workspace' | 'project';
    taskCount: number;
    binding?: TaskWorkspaceBinding;
}
type HierarchyTask = Pick<WorkbenchTaskResponse, 'status' | 'workspaceBinding'>;
export declare function buildWorkspaceHierarchy(tasks: HierarchyTask[], workspaceStatus: WorkspaceStatusResponse | null, fallbackRootPath: string): WorkspaceHierarchy;
export declare function filterTasksByWorkspaceScope<T extends HierarchyTask>(tasks: T[], scopeKey: WorkspaceScopeKey): T[];
export declare function buildWorkspaceBindingOptions(hierarchy: WorkspaceHierarchy): WorkspaceBindingOption[];
export declare function resolveWorkspaceBindingOption(options: WorkspaceBindingOption[], scopeKey: WorkspaceScopeKey): WorkspaceBindingOption;
export declare function buildProjectScopeKey(projectName: string, projectPath?: string): WorkspaceScopeKey;
export declare function buildTaskBindingLabel(binding: TaskWorkspaceBinding | undefined): string;
export {};
//# sourceMappingURL=workspace-hierarchy.d.ts.map