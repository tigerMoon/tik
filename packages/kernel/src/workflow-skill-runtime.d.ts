import type { WorkflowSkillName, WorkflowSkillSourceKind, WorkflowSubtaskSpec } from '@tik/shared';
export interface WorkflowSkillRuntimeContext {
    skillName: WorkflowSkillName;
    skillSourceKind?: WorkflowSkillSourceKind;
    skillPath: string;
    description?: string;
    prompt: string;
}
export interface WorkflowSkillRuntimeAdapter {
    load(spec: WorkflowSubtaskSpec): Promise<WorkflowSkillRuntimeContext>;
}
export declare class LocalWorkflowSkillRuntimeAdapter implements WorkflowSkillRuntimeAdapter {
    private readonly options;
    constructor(options?: {
        codexHome?: string;
        agentSkillsRoot?: string;
    });
    load(spec: WorkflowSubtaskSpec): Promise<WorkflowSkillRuntimeContext>;
    private resolveSkillPath;
}
export declare function buildWorkflowSkillDelegatedDescription(spec: WorkflowSubtaskSpec, skill: WorkflowSkillRuntimeContext): string;
export declare function materializeWorkflowSkillDelegatedSpec(spec: WorkflowSubtaskSpec, runtime: WorkflowSkillRuntimeAdapter): Promise<WorkflowSubtaskSpec>;
export declare function parseSkillDescription(contents: string): string | undefined;
//# sourceMappingURL=workflow-skill-runtime.d.ts.map