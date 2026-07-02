import type { WorkflowExecutionReadyContract } from '@tik/shared';
export interface CompletionEvidence {
    targetFiles: string[];
    matchedTargets: string[];
    changedFiles: string[];
    changedTests: string[];
    artifacts: string[];
    validationRuns: string[];
    blocker?: string;
    validationSummary: string;
}
export declare function collectCompletionEvidence(changedFiles: Iterable<string>, executionContract?: WorkflowExecutionReadyContract): CompletionEvidence | null;
export declare function summarizeCompletionEvidence(evidence: CompletionEvidence): string;
//# sourceMappingURL=workspace-completion-evidence.d.ts.map