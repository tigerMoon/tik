import { type CodexAppServerInitializeParams, type CodexAppServerInitializeResponse } from './codex-app-server-protocol.js';
import type { CodexAppServerTransport } from './codex-app-server-process.js';
export interface CodexAppServerRequestOptions {
    /** Per-request timeout. Defaults to 60s. Set to 0 to disable. */
    timeoutMs?: number;
    /** Optional cancellation signal from Tik runtime/control plane. */
    signal?: AbortSignal;
}
export declare class CodexAppServerClient {
    private readonly transport;
    private nextId;
    private readonly pending;
    private readonly notificationListeners;
    private unsubscribe?;
    constructor(transport: CodexAppServerTransport);
    start(): Promise<void>;
    stop(): Promise<void>;
    initialize(params: CodexAppServerInitializeParams, options?: CodexAppServerRequestOptions): Promise<CodexAppServerInitializeResponse>;
    request<TResult = unknown, TParams = unknown>(method: string, params?: TParams, options?: CodexAppServerRequestOptions): Promise<TResult>;
    notify<TParams = unknown>(method: string, params?: TParams): void;
    onNotification<TParams = unknown>(method: string, listener: (params: TParams) => void): () => void;
    private handleMessage;
}
//# sourceMappingURL=codex-app-server-client.d.ts.map