import { type SpawnOptions } from 'node:child_process';
import type { AgentRuntimeMode } from '@tik/shared';
import type { AgentRunHandle, AgentRunInput, AgentRunStatusSnapshot, AgentRuntimeRunner, ArtifactCandidate, PreparedRun } from './agent-runtime-runner.js';
import { type RuntimeChildProcess } from './runtime-process.js';
export interface ClaudeCodeRunnerOptions {
    mode?: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>;
    executable?: string;
    pluginDirs?: string[];
    addDirs?: string[];
    permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
    spawnProcess?: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;
}
export declare class ClaudeCodeRunner implements AgentRuntimeRunner {
    readonly name: "claude-code";
    private readonly mode?;
    private readonly executable;
    private readonly pluginDirs;
    private readonly addDirs;
    private readonly permissionMode;
    private readonly statuses;
    private readonly children;
    private readonly preparedRuns;
    private readonly spawnProcess;
    constructor(options?: ClaudeCodeRunnerOptions);
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
//# sourceMappingURL=claude-code-runner.d.ts.map