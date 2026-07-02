import type { WorkflowExecutionReadyContract } from '@tik/shared';
export interface ExecutionContractSynthesisInput {
    projectPath: string;
    demand: string;
    specContent?: string;
    planContent?: string;
}
export declare class WorkspaceExecutionContractSynthesizer {
    synthesize(input: ExecutionContractSynthesisInput): WorkflowExecutionReadyContract | undefined;
    private buildGenericContract;
    private resolveClassCandidates;
    private resolveFunctionCandidates;
    private mergeContracts;
}
//# sourceMappingURL=workspace-execution-contract-synthesizer.d.ts.map