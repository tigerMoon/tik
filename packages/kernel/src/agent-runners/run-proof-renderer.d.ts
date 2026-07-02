import type { AgentRunRecord, RunProof } from '@tik/shared';
export interface RunProofRenderTask {
    id: string;
    shortIdentifier?: string;
    title: string;
    goal?: string;
}
export declare function renderRunReviewArtifact(input: {
    task: RunProofRenderTask;
    run: AgentRunRecord;
    proof: RunProof;
}): string;
//# sourceMappingURL=run-proof-renderer.d.ts.map