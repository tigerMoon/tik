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
  terminateRuntimeChild,
  type RuntimeChildProcess,
} from './runtime-process.js';
import { collectGitDiffSummary, collectTranscriptFromRunLogs } from './runtime-collection.js';

export interface ClaudeCodeRunnerOptions {
  mode?: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>;
  executable?: string;
  pluginDirs?: string[];
  addDirs?: string[];
  permissionMode?: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;
}

export class ClaudeCodeRunner implements AgentRuntimeRunner {
  readonly name = 'claude-code' as const;
  private readonly mode?: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>;
  private readonly executable: string;
  private readonly pluginDirs: string[];
  private readonly addDirs: string[];
  private readonly permissionMode: NonNullable<ClaudeCodeRunnerOptions['permissionMode']>;
  private readonly statuses = new Map<string, AgentRunStatusSnapshot>();
  private readonly children = new Map<string, RuntimeChildProcess>();
  private readonly preparedRuns = new Map<string, PreparedRun>();
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.mode = options.mode;
    this.executable = options.executable || 'claude';
    this.pluginDirs = options.pluginDirs || splitPathList(process.env.TIK_CLAUDE_CODE_PLUGIN_DIRS);
    this.addDirs = options.addDirs || splitPathList(process.env.TIK_CLAUDE_CODE_ADD_DIRS);
    this.permissionMode = options.permissionMode || normalizePermissionMode(process.env.TIK_CLAUDE_CODE_PERMISSION_MODE) || 'dontAsk';
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
      args: buildClaudeArgs(mode, input.renderedPrompt, {
        pluginDirs: this.pluginDirs,
        addDirs: this.addDirs,
        permissionMode: this.permissionMode,
      }),
      promptFile,
      prompt: input.renderedPrompt,
      timeoutMs: input.timeoutMs,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.statuses.set(input.runId, 'running');
    this.preparedRuns.set(input.runId, input);
    await assertRuntimeCwd(input.cwd);
    const command = input.command || 'claude';
    const args = input.args || [];
    const child = this.spawnProcess(command, args, {
      cwd: input.cwd,
      env: buildRuntimeProcessEnv(input),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (input.prompt !== undefined) {
      child.stdin?.write(input.prompt);
      child.stdin?.end();
    }
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
    if (child) await terminateRuntimeChild(child);
  }

  async getStatus(runId: string): Promise<AgentRunStatusSnapshot> {
    return this.statuses.get(runId) || 'unknown';
  }

  async collectTranscript(_runId: string) {
    const prepared = this.preparedRuns.get(_runId);
    return prepared ? collectTranscriptFromRunLogs(prepared) : [];
  }

  async collectDiff(_runId: string) {
    const prepared = this.preparedRuns.get(_runId);
    return prepared ? collectGitDiffSummary(prepared) : { changedFiles: [] };
  }

  async collectArtifacts(_runId: string): Promise<ArtifactCandidate[]> {
    return [];
  }

  async cleanup(runId: string): Promise<void> {
    if (this.children.has(runId)) {
      await this.stop(runId, 'cleanup');
    }
    this.preparedRuns.delete(runId);
    this.statuses.delete(runId);
  }
}

function normalizeClaudeMode(mode: AgentRuntimeMode): Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'> {
  return mode === 'claude_hooked' ? 'claude_hooked' : 'claude_print';
}

function buildClaudeArgs(
  _mode: Extract<AgentRuntimeMode, 'claude_print' | 'claude_hooked'>,
  _prompt: string,
  options: {
    pluginDirs?: string[];
    addDirs?: string[];
    permissionMode: NonNullable<ClaudeCodeRunnerOptions['permissionMode']>;
  },
): string[] {
  const printArgs = [
    '--print',
    '--permission-mode',
    options.permissionMode,
    '--output-format',
    'text',
    ...flatRepeat('--plugin-dir', options.pluginDirs || []),
    ...flatRepeat('--add-dir', options.addDirs || []),
  ];
  return printArgs;
}

function flatRepeat(flag: string, values: string[]): string[] {
  return values.flatMap((value) => value ? [flag, value] : []);
}

function splitPathList(value: string | undefined): string[] {
  return (value || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePermissionMode(value: string | undefined): ClaudeCodeRunnerOptions['permissionMode'] | undefined {
  if (
    value === 'acceptEdits'
    || value === 'auto'
    || value === 'bypassPermissions'
    || value === 'default'
    || value === 'dontAsk'
    || value === 'plan'
  ) {
    return value;
  }
  return undefined;
}

async function writePromptFile(input: AgentRunInput): Promise<string> {
  const runDir = path.join(input.workspaceRoot, '.tik', 'runs', input.runId);
  await fs.mkdir(runDir, { recursive: true });
  const promptFile = path.join(runDir, 'prompt.md');
  await fs.writeFile(promptFile, input.renderedPrompt, 'utf-8');
  return promptFile;
}
