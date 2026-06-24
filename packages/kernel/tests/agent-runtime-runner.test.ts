import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/agent-runners/codex-runner.js';
import { ClaudeCodeRunner } from '../src/agent-runners/claude-code-runner.js';
import type { AgentRunInput } from '../src/agent-runners/agent-runtime-runner.js';

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeInput(): Promise<AgentRunInput> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-agent-runtime-'));
  tempDirs.push(root);
  const projectPath = path.join(root, 'repo');
  await fs.mkdir(projectPath, { recursive: true });
  return {
    runId: 'run-1',
    task: {
      id: 'task-1',
      shortIdentifier: 'TIK-1',
      title: 'Ship it',
      state: 'Todo',
      stateKind: 'active',
      labels: ['ready'],
      blockedBy: [],
    },
    attempt: 0,
    runnerMode: 'codex_app_server',
    workflowPath: path.join(root, '.tik', 'WORKFLOW.md'),
    workflowConfigHash: 'config-hash',
    workflowPromptHash: 'prompt-hash',
    renderedPrompt: 'Implement TIK-1.',
    workspaceRoot: root,
    projectPath,
    labels: ['ready'],
    artifactOutputDir: path.join(root, '.tik', 'artifacts', 'TIK-1', 'attempt-0'),
  };
}

