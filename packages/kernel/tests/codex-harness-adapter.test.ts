import { describe, expect, it, vi } from 'vitest';
import { CodexHarnessAdapter } from '../src/codex-harness-adapter.js';
import { CodexAppServerClient } from '../src/codex-app-server-client.js';

describe('CodexHarnessAdapter', () => {
  it('maps app-server notifications into text and provider events', async () => {
    const start = vi.spyOn(CodexAppServerClient.prototype, 'start').mockResolvedValue(undefined);
    const stop = vi.spyOn(CodexAppServerClient.prototype, 'stop').mockResolvedValue(undefined);

    const listeners = new Map<string, Array<(params: any) => void>>();
    const onNotification = vi.spyOn(CodexAppServerClient.prototype, 'onNotification').mockImplementation((method: string, listener: (params: any) => void) => {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
      return () => {
        listeners.set(method, (listeners.get(method) || []).filter((item) => item !== listener));
      };
    });

    const request = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'codex-test' } as any;
      if (method === 'thread/start') return { thread: { id: 'thread-1' } } as any;
      if (method === 'turn/start') {
        setTimeout(() => {
          for (const listener of listeners.get('item/started') || []) {
            listener({
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'commandExecution', command: 'cat spec.md' },
            });
          }
          for (const listener of listeners.get('item/agentMessage/delta') || []) {
            listener({
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'msg-1',
              delta: 'hello',
            });
          }
          for (const listener of listeners.get('item/completed') || []) {
            listener({
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                type: 'commandExecution',
                command: 'cat spec.md',
                aggregatedOutput: 'content',
                exitCode: 0,
                durationMs: 12,
                status: 'completed',
              },
            });
          }
          for (const listener of listeners.get('thread/tokenUsage/updated') || []) {
            listener({
              threadId: 'thread-1',
              turnId: 'turn-1',
              tokenUsage: {
                last: {
                  inputTokens: 10,
                  cachedInputTokens: 2,
                  outputTokens: 3,
                  totalTokens: 15,
                },
              },
            });
          }
          for (const listener of listeners.get('turn/completed') || []) {
            listener({
              threadId: 'thread-1',
              turn: { id: 'turn-1' },
            });
          }
        }, 0);
        return { turn: { id: 'turn-1' } } as any;
      }
      if (method === 'thread/read') {
        return {
          thread: {
            turns: [
              {
                id: 'turn-1',
                status: 'completed',
                items: [
                  {
                    id: 'cmd-1',
                    type: 'commandExecution',
                    command: 'cat spec.md',
                    aggregatedOutput: 'content',
                    exitCode: 0,
                    durationMs: 12,
                    status: 'completed',
                  },
                  {
                    id: 'msg-1',
                    type: 'agentMessage',
                    text: 'hello',
                  },
                ],
              },
            ],
          },
        } as any;
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const adapter = new CodexHarnessAdapter('/tmp/project');
    const providerEvents: any[] = [];
    const textChunks: string[] = [];

    const result = await adapter.runTurn({
      prompt: 'hello',
      cwd: '/tmp/project',
      allowWrites: true,
      onProviderEvent: (event) => providerEvents.push(event),
      onTextDelta: (delta) => textChunks.push(delta),
    });

    expect(start).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('initialize', expect.anything());
    expect(request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ cwd: '/tmp/project' }));
    expect(request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ threadId: 'thread-1' }));
    expect(textChunks.join('')).toBe('hello');
    expect(providerEvents[0]).toMatchObject({ type: 'tool.called', toolName: 'bash' });
    expect(providerEvents[1]).toMatchObject({ type: 'tool.result', toolName: 'bash', success: true });
    expect(result.content).toBe('hello');
    expect(result.threadId).toBe('thread-1');
    expect(result.turnId).toBe('turn-1');
    if (result.usage) {
      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(3);
      expect(result.usage.totalTokens).toBe(15);
    }

    await adapter.stop();
    expect(stop).toHaveBeenCalled();
    start.mockRestore();
    stop.mockRestore();
    onNotification.mockRestore();
    request.mockRestore();
  });

  it('marks a turn as visible as soon as turn/started arrives', async () => {
    vi.useFakeTimers();
    const start = vi.spyOn(CodexAppServerClient.prototype, 'start').mockResolvedValue(undefined);
    const stop = vi.spyOn(CodexAppServerClient.prototype, 'stop').mockResolvedValue(undefined);

    const listeners = new Map<string, Array<(params: any) => void>>();
    const onNotification = vi.spyOn(CodexAppServerClient.prototype, 'onNotification').mockImplementation((method: string, listener: (params: any) => void) => {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
      return () => {
        listeners.set(method, (listeners.get(method) || []).filter((item) => item !== listener));
      };
    });

    const request = vi.spyOn(CodexAppServerClient.prototype, 'request').mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'codex-test' } as any;
      if (method === 'thread/start') return { thread: { id: 'thread-2' } } as any;
      if (method === 'turn/start') {
        setTimeout(() => {
          for (const listener of listeners.get('turn/started') || []) {
            listener({
              threadId: 'thread-2',
              turn: { id: 'turn-2' },
            });
          }
        }, 0);
        setTimeout(() => {
          for (const listener of listeners.get('turn/completed') || []) {
            listener({
              threadId: 'thread-2',
              turn: { id: 'turn-2', status: 'completed' },
            });
          }
        }, 10);
        return { turn: { id: 'turn-2' } } as any;
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const adapter = new CodexHarnessAdapter('/tmp/project');
    const visibleSources: string[] = [];
    const runPromise = adapter.runTurn({
      prompt: 'hello',
      cwd: '/tmp/project',
      onTurnVisible: (source) => visibleSources.push(source),
    });

    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(visibleSources).toEqual(['turn.started']);
    expect(result.turnId).toBe('turn-2');

    await adapter.stop();
    vi.useRealTimers();
    start.mockRestore();
    stop.mockRestore();
    onNotification.mockRestore();
    request.mockRestore();
  });
});
