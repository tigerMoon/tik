import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { type CodexJsonRpcMessage } from './codex-app-server-protocol.js';
export interface CodexAppServerProcessOptions {
    cwd?: string;
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
}
export interface CodexAppServerTransport {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(message: CodexJsonRpcMessage): void;
    onMessage(listener: (message: CodexJsonRpcMessage) => void): () => void;
    onStderr(listener: (chunk: string) => void): () => void;
}
type SpawnFactory = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
export declare class CodexAppServerProcess implements CodexAppServerTransport {
    private readonly options;
    private readonly spawnFactory;
    private child?;
    private readonly emitter;
    private buffer;
    constructor(options?: CodexAppServerProcessOptions, spawnFactory?: SpawnFactory);
    start(): Promise<void>;
    stop(): Promise<void>;
    send(message: CodexJsonRpcMessage): void;
    onMessage(listener: (message: CodexJsonRpcMessage) => void): () => void;
    onStderr(listener: (chunk: string) => void): () => void;
}
export {};
//# sourceMappingURL=codex-app-server-process.d.ts.map