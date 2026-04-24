import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  type CodexJsonRpcMessage,
} from './codex-app-server-protocol.js';

export interface CodexAppServerProcessOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface CodexAppServerTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: CodexJsonRpcMessage): void;
  onMessage(listener: (message: CodexJsonRpcMessage) => void): () => void;
  onStderr(listener: (chunk: string) => void): () => void;
}

type SpawnFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export class CodexAppServerProcess implements CodexAppServerTransport {
  private child?: ChildProcessWithoutNullStreams;
  private readonly emitter = new EventEmitter();
  private buffer = '';

  constructor(
    private readonly options: CodexAppServerProcessOptions = {},
    private readonly spawnFactory: SpawnFactory = spawn,
  ) {}

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;

    const command = this.options.command || 'codex';
    const args = this.options.args || ['app-server', '--listen', 'stdio://'];
    const child = this.spawnFactory(command, args, {
      cwd: this.options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: 'pipe',
    });
    this.child = child;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            this.emitter.emit('message', JSON.parse(line) as CodexJsonRpcMessage);
          } catch {
            this.emitter.emit('stderr', `Invalid JSON from Codex App Server: ${line}`);
          }
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      this.emitter.emit('stderr', chunk);
    });

    child.on('close', () => {
      this.child = undefined;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
        resolve();
      }, 3000).unref();
    });
  }

  send(message: CodexJsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex App Server process is not running.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener: (message: CodexJsonRpcMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }

  onStderr(listener: (chunk: string) => void): () => void {
    this.emitter.on('stderr', listener);
    return () => this.emitter.off('stderr', listener);
  }
}

