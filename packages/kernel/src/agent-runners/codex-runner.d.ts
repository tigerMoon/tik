import { type SpawnOptions } from 'node:child_process';
import type { AgentRuntimeMode } from '@tik/shared';
import { type CodexHarnessTurnOptions } from '../codex-harness-adapter.js';
import type { AgentRunHandle, AgentRunInput, AgentRunStatusSnapshot, AgentRuntimeRunner, ArtifactCandidate, PreparedRun } from './agent-runtime-runner.js';
import { type RuntimeChildProcess } from './runtime-process.js';
export interface CodexHarnessLike {
    runTurn(options: CodexHarnessTurnOptions): Promise<unknown>;
    stop(): Promise<void>;
}
export interface CodexRunnerOptions {
    mode?: Extract<AgentRuntimeMode, 'codex_exec' | 'codex_app_server'>;
    executable?: string;
    adapterFactory?: (cwd: string) => CodexHarnessLike;
    spawnProcess?: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;
}
export declare class CodexRunner implements AgentRuntimeRunner {
    readonly name: "codex";
    private readonly mode?;
    private readonly executable;
    private readonly adapterFactory;
    private readonly adapters;
    private readonly children;
    private readonly preparedRuns;
    private readonly statuses;
    private readonly spawnProcess;
    constructor(options?: CodexRunnerOptions);
    prepare(input: AgentRunInput): Promise<PreparedRun>;
    start(input: PreparedRun): Promise<AgentRunHandle>;
    stop(runId: string, _reason: string): Promise<void>;
    getStatus(runId: string): Promise<AgentRunStatusSnapshot>;
    collectTranscript(_runId: string): Promise<never[] | import("@tik/shared").TranscriptRef[]>;
    collectDiff(_runId: string): Promise<import("@tik/shared").DiffSummary | {
        changedFiles: never[];
    }>;
    collectArtifacts(_runId: string): Promise<ArtifactCandidate[]>;
    cleanup(runId: string): Promise<void>;
}
//# sourceMappingURL=codex-runner.d.ts.map