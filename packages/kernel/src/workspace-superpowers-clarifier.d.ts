import type { WorkspaceDecisionRequest, WorkspaceDecisionPhase, WorkspaceWorkflowPolicyProfile } from '@tik/shared';
import { WorkspaceExecutionContractSynthesizer } from './workspace-execution-contract-synthesizer.js';
export type WorkspaceClarificationMethod = 'deep-interview' | 'ralplan';
export type WorkspaceClarificationCategory = 'scope' | 'constraints' | 'validation' | 'approval' | 'approach' | 'generic' | 'skip';
export interface WorkspaceSuperpowersClarifierInput {
    projectName: string;
    projectPath: string;
    demand: string;
    phase: WorkspaceDecisionPhase;
    workflowProfile?: WorkspaceWorkflowPolicyProfile;
    splitReason?: string;
    summary?: string;
    specPath?: string;
    planPath?: string;
    recentProjectEvents?: string[];
    recentWorkspaceEvents?: string[];
    sessionNextAction?: string;
    specExcerpt?: string;
    planExcerpt?: string;
}
export interface WorkspaceSuperpowersClarifierResult {
    needsClarification: boolean;
    category: WorkspaceClarificationCategory;
    method: WorkspaceClarificationMethod;
    recommendedNextPhase: Exclude<WorkspaceDecisionPhase, 'PARALLEL_CLARIFY'>;
    confidence: 'low' | 'medium' | 'high';
    rationale: string;
    signals: string[];
    skillPath: string;
    skillDescription?: string;
    artifactBody: string;
    summary: string;
    decision?: WorkspaceDecisionRequest;
}
export declare class WorkspaceSuperpowersClarifier {
    private readonly contractSynthesizer;
    private readonly superpowersRoot;
    constructor(options?: {
        contractSynthesizer?: WorkspaceExecutionContractSynthesizer;
        superpowersRoot?: string;
    });
    clarify(input: WorkspaceSuperpowersClarifierInput, now: string): Promise<WorkspaceSuperpowersClarifierResult>;
}
//# sourceMappingURL=workspace-superpowers-clarifier.d.ts.map