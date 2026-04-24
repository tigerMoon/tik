import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerProcess } from '../src/codex-app-server-process.js';

function createFakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdout.setEncoding('utf-8');
  stderr.setEncoding('utf-8');
  const emitter = new EventEmitter() as any;
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  emitter.stdin = stdin;
  emitter.killed = false;
  emitter.kill = vi.fn((signal?: string) => {
    emitter.killed = true;
    emitter.emit('close', signal === 'SIGKILL' ? 137 : 0);
    return true;
  });
  emitter.once = emitter.once.bind(emitter);
  emitter.on = emitter.on.bind(emitter);
  emitter.emit = emitter.emit.bind(emitter);
  return emitter;
}

describe('CodexAppServerProcess', () => {
  it('spawns codex app-server stdio and parses json lines', async () => {
    const child = createFakeChild();
    const spawnFactory = vi.fn(() => child);
    const process = new CodexAppServerProcess({ cwd: '/tmp/project' }, spawnFactory as any);

    const messages: unknown[] = [];
    const stderr: string[] = [];
    process.onMessage((message) => messages.push(message));
    process.onStderr((chunk) => stderr.push(chunk));

    await process.start();
    expect(spawnFactory).toHaveBeenCalledWith(
      'codex',
      ['app-server', '--listen', 'stdio://'],
      expect.objectContaining({ cwd: '/tmp/project', stdio: 'pipe' }),
    );

    child.stdout.write('{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"t1"}}\n');
    child.stdout.write('not-json\n');

    expect(messages).toEqual([
      { jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1' } },
    ]);
    expect(stderr.join('')).toContain('Invalid JSON from Codex App Server');

    await process.stop();
    expect(child.kill).toHaveBeenCalled();
  });
});

