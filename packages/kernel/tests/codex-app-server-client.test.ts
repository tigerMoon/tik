import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexAppServerClient } from '../src/codex-app-server-client.js';
import type { CodexAppServerTransport } from '../src/codex-app-server-process.js';
import type { CodexJsonRpcMessage } from '../src/codex-app-server-protocol.js';

class FakeTransport implements CodexAppServerTransport {
  private readonly emitter = new EventEmitter();
  public sent: CodexJsonRpcMessage[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  send(message: CodexJsonRpcMessage): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: CodexJsonRpcMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }

  onStderr(_listener: (chunk: string) => void): () => void {
    return () => {};
  }

  emit(message: CodexJsonRpcMessage): void {
    this.emitter.emit('message', message);
  }
}

describe('CodexAppServerClient', () => {
  it('sends initialize and resolves the response', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    await client.start();

    const promise = client.initialize({
      clientInfo: { name: 'tik', version: '0.1.0' },
      capabilities: null,
    });

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    transport.emit({
      jsonrpc: '2.0',
      id: 1,
      result: { userAgent: 'codex-test' },
    });

    await expect(promise).resolves.toMatchObject({ userAgent: 'codex-test' });
    await client.stop();
  });

  it('dispatches notifications to registered listeners', async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient(transport);
    await client.start();

    const seen: unknown[] = [];
    const unsubscribe = client.onNotification('turn/started', (params) => {
      seen.push(params);
    });

    transport.emit({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    });

    expect(seen).toEqual([{ threadId: 'thread-1', turn: { id: 'turn-1' } }]);
    unsubscribe();
    await client.stop();
  });
});

