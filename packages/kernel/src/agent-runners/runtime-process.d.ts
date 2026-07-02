import type { EventEmitter } from 'node:events';
import type { AgentRunCompletion, PreparedRun } from './agent-runtime-runner.js';
export type RuntimeChildProcess = EventEmitter & {
    pid?: number;
    stdin?: {
        write(chunk: string | Uint8Array): unknown;
        end(): unknown;
    };
    stdout?: EventEmitter;
    stderr?: EventEmitter;
    kill(signal?: NodeJS.Signals): boolean;
};
export interface RuntimeLogAttachment {
    writers: Promise<unknown>[];
    redactedEnv: Record<string, string>;
}
export declare function buildRuntimeProcessEnv(input: PreparedRun): Record<string, string>;
export declare function assertRuntimeCwd(cwd: string): Promise<void>;
export declare function attachProcessLogs(input: PreparedRun, child: RuntimeChildProcess): RuntimeLogAttachment;
export declare function childCompletion(runtimeName: string, child: RuntimeChildProcess, logWriters: Promise<unknown>[], onSettled: (status: AgentRunCompletion['status']) => void, timeoutMs?: number): Promise<AgentRunCompletion>;
export declare function promiseCompletion(promise: Promise<unknown>, onSettled: (status: AgentRunCompletion['status']) => void): Promise<AgentRunCompletion>;
//# sourceMappingURL=runtime-process.d.ts.map