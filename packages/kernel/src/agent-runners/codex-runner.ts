import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentRuntimeMode } from '@tik/shared';
import { CodexHarnessAdapter, type CodexHarnessTurnOptions } from '../codex-harness-adapter.js';
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
  promiseCompletion,
  type RuntimeChildProcess,
} from './runtime-process.js';
import { collectGitDiffSummary, collectTranscriptFromRunLogs } from './runtime-collection.js';

export interface CodexHarnessLike {
  runTurn(options: CodexHarnessTurnOptions): Promise<unknown>;
  stop(): Promise<void>;
}

export interface CodexRunnerOptions {
  mode?: Extract<AgentRuntimeMode, 'codex_exec' | 'codex_app_server'>;
  executable?: string;
  adapterFactory?: (cwd: string) => CodexHarnessLike;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;
}

export class CodexRunner implements AgentRuntimeRunner {
  readonly name = 'codex' as const;
  private readonly mode?: Extract<AgentRuntimeMode, 'codex_exec' | 'codex_app_server'>;
  private readonly executable: string;
  private readonly adapterFactory: (cwd: string) => CodexHarnessLike;
  private readonly adapters = new Map<string, CodexHarnessLike>();
  private readonly children = new Map<string, RuntimeChildProcess>();
  private readonly preparedRuns = new Map<string, PreparedRun>();
  private readonly statuses = new Map<string, AgentRunStatusSnapshot>();
  private readonly spawnProcess: (command: string, args: string[], options: SpawnOptions) => RuntimeChildProcess;

  constructor(options: CodexRunnerOptions = {}) {
    this.mode = options.mode;
    this.executable = options.executable || 'codex';
    this.adapterFactory = options.adapterFactory || ((cwd) => new CodexHarnessAdapter(cwd));
    this.spawnProcess = options.spawnProcess || ((command, args, spawnOptions) => spawn(command, args, spawnOptions) as RuntimeChildProcess);
  }

  async prepare(input: AgentRunInput): Promise<PreparedRun> {
    const mode = normalizeCodexMode(this.mode || input.runnerMode);
    const promptFile = await writePromptFile(input);
    return {
      runId: input.runId,
      runner: this.name,
      mode,
      cwd: input.worktreePath || input.projectPath,
      command: mode === 'codex_exec' ? this.executable : undefined,
      args: mode === 'codex_exec'
        ? ['exec', '--sandbox', 'workspace-write', '--json', '--cd', input.worktreePath || input.projectPath, input.renderedPrompt]
        : undefined,
      promptFile,
      prompt: input.renderedPrompt,
      timeoutMs: input.timeoutMs,
    };
  }

  async start(input: PreparedRun): Promise<AgentRunHandle> {
    this.statuses.set(input.runId, 'running');
    this.preparedRuns.set(input.runId, input);
    await assertRuntimeCwd(input.cwd);
    if (input.mode === 'codex_app_server') {
      const adapter = this.adapterFactory(input.cwd);
      this.adapters.set(input.runId, adapter);
      const completion = promiseCompletion(
        adapter.runTurn({
          prompt: input.prompt || (input.promptFile ? await fs.readFile(input.promptFile, 'utf-8') : ''),
          cwd: input.cwd,
          allowWrites: true,
        }).finally(async () => {
          if (this.adapters.get(input.runId) !== adapter) {
            return;
          }
          this.adapters.delete(input.runId);
          await adapter.stop().catch(() => undefined);
        }),
        (status) => {
          this.statuses.set(input.runId, status);
        },
      );
      return {
        runId: input.runId,
        startedAt: new Date().toISOString(),
        completion,
        stop: (reason) => this.stop(input.runId, reason),
      };
    } else {
      const command = input.command || 'codex';
      const args = input.args || [];
      const child = this.spawnProcess(command, args, {
        cwd: input.cwd,
        env: buildRuntimeProcessEnv(input),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.set(input.runId, child);
      const logAttachment = attachProcessLogs(input, child);
      const completion = childCompletion(
        'codex',
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
  }

  async stop(runId: string, _reason: string): Promise<void> {
    this.statuses.set(runId, 'cancelled');
    const adapter = this.adapters.get(runId);
    this.adapters.delete(runId);
    const child = this.children.get(runId);
    this.children.delete(runId);
    child?.kill('SIGTERM');
    await adapter?.stop();
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
    await this.stop(runId, 'cleanup');
  }
}

function normalizeCodexMode(mode: AgentRuntimeMode): Extract<AgentRuntimeMode, 'codex_exec' | 'codex_app_server'> {
  return mode === 'codex_exec' ? 'codex_exec' : 'codex_app_server';
}

async function writePromptFile(input: AgentRunInput): Promise<string> {
  const runDir = path.join(input.workspaceRoot, '.tik', 'runs', input.runId);
  await fs.mkdir(runDir, { recursive: true });
  const promptFile = path.join(runDir, 'prompt.md');
  await fs.writeFile(promptFile, input.renderedPrompt, 'utf-8');
  return promptFile;
}
