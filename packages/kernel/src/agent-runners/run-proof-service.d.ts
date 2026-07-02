import type { AgentRunRecord, DiffSummary, RunDiffSummary, RunProof } from '@tik/shared';
import type { ArtifactRegistry } from '../artifacts/artifact-registry.js';
import type { AgentRunCompletion, AgentRuntimeRunner } from './agent-runtime-runner.js';
import { type RunProofRenderTask } from './run-proof-renderer.js';
import { FileRunProofStore } from './run-proof-store.js';
export interface RunProofCommandRunnerInput {
    command: string;
    cwd: string;
    timeoutMs?: number;
}
export interface RunProofCommandRunnerResult {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
}
export type RunProofCommandRunner = (input: RunProofCommandRunnerInput) => Promise<RunProofCommandRunnerResult>;
export interface RunProofServiceOptions {
    proofStore: FileRunProofStore;
    artifacts: ArtifactRegistry;
    runCommand?: RunProofCommandRunner;
    validationTimeoutMs?: number;
}
export interface RunProofCreateInput {
    task: RunProofRenderTask;
    run: AgentRunRecord;
    runner: AgentRuntimeRunner;
    completion: AgentRunCompletion;
    validationCommands?: string[];
    validationCwd?: string;
    now?: string;
}
export declare class RunProofService {
    private readonly options;
    constructor(options: RunProofServiceOptions);
    createProof(input: RunProofCreateInput): Promise<RunProof>;
    private collect;
    private createTranscriptArtifacts;
    private createDiffArtifacts;
    private readDiffStatContent;
    private collectValidation;
    private runValidationCommand;
    private createValidationArtifact;
    private createOrAppendRunArtifact;
    private findExistingRunArtifact;
    private classifyStatus;
    private classifyRisk;
    private summarize;
    private failureFor;
}
export declare function toRunDiffSummary(diff: DiffSummary | undefined): RunDiffSummary;
//# sourceMappingURL=run-proof-service.d.ts.map