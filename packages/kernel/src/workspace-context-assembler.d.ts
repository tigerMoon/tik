import type { WorkflowSubtaskSpec } from '@tik/shared';
import { WorkspaceExecutionContractSynthesizer } from './workspace-execution-contract-synthesizer.js';
export interface WorkspaceContextAssemblerOptions {
    contractSynthesizer?: WorkspaceExecutionContractSynthesizer;
}
export declare class WorkspaceContextAssembler {
    private readonly contractSynthesizer;
    constructor(options?: WorkspaceContextAssemblerOptions);
    buildClarifySubtaskSpec(input: {
        projectName: string;
        projectPath: string;
        sourceProjectPath?: string;
        effectiveProjectPath?: string;
        demand: string;
        workspaceRoot?: string;
        workspaceFile?: string;
        clarificationPath?: string;
        splitReason?: string;
    }): WorkflowSubtaskSpec;
    buildSpecifySubtaskSpec(input: {
        projectName: string;
        projectPath: string;
        sourceProjectPath?: string;
        effectiveProjectPath?: string;
        demand: string;
        workspaceRoot?: string;
        workspaceFile?: string;
        targetSpecPath?: string;
    }): WorkflowSubtaskSpec;
    buildPlanSubtaskSpec(input: {
        projectName: string;
        projectPath: string;
        sourceProjectPath?: string;
        effectiveProjectPath?: string;
        demand: string;
        specContent: string;
        workspaceRoot?: string;
        workspaceFile?: string;
        specPath?: string;
        targetPlanPath?: string;
    }): WorkflowSubtaskSpec;
    buildAceSubtaskSpec(input: {
        projectName: string;
        projectPath: string;
        sourceProjectPath?: string;
        effectiveProjectPath?: string;
        demand: string;
        specContent: string;
        planContent: string;
        workspaceRoot?: string;
        workspaceFile?: string;
        specPath?: string;
        planPath?: string;
    }): WorkflowSubtaskSpec;
    private buildClarifyDescription;
    private buildSpecifyDescription;
    private buildPlanDescription;
    private buildAceDescription;
}
//# sourceMappingURL=workspace-context-assembler.d.ts.map