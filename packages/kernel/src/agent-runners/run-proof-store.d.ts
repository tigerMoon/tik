import type { RunProof } from '@tik/shared';
export declare class FileRunProofStore {
    private readonly runsRoot;
    private readonly indexPath;
    constructor(workspaceRoot: string);
    saveProof(proof: RunProof): Promise<RunProof>;
    readProof(runId: string): Promise<RunProof>;
    listProofsByTask(taskId: string): Promise<RunProof[]>;
    private upsertIndex;
    private runDir;
    private proofPath;
}
//# sourceMappingURL=run-proof-store.d.ts.map