import {
  type CodexAppServerInitializeParams,
  type CodexAppServerInitializeResponse,
  type CodexJsonRpcId,
  type CodexJsonRpcMessage,
  isCodexJsonRpcNotification,
  isCodexJsonRpcResponse,
} from './codex-app-server-protocol.js';
import type { CodexAppServerTransport } from './codex-app-server-process.js';

export interface CodexAppServerRequestOptions {
  /** Per-request timeout. Defaults to 60s. Set to 0 to disable. */
  timeoutMs?: number;
  /** Optional cancellation signal from Tik runtime/control plane. */
  signal?: AbortSignal;
}

interface PendingCodexRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
}

function abortReason(signal?: AbortSignal): string {
  const reason = signal?.reason;
  if (typeof reason === 'string' && reason) return reason;
  if (reason instanceof Error) return reason.message;
  return 'Codex App Server request aborted by Tik.';
}

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<CodexJsonRpcId, PendingCodexRequest>();
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
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerInitializeResponse> {
    return this.request<CodexAppServerInitializeResponse>('initialize', params, options);
  }

  async request<TResult = unknown, TParams = unknown>(
    method: string,
    params?: TParams,
    options: CodexAppServerRequestOptions = {},
  ): Promise<TResult> {
    if (options.signal?.aborted) {
      throw new Error(abortReason(options.signal));
    }

    const id = this.nextId++;
    return new Promise<TResult>((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (pending.signal && pending.abortListener) {
          pending.signal.removeEventListener('abort', pending.abortListener);
        }
      };

      const pending: PendingCodexRequest = {
        resolve: (value: TResult) => {
          cleanup();
          resolve(value);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
        signal: options.signal,
      };

      const timeoutMs = options.timeoutMs ?? 60_000;
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          pending.reject(new Error(`Codex App Server request timed out: ${method}`));
        }, timeoutMs);
        pending.timeout.unref?.();
      }

      if (options.signal) {
        pending.abortListener = () => pending.reject(new Error(abortReason(options.signal)));
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }

      this.pending.set(id, pending);

      try {
        this.transport.send({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (err) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
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
