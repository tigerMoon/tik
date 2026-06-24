import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentRuntimeMode } from '@tik/shared';
import type {
  AgentRunHandle,
  AgentRunInput,
  AgentRunStatusSnapshot,
  AgentRuntimeRunner,
  ArtifactCandidate,
  PreparedRun,
} from './agent-runtime-runner.js';
import {
  assertRuntimeCwd,
  attachProcessLogs,
  buildRuntimeProcessEnv,
  childCompletion,
  type RuntimeChildProcess,
} from './runtime-process.js';

export interface ClaudeCodeRunnerOptions {
  mode?: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>;
  executable?: string;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;
}

export class ClaudeCodeRunner implements AgentRuntimeRunner {
  readonly name = 'claude-code' as const;
  private readonly mode?: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>;
  private readonly executable: string;
  private readonly statuses = new Map<string, AgentRunStatusSnapshot>();
  private readonly children = new Map<string, RuntimeChildProcess>();
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.mode = options.mode;
    this.executable = options.executable || 'claude';
    this.spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as RuntimeChildProcess);
  }

  async prepare(input: AgentRunInput): Promise<PreparedRun> {
    const mode = normalizeClaudeMode(this.mode || input.runnerMode);
    const promptFile = await writePromptFile(input);
    return {
      runId: input.runId,
      runner: this.name,
      mode,
      cwd: input.worktreePath || input.projectPath,
      command: this.executable,
      args: buildClaudeArgs(mode, input.renderedPrompt),
      promptFile,
      prompt: input.renderedPrompt,
      timeoutMs: input.timeoutMs,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.statuses.set(input.runId, 'running');
    await assertRuntimeCwd(input.cwd);
    const command = input.command || 'claude';
    const args = input.args || [];
    const child = this.spawnProcess(command, args, {
      cwd: input.cwd,
      env: buildRuntimeProcessEnv(input),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(input.runId, child);
    const logAttachment = attachProcessLogs(input, child);
    const completion = childCompletion(
      'claude-code',
      child,
      logAttachment.writers,
      (status) => {
        this.children.delete(input.runId);
        this.statuses.set(input.runId, status);
      },
      input.timeoutMs,
    );
    return {
      runId: input.runId,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      completion,
      stop: (reason) => this.stop(input.runId, reason),
    };
  }

  async stop(runId: string, _reason: string): Promise<void> {
    this.statuses.set(runId, 'cancelled');
    const child = this.children.get(runId);
    this.children.delete(runId);
    child?.kill('SIGTERM');
  }

  async getStatus(runId: string): Promise<AgentRunStatusSnapshot> {
    return this.statuses.get(runId) || 'unknown';
  }

  async collectTranscript(_runId: string) {
    return [];
  }

  async collectDiff(_runId: string) {
    return { changedFiles: [] };
  }

  async collectArtifacts(_runId: string): Promise<ArtifactCandidate[]> {
    return [];
  }

  async cleanup(runId: string): Promise<void> {
    await this.stop(runId, 'cleanup');
  }
}

function normalizeClaudeMode(mode: AgentRuntimeMode): Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'> {
  return mode === 'claude_hooked' ? 'claude_hooked' : 'claude_print';
}

function buildClaudeArgs(
  mode: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>,
  prompt: string,
): string[] {
  const printArgs = [
    '--print',
    '--permission-mode',
    'dontAsk',
    '--output-format',
    'text',
    prompt,
  ];
  return mode === 'claude_hooked' ? printArgs : printArgs;
}

async function writePromptFile(input: AgentRunInput): Promise<string> {
  const runDir = path.join(input.workspaceRoot, '.tik', 'runs', input.runId);
  await fs.mkdir(runDir, { recursive: true });
  const promptFile = path.join(runDir, 'prompt.md');
  await fs.writeFile(promptFile, input.renderedPrompt, 'utf-8');
  return promptFile;
}
