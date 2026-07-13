import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EventEmitter } from 'node:events';
import type { AgentRunCompletion, PreparedRun } from './agent-runtime-runner.js';

export type RuntimeChildProcess = EventEmitter & {
  pid?: number;
  stdin?: {
    write(chunk: string | Uint8Array): unknown;
    end(): unknown;
  };
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
};

export interface RuntimeLogAttachment {
  writers: Promise<unknown>[];
  redactedEnv: Record<string, string>;
}

export function buildRuntimeProcessEnv(input: PreparedRun): Record<string, string> {
  return { ...(input.env || {}) };
}

export async function assertRuntimeCwd(cwd: string): Promise<void> {
  const stat = await fs.stat(cwd).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Runtime working directory does not exist: ${cwd}`);
    }
    throw error;
  });
  if (!stat.isDirectory()) {
    throw new Error(`Runtime working directory is not a directory: ${cwd}`);
  }
}

export function attachProcessLogs(input: PreparedRun, child: RuntimeChildProcess): RuntimeLogAttachment {
  const runDir = input.promptFile ? path.dirname(input.promptFile) : path.join(input.cwd, '.tik', 'runs', input.runId);
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const redactedEnv = input.env || {};
  const writers: Promise<unknown>[] = [];
  child.stdout?.on('data', (chunk) => {
    writers.push(appendLog(stdoutPath, redactChunk(chunk, redactedEnv)));
  });
  child.stderr?.on('data', (chunk) => {
    writers.push(appendLog(stderrPath, redactChunk(chunk, redactedEnv)));
  });
  return { writers, redactedEnv };
}

export function childCompletion(
  runtimeName: string,
  child: RuntimeChildProcess,
  logWriters: Promise<unknown>[],
  onSettled: (status: AgentRunCompletion['status']) => void,
  timeoutMs?: number,
): Promise<AgentRunCompletion> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (completion: AgentRunCompletion) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      void Promise.allSettled(logWriters).then(() => {
        onSettled(completion.status);
        resolve(completion);
      });
    };

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        void terminateRuntimeChild(child).finally(() => {
          settle({
            status: 'failed',
            error: `${runtimeName} timed out after ${timeoutMs}ms.`,
          });
        });
      }, timeoutMs);
    }

    child.on('exit', (code) => {
      if (timedOut) {
        settle({ status: 'failed', error: `${runtimeName} timed out after ${timeoutMs}ms.` });
        return;
      }
      if (code === 0) {
        settle({ status: 'completed' });
      } else {
        settle({
          status: 'failed',
          error: `${runtimeName} exited with code ${code ?? 'unknown'}.`,
        });
      }
    });
    child.on('error', (err) => {
      const error = err instanceof Error ? err.message : String(err);
      settle({
        status: 'failed',
        error: `${runtimeName} failed to start: ${error}`,
      });
    });
  });
}

export async function terminateRuntimeChild(child: RuntimeChildProcess, graceMs = 2_000): Promise<void> {
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    const markExited = () => {
      exited = true;
      resolve();
    };
    child.once('exit', markExited);
    child.once('close', markExited);
  });
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
  if (!exited) {
    child.kill('SIGKILL');
  }
}

export function promiseCompletion<T>(
  promise: Promise<T>,
  onSettled: (status: AgentRunCompletion['status']) => void,
  resultMapper?: (value: T) => Record<string, unknown>,
  timeoutMs?: number,
  onTimeout?: () => Promise<void> | void,
): Promise<AgentRunCompletion> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (completion: AgentRunCompletion) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      onSettled(completion.status);
      resolve(completion);
    };
    void promise.then(
      (value) => settle({ status: 'completed', result: resultMapper?.(value) }),
      (err) => settle({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        void Promise.resolve(onTimeout?.()).catch(() => undefined).finally(() => {
          settle({ status: 'failed', error: `codex app-server timed out after ${timeoutMs}ms.` });
        });
      }, timeoutMs);
    }
  });
}

function redactChunk(chunk: string | Uint8Array, env: Record<string, string>): string | Uint8Array {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
  const redacted = sensitiveValues(env).reduce((current, secret) => current.split(secret).join('[REDACTED]'), text);
  return redacted;
}

function sensitiveValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && isSensitiveEnvKey(key))
    .map(([, value]) => value)
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

function isSensitiveEnvKey(key: string): boolean {
  return /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i.test(key);
}

async function appendLog(filePath: string, chunk: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, chunk);
}
