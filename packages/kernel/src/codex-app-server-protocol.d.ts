export type CodexJsonRpcId = string | number;
export interface CodexJsonRpcRequest<TParams = unknown> {
    jsonrpc: '2.0';
    id: CodexJsonRpcId;
    method: string;
    params?: TParams;
}
export interface CodexJsonRpcSuccess<TResult = unknown> {
    jsonrpc: '2.0';
    id: CodexJsonRpcId;
    result: TResult;
}
export interface CodexJsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}
export interface CodexJsonRpcFailure {
    jsonrpc: '2.0';
    id: CodexJsonRpcId | null;
    error: CodexJsonRpcErrorObject;
}
export interface CodexJsonRpcNotification<TParams = unknown> {
    jsonrpc: '2.0';
    method: string;
    params?: TParams;
}
export type CodexJsonRpcMessage = CodexJsonRpcRequest | CodexJsonRpcSuccess | CodexJsonRpcFailure | CodexJsonRpcNotification;
export interface CodexAppServerInitializeParams {
    clientInfo: {
        name: string;
        version: string;
    };
    capabilities?: Record<string, unknown> | null;
}
export interface CodexAppServerInitializeResponse {
    userAgent?: string;
    [key: string]: unknown;
}
export declare function isCodexJsonRpcResponse(message: CodexJsonRpcMessage): message is CodexJsonRpcSuccess | CodexJsonRpcFailure;
export declare function isCodexJsonRpcNotification(message: CodexJsonRpcMessage): message is CodexJsonRpcNotification;
//# sourceMappingURL=codex-app-server-protocol.d.ts.map