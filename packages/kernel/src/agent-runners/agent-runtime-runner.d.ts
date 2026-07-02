import type { AgentRuntimeMode, AgentRuntimeName, DiffSummary, TranscriptRef } from '@tik/shared';
import type { TrackedTask } from '../tracker-daemon/types.js';
export interface AgentRunInput {
    runId: string;
    task: TrackedTask;
    attempt: number;
    runnerMode: AgentRuntimeMode;
    workflowPath: string;
    workflowConfigHash: string;
    workflowPromptHash: string;
    renderedPrompt: string;
    workspaceRoot: string;
    projectPath: string;
    worktreePath?: string;
    labels: string[];
    artifactOutputDir: string;
    timeoutMs?: number;
}
export interface PreparedRun {
    runId: string;
    runner: AgentRuntimeName;
    mode: AgentRuntimeMode;
    cwd: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    promptFile?: string;
    prompt?: string;
    timeoutMs?: number;
}
export interface AgentRunCompletion {
    status: 'completed' | 'failed' | 'cancelled';
    error?: string;
    artifactIds?: string[];
}
export interface AgentRunHandle {
    runId: string;
    pid?: number;
    startedAt: string;
    completion?: Promise<AgentRunCompletion>;
    stop(reason: string): Promise<void>;
}
export type AgentRunStatusSnapshot = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface ArtifactCandidate {
    path: string;
    kind?: string;
    title?: string;
}
export interface AgentRuntimeRunner {
    name: AgentRuntimeName;
    prepare(input: AgentRunInput): Promise<PreparedRun>;
    start(input: PreparedRun): Promise<AgentRunHandle>;
    stop(runId: string, reason: string): Promise<void>;
    getStatus(runId: string): Promise<AgentRunStatusSnapshot>;
    collectTranscript(runId: string): Promise<TranscriptRef[]>;
    collectDiff(runId: string): Promise<DiffSummary>;
    collectArtifacts(runId: string): Promise<ArtifactCandidate[]>;
    cleanup(runId: string): Promise<void>;
}
//# sourceMappingURL=agent-runtime-runner.d.ts.map