describe('AgentRuntimeRunner implementations', () => {
  it('prepares codex exec runs with a persisted prompt file', async () => {
    const input = await makeInput();
    const runner = new CodexRunner({ mode: 'codex_exec' });

    const prepared = await runner.prepare(input);

    expect(prepared).toMatchObject({
      runId: 'run-1',
      runner: 'codex',
      mode: 'codex_exec',
      cwd: input.projectPath,
      command: 'codex',
    });
    expect(prepared.args).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      '--cd',
      input.projectPath,
      'Implement TIK-1.',
    ]);
    await expect(fs.readFile(prepared.promptFile!, 'utf-8')).resolves.toBe('Implement TIK-1.');
  });

  it('honors routed codex runner mode when the runner was not fixed to a mode', async () => {
    const input = {
      ...(await makeInput()),
      runnerMode: 'codex_exec',
    } as AgentRunInput;
    const runner = new CodexRunner();

    const prepared = await runner.prepare(input);

    expect(prepared).toMatchObject({
      runner: 'codex',
      mode: 'codex_exec',
      command: 'codex',
    });
  });

  it('starts codex app-server runs through the existing harness adapter', async () => {
    const input = await makeInput();
    const runTurn = vi.fn(async () => ({ content: 'done', turnId: 'turn-1', threadId: 'thread-1' }));
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({ runTurn, stop }),
    });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);
    await Promise.resolve();
    await handle.stop('test');

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Implement TIK-1.',
      cwd: input.projectPath,
      allowWrites: true,
    }));
    expect(stop).toHaveBeenCalled();
  });

  it('stops codex app-server adapters when a run fails', async () => {
    const input = await makeInput();
    const runTurn = vi.fn(async () => {
      throw new Error('Codex App Server request timed out: initialize');
    });
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({ runTurn, stop }),
    });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);

    await expect(handle.completion).resolves.toEqual({
      status: 'failed',
      error: 'Codex App Server request timed out: initialize',
    });
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(runner.getStatus(input.runId)).resolves.toBe('failed');
  });

  it('starts codex exec runs as child processes and persists stdout and stderr logs', async () => {
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child);
    const runner = new CodexRunner({ mode: 'codex_exec', spawnProcess });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);
    child.stdout.emit('data', Buffer.from('done\n'));
    child.stderr.emit('data', Buffer.from('note\n'));
    child.emit('exit', 0);

    await waitFor(async () => (await runner.getStatus('run-1')) === 'completed');
    expect(handle.pid).toBe(1234);
    expect(spawnProcess).toHaveBeenCalledWith('codex', [
      'exec',
      '--sandbox',
      'workspace-write',
      '--json',
      '--cd',
      input.projectPath,
      'Implement TIK-1.',
    ], expect.objectContaining({
      cwd: input.projectPath,
    }));
    await expect(fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stdout.log'), 'utf-8')).resolves.toBe('done\n');
    await expect(fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stderr.log'), 'utf-8')).resolves.toBe('note\n');
  });

  it('starts codex exec runs with only explicit env and redacts sensitive env values from logs', async () => {
    process.env.TIK_TEST_SHOULD_NOT_LEAK = 'host-secret';
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 1235;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child);
    const runner = new CodexRunner({ mode: 'codex_exec', spawnProcess });
    const prepared = {
      ...(await runner.prepare(input)),
      env: {
        GITHUB_TOKEN: 'token-secret-value',
        TIK_RUN_ID: 'run-1',
      },
    };

    await runner.start(prepared);
    child.stdout.emit('data', Buffer.from('token-secret-value\n'));
    child.stderr.emit('data', Buffer.from('host-secret token-secret-value\n'));
    child.emit('exit', 0);

    await waitFor(async () => (await runner.getStatus('run-1')) === 'completed');
    expect(spawnProcess).toHaveBeenCalledWith('codex', expect.any(Array), expect.objectContaining({
      env: {
        GITHUB_TOKEN: 'token-secret-value',
        TIK_RUN_ID: 'run-1',
      },
    }));
    const stdout = await fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stdout.log'), 'utf-8');
    const stderr = await fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stderr.log'), 'utf-8');
    expect(stdout).toBe('[REDACTED]\n');
    expect(stderr).toBe('host-secret [REDACTED]\n');
  });

  it('prepares claude print runs with a persisted prompt file', async () => {
    const input = await makeInput();
    const runner = new ClaudeCodeRunner({ mode: 'claude_print' });

    const prepared = await runner.prepare(input);

    expect(prepared).toMatchObject({
      runId: 'run-1',
      runner: 'claude-code',
      mode: 'claude_print',
      cwd: input.projectPath,
      command: 'claude',
    });
    expect(prepared.args).toEqual([
      '--print',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'text',
      'Implement TIK-1.',
    ]);
    await expect(fs.readFile(prepared.promptFile!, 'utf-8')).resolves.toBe('Implement TIK-1.');
  });

  it('honors routed Claude Code runner mode when the runner was not fixed to a mode', async () => {
    const input = {
      ...(await makeInput()),
      runnerMode: 'claude_hooked',
    } as AgentRunInput;
    const runner = new ClaudeCodeRunner();

    const prepared = await runner.prepare(input);

    expect(prepared).toMatchObject({
      runner: 'claude-code',
      mode: 'claude_hooked',
      command: 'claude',
    });
  });

  it('starts Claude Code print runs as child processes and persists stdout and stderr logs', async () => {
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnProcess = vi.fn(() => child);
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);
    child.stdout.emit('data', Buffer.from('review ok\n'));
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.emit('exit', 0);

    await waitFor(async () => (await runner.getStatus('run-1')) === 'completed');
    expect(handle.pid).toBe(4321);
    expect(spawnProcess).toHaveBeenCalledWith('claude', [
      '--print',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'text',
      'Implement TIK-1.',
    ], expect.objectContaining({
      cwd: input.projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    await expect(fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stdout.log'), 'utf-8')).resolves.toBe('review ok\n');
    await expect(fs.readFile(path.join(input.workspaceRoot, '.tik', 'runs', 'run-1', 'stderr.log'), 'utf-8')).resolves.toBe('warn\n');
  });

  it('times out Claude Code print runs so tracker tasks cannot hang forever', async () => {
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4323;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess: vi.fn(() => child) });
    const prepared = {
      ...(await runner.prepare(input)),
      timeoutMs: 10,
    };

    const handle = await runner.start(prepared);

    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      error: 'claude-code timed out after 10ms.',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(runner.getStatus('run-1')).resolves.toBe('failed');
  });

  it('reports a missing Claude Code working directory before spawning the child process', async () => {
    const input = await makeInput();
    const missingProjectPath = path.join(input.workspaceRoot, 'missing-worktree');
    const spawnProcess = vi.fn();
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess });
    const prepared = {
      ...(await runner.prepare(input)),
      cwd: missingProjectPath,
    };

    await expect(runner.start(prepared)).rejects.toThrow(`Runtime working directory does not exist: ${missingProjectPath}`);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('exposes Claude Code process completion to the tracker daemon', async () => {
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4322;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess: vi.fn(() => child) });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);
    child.emit('exit', 1);

    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      error: 'claude-code exited with code 1.',
    });
    await expect(runner.getStatus('run-1')).resolves.toBe('failed');
  });
});

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
