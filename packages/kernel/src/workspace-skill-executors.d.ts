import type { ProviderRuntimeEvent } from '@tik/shared';
import { WorkflowSkillExecutorRegistry } from './workflow-skill-executor.js';
import { type WorkflowSkillRuntimeAdapter } from './workflow-skill-runtime.js';
export interface WorkspaceSkillCompletionAdapter {
    complete(projectPath: string, prompt: string, options?: {
        onProviderEvent?: (event: ProviderRuntimeEvent) => void;
    }): Promise<{
        content: string;
        executionMode: 'native';
    }>;
}
export interface WorkspaceSkillExecutorFactoryOptions {
    completion: WorkspaceSkillCompletionAdapter;
    skillRuntime?: WorkflowSkillRuntimeAdapter;
}
export declare function createWorkspaceSkillExecutorRegistry(options: WorkspaceSkillExecutorFactoryOptions): WorkflowSkillExecutorRegistry;
export declare function isWorkspacePlanValid(planPath: string): Promise<boolean>;
//# sourceMappingURL=workspace-skill-executors.d.ts.map