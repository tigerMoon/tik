import type { ProviderRuntimeEvent } from '@tik/shared';
export interface CodexHarnessTurnOptions {
    prompt: string;
    cwd: string;
    model?: string;
    baseInstructions?: string;
    developerInstructions?: string;
    allowWrites?: boolean;
    signal?: AbortSignal;
    onProviderEvent?: (event: ProviderRuntimeEvent) => void;
    onTextDelta?: (text: string) => void;
    onTurnVisible?: (source: 'turn.started' | 'item.started' | 'item.completed' | 'message.delta') => void;
}
export interface CodexHarnessThreadOptions {
    cwd: string;
    model?: string;
    baseInstructions?: string;
    developerInstructions?: string;
    allowWrites?: boolean;
    signal?: AbortSignal;
}
export interface CodexHarnessTurnResult {
    content: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    turnId: string;
    threadId: string;
}
export declare class CodexHarnessAdapter {
    private readonly appVersion;
    private readonly process;
    private readonly client;
    private started;
    constructor(cwd: string, appVersion?: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    startThread(options: CodexHarnessThreadOptions): Promise<string>;
    runTurn(options: CodexHarnessTurnOptions): Promise<CodexHarnessTurnResult>;
    runTurnOnThread(threadId: string, options: CodexHarnessTurnOptions): Promise<CodexHarnessTurnResult>;
}
//# sourceMappingURL=codex-harness-adapter.d.ts.map