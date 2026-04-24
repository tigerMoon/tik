import {
  type CodexAppServerInitializeParams,
  type CodexAppServerInitializeResponse,
  type CodexJsonRpcId,
  type CodexJsonRpcMessage,
  isCodexJsonRpcNotification,
  isCodexJsonRpcResponse,
} from './codex-app-server-protocol.js';
import type { CodexAppServerTransport } from './codex-app-server-process.js';

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<CodexJsonRpcId, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private unsubscribe?: () => void;

  constructor(private readonly transport: CodexAppServerTransport) {}

  async start(): Promise<void> {
    await this.transport.start();
    this.unsubscribe = this.transport.onMessage((message) => this.handleMessage(message));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Codex App Server client stopped before response was received.'));
    }
    this.pending.clear();
    await this.transport.stop();
  }

  async initialize(
    params: CodexAppServerInitializeParams,
  ): Promise<CodexAppServerInitializeResponse> {
    return this.request<CodexAppServerInitializeResponse>('initialize', params);
  }

  async request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
  ): Promise<TResult> {
    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  notify<TParams = unknown>(method: string, params?: TParams): void {
    this.transport.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  onNotification<TParams = unknown>(
    method: string,
    listener: (params: TParams) => void,
  ): () => void {
    const listeners = this.notificationListeners.get(method) || new Set();
    listeners.add(listener as (params: unknown) => void);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener as (params: unknown) => void);
      if (listeners.size === 0) this.notificationListeners.delete(method);
    };
  }

  private handleMessage(message: CodexJsonRpcMessage): void {
    if (isCodexJsonRpcResponse(message)) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isCodexJsonRpcNotification(message)) {
      const listeners = this.notificationListeners.get(message.method);
      if (!listeners?.size) return;
      for (const listener of listeners) {
        listener(message.params);
      }
    }
  }
}
