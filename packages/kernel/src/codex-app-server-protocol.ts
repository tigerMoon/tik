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

export type CodexJsonRpcMessage =
  | CodexJsonRpcRequest
  | CodexJsonRpcSuccess
  | CodexJsonRpcFailure
  | CodexJsonRpcNotification;

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

export function isCodexJsonRpcResponse(message: CodexJsonRpcMessage): message is CodexJsonRpcSuccess | CodexJsonRpcFailure {
  return Object.prototype.hasOwnProperty.call(message, 'id')
    && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}

export function isCodexJsonRpcNotification(message: CodexJsonRpcMessage): message is CodexJsonRpcNotification {
  return Object.prototype.hasOwnProperty.call(message, 'method')
    && !Object.prototype.hasOwnProperty.call(message, 'id');
}

