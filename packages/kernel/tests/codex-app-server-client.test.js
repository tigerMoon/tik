import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { CodexAppServerClient } from '../src/codex-app-server-client.js';
class FakeTransport {
    emitter = new EventEmitter();
    sent = [];
    async start() { }
    async stop() { }
    send(message) {
        this.sent.push(message);
    }
    onMessage(listener) {
        this.emitter.on('message', listener);
        return () => this.emitter.off('message', listener);
    }
    onStderr(_listener) {
        return () => { };
    }
    emit(message) {
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
        const seen = [];
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
//# sourceMappingURL=codex-app-server-client.test.js.map