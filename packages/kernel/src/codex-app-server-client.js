import { isCodexJsonRpcNotification, isCodexJsonRpcResponse, } from './codex-app-server-protocol.js';
function abortReason(signal) {
    const reason = signal?.reason;
    if (typeof reason === 'string' && reason)
        return reason;
    if (reason instanceof Error)
        return reason.message;
    return 'Codex App Server request aborted by Tik.';
}
export class CodexAppServerClient {
    transport;
    nextId = 1;
    pending = new Map();
    notificationListeners = new Map();
    unsubscribe;
    constructor(transport) {
        this.transport = transport;
    }
    async start() {
        await this.transport.start();
        this.unsubscribe = this.transport.onMessage((message) => this.handleMessage(message));
    }
    async stop() {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        for (const [, pending] of this.pending) {
            pending.reject(new Error('Codex App Server client stopped before response was received.'));
        }
        this.pending.clear();
        await this.transport.stop();
    }
    async initialize(params, options) {
        return this.request('initialize', params, options);
    }
    async request(method, params, options = {}) {
        if (options.signal?.aborted) {
            throw new Error(abortReason(options.signal));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                this.pending.delete(id);
                if (pending.timeout)
                    clearTimeout(pending.timeout);
                if (pending.signal && pending.abortListener) {
                    pending.signal.removeEventListener('abort', pending.abortListener);
                }
            };
            const pending = {
                resolve: (value) => {
                    cleanup();
                    resolve(value);
                },
                reject: (error) => {
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
            }
            catch (err) {
                pending.reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    notify(method, params) {
        this.transport.send({
            jsonrpc: '2.0',
            method,
            params,
        });
    }
    onNotification(method, listener) {
        const listeners = this.notificationListeners.get(method) || new Set();
        listeners.add(listener);
        this.notificationListeners.set(method, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0)
                this.notificationListeners.delete(method);
        };
    }
    handleMessage(message) {
        if (isCodexJsonRpcResponse(message)) {
            if (message.id === null)
                return;
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            if ('error' in message) {
                pending.reject(new Error(message.error.message));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if (isCodexJsonRpcNotification(message)) {
            const listeners = this.notificationListeners.get(message.method);
            if (!listeners?.size)
                return;
            for (const listener of listeners) {
                listener(message.params);
            }
        }
    }
}
//# sourceMappingURL=codex-app-server-client.js.map