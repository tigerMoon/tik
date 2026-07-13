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

  it('returns the native Codex thread id and preserves the completed turn result', async () => {
    const input = await makeInput();
    const startThread = vi.fn(async () => 'thread-native-1');
    const runTurnOnThread = vi.fn(async () => ({
      content: 'reviewed',
      turnId: 'turn-native-1',
      threadId: 'thread-native-1',
    }));
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({
        runTurn: vi.fn(),
        startThread,
        runTurnOnThread,
        stop,
      }),
    });
    const prepared = {
      ...(await runner.prepare({ ...input, cleanContext: true, contextTokenBudget: 16_000 })),
      allowWrites: false,
      requireThreadId: true,
    };

    const handle = await runner.start(prepared);
    const completion = await handle.completion;

    expect(handle.threadId).toBe('thread-native-1');
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      allowWrites: false,
      cleanContext: true,
      maxPromptTokens: 16_000,
    }));
    expect(runTurnOnThread).toHaveBeenCalledWith('thread-native-1', expect.objectContaining({ allowWrites: false }));
    expect(completion).toEqual({
      status: 'completed',
      result: {
        content: 'reviewed',
        turnId: 'turn-native-1',
        threadId: 'thread-native-1',
      },
    });
    expect(stop).toHaveBeenCalled();
  });

  it('repairs malformed structured output on the same native thread', async () => {
    const input = await makeInput();
    const startThread = vi.fn(async () => 'thread-repair');
    const runTurnOnThread = vi.fn()
      .mockResolvedValueOnce({ content: 'analysis without json', turnId: 'turn-1', threadId: 'thread-repair' })
      .mockResolvedValueOnce({ content: '{"verdict":"pass"}', turnId: 'turn-2', threadId: 'thread-repair' });
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({ runTurn: vi.fn(), startThread, runTurnOnThread, stop }),
    });
    const prepared = {
      ...(await runner.prepare(input)),
      requireThreadId: true,
      structuredOutputRequired: true,
    };

    const handle = await runner.start(prepared);
    const completion = await handle.completion;

    expect(handle.threadId).toBe('thread-repair');
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(runTurnOnThread).toHaveBeenCalledTimes(2);
    expect(runTurnOnThread.mock.calls[1][0]).toBe('thread-repair');
    expect(runTurnOnThread.mock.calls[1][1].prompt).toMatch(/Return only the required JSON object/);
    expect(completion).toMatchObject({
      status: 'completed',
      result: { content: '{"verdict":"pass"}', threadId: 'thread-repair' },
    });
  });

  it('shares one Codex App Server adapter across parallel native threads', async () => {
    const first = await makeInput();
    const second = { ...first, runId: 'run-2', renderedPrompt: 'Review TIK-1.' };
    const resolvers = new Map<string, (value: { threadId: string }) => void>();
    const stop = vi.fn(async () => undefined);
    const adapterFactory = vi.fn(() => ({
      runTurn: vi.fn(),
      startThread: vi.fn(async (options: { prompt: string }) => `thread-${options.prompt}`),
      runTurnOnThread: vi.fn((threadId: string) => new Promise<{ threadId: string }>((resolve) => {
        resolvers.set(threadId, resolve);
      })),
      interruptThread: vi.fn(async () => undefined),
      stop,
    }));
    const runner = new CodexRunner({ mode: 'codex_app_server', adapterFactory });

    const firstHandle = await runner.start({ ...(await runner.prepare(first)), requireThreadId: true });
    const secondHandle = await runner.start({ ...(await runner.prepare(second)), requireThreadId: true });

    expect(adapterFactory).toHaveBeenCalledTimes(1);
    expect(firstHandle.threadId).toBe('thread-Implement TIK-1.');
    resolvers.get(firstHandle.threadId!)?.({ threadId: firstHandle.threadId! });
    resolvers.get(secondHandle.threadId!)?.({ threadId: secondHandle.threadId! });
    await Promise.all([firstHandle.completion, secondHandle.completion]);
    await waitFor(() => stop.mock.calls.length === 1);
    expect(stop).toHaveBeenCalledTimes(1);
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

  it('enforces timeoutMs for Codex App Server turns and stops the adapter', async () => {
    const input = { ...(await makeInput()), timeoutMs: 10 };
    const runTurn = vi.fn(() => new Promise(() => undefined));
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({ runTurn, stop }),
    });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);

    await expect(handle.completion).resolves.toEqual({
      status: 'failed',
      error: 'codex app-server timed out after 10ms.',
    });
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(runner.getStatus(input.runId)).resolves.toBe('failed');
  });

  it('extends the Codex App Server idle deadline when turn activity is visible', async () => {
    const input = { ...(await makeInput()), timeoutMs: 40 };
    const runTurn = vi.fn((options: { onTextDelta?: (text: string) => void }) => new Promise((resolve) => {
      setTimeout(() => options.onTextDelta?.('still reviewing'), 25);
      setTimeout(() => resolve({ content: '{"verdict":"pass"}' }), 55);
    }));
    const stop = vi.fn(async () => undefined);
    const runner = new CodexRunner({
      mode: 'codex_app_server',
      adapterFactory: () => ({ runTurn, stop }),
    });
    const prepared = await runner.prepare(input);

    const handle = await runner.start(prepared);

    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(stop).toHaveBeenCalledTimes(1);
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
    const runner = new ClaudeCodeRunner({
      mode: 'claude_print',
      pluginDirs: ['/plugins/review'],
      addDirs: [input.projectPath],
      permissionMode: 'bypassPermissions',
    });

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
      'bypassPermissions',
      '--output-format',
      'text',
      '--plugin-dir',
      '/plugins/review',
      '--add-dir',
      input.projectPath,
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
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4321;
    child.stdin = { write: vi.fn(), end: vi.fn() };
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
    ], expect.objectContaining({
      cwd: input.projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    expect(child.stdin.write).toHaveBeenCalledWith('Implement TIK-1.');
    expect(child.stdin.end).toHaveBeenCalled();
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
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', null));
      return true;
    });
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess: vi.fn(() => child) });
    const prepared = {
      ...(await runner.prepare(input)),
      timeoutMs: 10,
    };

    const handle = await runner.start(prepared);

    await expect(handle.completion).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^claude-code (?:timed out after 10ms|reached the 20ms hard timeout cap)\.$/),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(runner.getStatus('run-1')).resolves.toBe('failed');
  });

  it('extends the Claude idle deadline when runtime output provides a heartbeat', async () => {
    const input = await makeInput();
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 4324;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => true);
    const runner = new ClaudeCodeRunner({ mode: 'claude_print', spawnProcess: vi.fn(() => child) });
    const prepared = {
      ...(await runner.prepare(input)),
      timeoutMs: 40,
    };

    const handle = await runner.start(prepared);
    setTimeout(() => child.stdout.emit('data', Buffer.from('still reviewing\n')), 25);
    setTimeout(() => child.emit('exit', 0), 55);

    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
    expect(child.kill).not.toHaveBeenCalled();
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
