import chalk from 'chalk';
import type { WorkspaceResolution, ConvergenceStrategy, AgentEvent } from '@tik/shared';
import type { ExecutionKernel } from '@tik/kernel';
import type { ProviderOption } from './types.js';
import { displayEvent, displayTaskResult } from './display/display.js';
import {
  createCliSession,
  listCliSessions,
  loadCliSession,
  saveCliSession,
  type PersistedCliSession,
} from './session-store.js';

export interface ShellConfig {
  projectPath: string;
  provider: ProviderOption;
  model?: string;
  mode: 'single' | 'multi';
  strategy: ConvergenceStrategy;
  maxIterations: number;
  resolution: WorkspaceResolution;
  resume?: string;
}

export interface ShellRuntime {
  kernel: ExecutionKernel;
  llmName: string;
  provider: ProviderOption;
}

export interface ShellContext {
  config: ShellConfig;
  createRuntime: (input: { projectPath: string; provider: ProviderOption; model?: string }) => ShellRuntime;
}

type ShellCommand =
  | { type: 'help' }
  | { type: 'status' }
  | { type: 'version' }
  | { type: 'model'; model?: string }
  | { type: 'init'; force: boolean }
  | { type: 'memory' }
  | { type: 'diff' }
  | { type: 'config'; section?: string }
  | { type: 'compact' }
  | { type: 'cost' }
  | { type: 'export'; path?: string }
  | { type: 'clear'; confirm: boolean }
  | { type: 'sessions' }
  | { type: 'resume'; target?: string }
  | { type: 'exit' }
  | { type: 'unknown'; name: string };

type ShellState = {
  startedAt: number;
};

export async function runShell({ config, createRuntime }: ShellContext): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('tik shell requires an interactive terminal (TTY)');
  }

  const state: ShellState = {
    startedAt: Date.now(),
  };

  let session = config.resume
    ? await loadCliSession(config.projectPath, config.resume)
    : createCliSession({
        sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
        projectPath: config.projectPath,
        provider: config.provider,
        llmName: config.provider,
        model: config.model,
        mode: config.mode,
        strategy: config.strategy,
        maxIterations: config.maxIterations,
      });

  let runtime = createRuntimeForSession(createRuntime, session);
  let unsubscribe = attachEventStream(runtime.kernel, (event) => {
    if (String(event.type) === 'session.usage') {
      const payload = event.payload as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      session.usage = {
        promptTokens: (session.usage?.promptTokens || 0) + (payload.promptTokens || 0),
        completionTokens: (session.usage?.completionTokens || 0) + (payload.completionTokens || 0),
        totalTokens: (session.usage?.totalTokens || 0) + (payload.totalTokens || 0),
      };
    }
  });

  session = await persistSession({
    ...session,
    provider: runtime.provider,
    llmName: runtime.llmName,
  });

  printShellHeader(session, config.resolution, Boolean(config.resume));

  while (true) {
    const input = await promptOnce(`tik:${pathLabel(session.projectPath)}> `);
    const trimmed = input.trim();

    if (!trimmed) {
      continue;
    }

    const command = parseShellCommand(trimmed);
    if (command) {
      const result = await handleShellCommand(command, session, state);
      if (result.type === 'exit') break;
      if (result.type === 'resume' && result.session) {
        unsubscribe();
        runtime.kernel.dispose();
        session = result.session;
        runtime = createRuntimeForSession(createRuntime, session);
        unsubscribe = attachEventStream(runtime.kernel, (event) => {
          if (String(event.type) === 'session.usage') {
            const payload = event.payload as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            session.usage = {
              promptTokens: (session.usage?.promptTokens || 0) + (payload.promptTokens || 0),
              completionTokens: (session.usage?.completionTokens || 0) + (payload.completionTokens || 0),
              totalTokens: (session.usage?.totalTokens || 0) + (payload.totalTokens || 0),
            };
          }
        });
        session = await persistSession({
          ...session,
          provider: runtime.provider,
          llmName: runtime.llmName,
        });
        console.log(chalk.green(`\nResumed session ${session.sessionId}\n`));
      }
      if (result.type === 'reconfigure' && result.session) {
        unsubscribe();
        runtime.kernel.dispose();
        session = result.session;
        runtime = createRuntimeForSession(createRuntime, session);
        unsubscribe = attachEventStream(runtime.kernel, (event) => {
          if (String(event.type) === 'session.usage') {
            const payload = event.payload as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            session.usage = {
              promptTokens: (session.usage?.promptTokens || 0) + (payload.promptTokens || 0),
              completionTokens: (session.usage?.completionTokens || 0) + (payload.completionTokens || 0),
              totalTokens: (session.usage?.totalTokens || 0) + (payload.totalTokens || 0),
            };
          }
        });
        session = await persistSession({
          ...session,
          provider: runtime.provider,
          llmName: runtime.llmName,
        });
        console.log(chalk.green(`\nUpdated runtime model to ${session.model || runtime.llmName}\n`));
      }
      continue;
    }

    session.turns += 1;
    session.lastPrompt = trimmed;
    session.transcript = [
      ...(session.transcript || []),
      { timestamp: new Date().toISOString(), kind: 'user', content: trimmed },
    ];
    session = await persistSession(session);

    console.log(chalk.bold(`\n── Turn ${session.turns} ──\n`));

    try {
      const result = await runtime.kernel.submitTask({
        description: trimmed,
        projectPath: session.projectPath,
        strategy: session.strategy,
        maxIterations: session.maxIterations,
        mode: session.mode,
      });

      session.lastTaskId = result.taskId;
      session.lastTaskStatus = result.status;
      session.transcript = [
        ...(session.transcript || []),
        {
          timestamp: new Date().toISOString(),
          kind: 'result',
          content: `Task ${result.taskId} finished with status=${result.status}, iterations=${result.totalIterations}, summary=${result.summary}`,
        },
      ];
      session = await persistSession(session);
      displayTaskResult(result);
    } catch (err) {
      session.transcript = [
        ...(session.transcript || []),
        {
          timestamp: new Date().toISOString(),
          kind: 'system',
          content: `Task failed: ${(err as Error).message}`,
        },
      ];
      session = await persistSession(session);
      console.log(chalk.red(`\nTask failed: ${(err as Error).message}\n`));
    }
  }

  unsubscribe();
  runtime.kernel.dispose();
  await persistSession(session);
  console.log(chalk.dim('\n  Shell closed.\n'));
}

async function handleShellCommand(
  command: ShellCommand,
  session: PersistedCliSession,
  state: ShellState,
): Promise<{ type: 'continue' } | { type: 'exit' } | { type: 'resume'; session: PersistedCliSession } | { type: 'reconfigure'; session: PersistedCliSession }> {
  switch (command.type) {
    case 'help':
      console.log('');
      console.log(chalk.bold('Slash commands'));
      console.log('  /help                  Show shell commands');
      console.log('  /status                Show current shell status');
      console.log('  /version               Show Tik CLI/runtime version info');
      console.log('  /model [name]          Show or update the active model override');
      console.log('  /init [--force]        Scaffold CLAUDE.md and AGENTS.md in the project');
      console.log('  /memory                Inspect local shell and .ace memory state');
      console.log('  /diff                  Show workspace git status and diff summary');
      console.log('  /config [section]      Show shell/env/session config');
      console.log('  /compact               Compact local shell transcript');
      console.log('  /cost                  Show cumulative token usage');
      console.log('  /export [file]         Export shell transcript to a file');
      console.log('  /clear --confirm       Clear local shell state');
      console.log('  /sessions              List saved shell sessions');
      console.log('  /resume <id-or-path>   Resume a saved shell session');
      console.log('  /session list          Alias for /sessions');
      console.log('  /session switch <id>   Alias for /resume <id>');
      console.log('  /exit                  Leave the shell');
      console.log('');
      return { type: 'continue' };

    case 'version': {
      console.log('');
      console.log(chalk.bold('Version'));
      console.log('  Tik CLI:        0.1.0');
      console.log(`  Provider:       ${session.provider}`);
      console.log(`  Runtime Model:  ${session.model || session.llmName}`);
      console.log(`  Session:        ${session.sessionId}`);
      console.log('');
      return { type: 'continue' };
    }

    case 'model': {
      if (!command.model) {
        console.log('');
        console.log(chalk.bold('Model'));
        console.log(`  Active Model:   ${session.model || session.llmName}`);
        console.log(`  Provider:       ${session.provider}`);
        console.log('');
        return { type: 'continue' };
      }

      const nextSession: PersistedCliSession = {
        ...session,
        model: command.model,
        transcript: [
          ...(session.transcript || []),
          {
            timestamp: new Date().toISOString(),
            kind: 'command',
            content: `Updated model override to ${command.model}`,
          },
        ],
      };
      await persistSession(nextSession);
      return { type: 'reconfigure', session: nextSession };
    }

    case 'init': {
      const created = await initializeProjectInstructions(session.projectPath, command.force);
      session.transcript = [
        ...(session.transcript || []),
        {
          timestamp: new Date().toISOString(),
          kind: 'command',
          content: `Initialized project instructions (${created.join(', ') || 'no changes'})`,
        },
      ];
      await persistSession(session);
      console.log('');
      console.log(chalk.bold('Init'));
      if (created.length === 0) {
        console.log('  Instruction files already exist. Use /init --force to rewrite them.');
      } else {
        for (const item of created) {
          console.log(`  Created: ${item}`);
        }
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'status': {
      const durationSec = Math.round((Date.now() - state.startedAt) / 1000);
      console.log('');
      console.log(chalk.bold('Shell Status'));
      console.log(`  Session:        ${session.sessionId}`);
      console.log(`  Project:        ${session.projectPath}`);
      console.log(`  Provider:       ${session.provider}`);
      console.log(`  Model:          ${session.model || session.llmName}`);
      console.log(`  Mode:           ${session.mode}`);
      console.log(`  Strategy:       ${session.strategy}`);
      console.log(`  Max Iterations: ${session.maxIterations}`);
      console.log(`  Turns:          ${session.turns}`);
      console.log(`  Duration:       ${durationSec}s`);
      if (session.lastTaskId) {
        console.log(`  Last Task:      ${session.lastTaskId} (${session.lastTaskStatus || 'unknown'})`);
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'memory': {
      const summary = await renderMemorySummary(session);
      console.log('');
      console.log(chalk.bold('Memory'));
      for (const line of summary) {
        console.log(line);
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'diff': {
      const lines = await renderDiffSummary(session.projectPath);
      console.log('');
      console.log(chalk.bold('Workspace Diff'));
      for (const line of lines) {
        console.log(line);
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'config': {
      const lines = renderConfigSummary(session, command.section);
      console.log('');
      console.log(chalk.bold('Config'));
      for (const line of lines) {
        console.log(line);
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'compact': {
      const entryCount = session.transcript?.length || 0;
      if (entryCount === 0) {
        console.log(chalk.yellow('\nNothing to compact.\n'));
        return { type: 'continue' };
      }
      const keyFacts = [
        session.lastTaskId ? `Last task ${session.lastTaskId} (${session.lastTaskStatus || 'unknown'})` : 'No task has run yet',
        session.lastPrompt ? `Last prompt: ${session.lastPrompt}` : 'No last prompt recorded',
      ];
      const pendingWork = session.lastTaskStatus === 'completed' || session.lastTaskStatus === 'converged'
        ? ['Continue from the latest completed conclusion or submit a follow-up task if code changes are still needed.']
        : ['Resume from the latest prompt/result pair before expanding the transcript again.'];
      const currentWork = session.lastPrompt
        ? `Continue the shell thread for: ${session.lastPrompt}`
        : 'Continue the current shell session';
      session.transcript = [
        {
          timestamp: new Date().toISOString(),
          kind: 'system',
          content: [
            'Continuation summary:',
            ...keyFacts.map((fact) => `- ${fact}`),
            `- Pending work: ${pendingWork.join(' | ')}`,
            `- Current work: ${currentWork}`,
          ].join('\n'),
        },
      ];
      session.compactedEntries = (session.compactedEntries || 0) + entryCount;
      session.compactSummary = {
        keyFacts,
        pendingWork,
        currentWork,
      };
      await persistSession(session);
      console.log(chalk.green(`\nCompacted ${entryCount} transcript entries into a local summary.\n`));
      return { type: 'continue' };
    }

    case 'cost': {
      const usage = session.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      console.log('');
      console.log(chalk.bold('Session Cost'));
      console.log(`  Prompt Tokens:      ${usage.promptTokens}`);
      console.log(`  Completion Tokens:  ${usage.completionTokens}`);
      console.log(`  Total Tokens:       ${usage.totalTokens}`);
      console.log('');
      return { type: 'continue' };
    }

    case 'export': {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const exportPath = command.path
        ? path.resolve(command.path)
        : path.join(session.projectPath, '.tik', 'exports', `${session.sessionId}.md`);
      await fs.mkdir(path.dirname(exportPath), { recursive: true });
      const lines = [
        `# Tik Shell Export`,
        ``,
        `- Session: ${session.sessionId}`,
        `- Project: ${session.projectPath}`,
        `- Provider: ${session.provider}`,
        `- Model: ${session.model || session.llmName}`,
        `- Mode: ${session.mode}`,
        `- Strategy: ${session.strategy}`,
        `- Turns: ${session.turns}`,
        `- Updated: ${session.updatedAt}`,
        ``,
        ...(session.compactSummary
          ? [
              `## Continuation Summary`,
              ``,
              ...session.compactSummary.keyFacts.map((fact) => `- ${fact}`),
              `- Pending work: ${session.compactSummary.pendingWork.join(' | ')}`,
              `- Current work: ${session.compactSummary.currentWork || '<none>'}`,
              ``,
            ]
          : []),
        `## Transcript`,
        ``,
        ...((session.transcript || []).map((entry) => `- [${entry.timestamp}] ${entry.kind}: ${entry.content}`)),
      ];
      await fs.writeFile(exportPath, lines.join('\n'), 'utf-8');
      session.transcript = [
        ...(session.transcript || []),
        {
          timestamp: new Date().toISOString(),
          kind: 'command',
          content: `Exported transcript to ${exportPath}`,
        },
      ];
      await persistSession(session);
      console.log(chalk.green(`\nExported transcript to ${exportPath}\n`));
      return { type: 'continue' };
    }

    case 'clear': {
      if (!command.confirm) {
        console.log(chalk.yellow('\nRefusing to clear without confirmation. Use /clear --confirm\n'));
        return { type: 'continue' };
      }
      session.turns = 0;
      session.lastTaskId = undefined;
      session.lastTaskStatus = undefined;
      session.lastPrompt = undefined;
      session.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      session.compactSummary = undefined;
      session.transcript = [
        {
          timestamp: new Date().toISOString(),
          kind: 'system',
          content: 'Session cleared with /clear --confirm',
        },
      ];
      await persistSession(session);
      console.log(chalk.green('\nCleared local shell state.\n'));
      return { type: 'continue' };
    }

    case 'sessions': {
      const sessions = await listCliSessions(session.projectPath);
      console.log('');
      console.log(chalk.bold('Saved Sessions'));
      if (sessions.length === 0) {
        console.log('  (none)');
      } else {
        for (const item of sessions.slice().reverse()) {
          const lastTask = item.lastTaskId ? ` | last task: ${item.lastTaskId} (${item.lastTaskStatus || 'unknown'})` : '';
          console.log(`  ${item.sessionId} | ${item.provider} | ${item.mode} | turns=${item.turns} | updated=${item.updatedAt}${lastTask}`);
        }
      }
      console.log('');
      return { type: 'continue' };
    }

    case 'resume': {
      if (!command.target) {
        console.log(chalk.yellow('\nUsage: /resume <session-id-or-path>\n'));
        return { type: 'continue' };
      }
      try {
        const resumed = await loadCliSession(session.projectPath, command.target);
        return { type: 'resume', session: resumed };
      } catch (err) {
        console.log(chalk.red(`\nFailed to resume session: ${(err as Error).message}\n`));
        return { type: 'continue' };
      }
    }

    case 'exit':
      return { type: 'exit' };

    case 'unknown':
      console.log(chalk.yellow(`\nUnknown command: /${command.name}\n`));
      return { type: 'continue' };
  }
}

async function persistSession(session: PersistedCliSession): Promise<PersistedCliSession> {
  await saveCliSession(session);
  return {
    ...session,
    updatedAt: new Date().toISOString(),
  };
}

function parseShellCommand(input: string): ShellCommand | null {
  if (!input.startsWith('/')) return null;

  const parts = input.trim().slice(1).split(/\s+/);
  const name = parts[0] || '';

  switch (name) {
    case 'help':
      return { type: 'help' };
    case 'version':
      return { type: 'version' };
    case 'model':
      return { type: 'model', model: parts[1] };
    case 'init':
      return { type: 'init', force: parts.includes('--force') };
    case 'status':
      return { type: 'status' };
    case 'memory':
      return { type: 'memory' };
    case 'diff':
      return { type: 'diff' };
    case 'config':
      return { type: 'config', section: parts[1] };
    case 'compact':
      return { type: 'compact' };
    case 'cost':
      return { type: 'cost' };
    case 'export':
      return { type: 'export', path: parts[1] };
    case 'clear':
      return { type: 'clear', confirm: parts.includes('--confirm') };
    case 'sessions':
      return { type: 'sessions' };
    case 'resume':
      return { type: 'resume', target: parts[1] };
    case 'session':
      if (parts[1] === 'list') return { type: 'sessions' };
      if (parts[1] === 'switch') return { type: 'resume', target: parts[2] };
      return { type: 'unknown', name: input.trim().slice(1) };
    case 'exit':
    case 'quit':
      return { type: 'exit' };
    default:
      return { type: 'unknown', name };
  }
}

function attachEventStream(kernel: ExecutionKernel, onEvent?: (event: AgentEvent) => void): () => void {
  return kernel.eventBus.onAny((event: AgentEvent) => {
    onEvent?.(event);
    displayEvent(event);
  });
}

function createRuntimeForSession(
  createRuntime: ShellContext['createRuntime'],
  session: PersistedCliSession,
): ShellRuntime {
  return createRuntime({
    projectPath: session.projectPath,
    provider: session.provider,
    model: session.model,
  });
}

function printShellHeader(session: PersistedCliSession, resolution: WorkspaceResolution, resumed: boolean): void {
  console.log(chalk.bold(`\n💬 Tik Shell${resumed ? ' (Resumed)' : ''}\n`));
  if (resolution.isWorkspace && resolution.workspace) {
    console.log(chalk.dim(`  Workspace: ${resolution.workspace.name}`));
  }
  console.log(chalk.dim(`  Session: ${session.sessionId}`));
  console.log(chalk.dim(`  Project: ${session.projectPath}`));
  console.log(chalk.dim(`  LLM: ${session.llmName} | Mode: ${session.mode} | Strategy: ${session.strategy} | Max: ${session.maxIterations}`));
  console.log(chalk.dim('  Type /help for commands.\n'));
}

async function promptOnce(promptText: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await rl.question(chalk.cyan(promptText));
  } finally {
    rl.close();
  }
}

function pathLabel(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

async function renderMemorySummary(session: PersistedCliSession): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const transcriptEntries = session.transcript?.length || 0;
  const compactedEntries = session.compactedEntries || 0;
  const lines = [
    `  Session transcript entries: ${transcriptEntries}`,
    `  Compacted entries:         ${compactedEntries}`,
    `  Last prompt:               ${session.lastPrompt || '<none>'}`,
  ];

  if (session.compactSummary) {
    lines.push(`  Current work:              ${session.compactSummary.currentWork || '<none>'}`);
    lines.push(`  Pending work:              ${session.compactSummary.pendingWork.join(' | ')}`);
  }

  const failuresPath = path.join(session.projectPath, '.ace', 'memory', 'failures.json');
  const decisionsPath = path.join(session.projectPath, '.ace', 'memory', 'decisions.json');

  try {
    const failures = JSON.parse(await fs.readFile(failuresPath, 'utf-8')) as unknown[];
    lines.push(`  Failure memory entries:     ${failures.length}`);
  } catch {
    lines.push('  Failure memory entries:     0');
  }

  try {
    const decisions = JSON.parse(await fs.readFile(decisionsPath, 'utf-8')) as unknown[];
    lines.push(`  Decision memory entries:    ${decisions.length}`);
  } catch {
    lines.push('  Decision memory entries:    0');
  }

  return lines;
}

async function renderDiffSummary(projectPath: string): Promise<string[]> {
  const childProcess = await import('node:child_process');
  const execFile = (cmd: string, args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    childProcess.execFile(cmd, args, { cwd: projectPath }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

  try {
    const [{ stdout: status }, { stdout: diffStat }] = await Promise.all([
      execFile('git', ['status', '--short']),
      execFile('git', ['diff', '--stat', '--no-ext-diff']),
    ]);

    const lines = ['  Git Status:'];
    if (status.trim()) {
      for (const line of status.trim().split('\n').slice(0, 20)) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push('    clean');
    }

    lines.push('  Diff Stat:');
    if (diffStat.trim()) {
      for (const line of diffStat.trim().split('\n').slice(0, 20)) {
        lines.push(`    ${line}`);
      }
    } else {
      lines.push('    no unstaged/staged diff');
    }

    return lines;
  } catch (err) {
    const message = (err as Error).message;
    const normalized = message.toLowerCase();
    if (normalized.includes('not a git repository')) {
      return ['  Workspace is not a git repository.'];
    }
    return [`  Git diff unavailable: ${message}`];
  }
}

function renderConfigSummary(session: PersistedCliSession, section?: string): string[] {
  const shellLines = [
    `  Session:       ${session.sessionId}`,
    `  Project:       ${session.projectPath}`,
    `  Provider:      ${session.provider}`,
    `  Model:         ${session.model || session.llmName}`,
    `  Mode:          ${session.mode}`,
    `  Strategy:      ${session.strategy}`,
    `  Max Iterations:${session.maxIterations}`,
  ];

  const envLines = [
    `  TIK_LLM_PROVIDER=${process.env.TIK_LLM_PROVIDER || '<unset>'}`,
    `  TIK_MODEL=${process.env.TIK_MODEL || '<unset>'}`,
    `  ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? '<set>' : '<unset>'}`,
    `  OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? '<set>' : '<unset>'}`,
    `  OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL || '<unset>'}`,
  ];

  const sessionLines = [
    `  Turns:         ${session.turns}`,
    `  Last Prompt:   ${session.lastPrompt || '<none>'}`,
    `  Last Task:     ${session.lastTaskId || '<none>'}`,
    `  Updated At:    ${session.updatedAt}`,
  ];

  if (section === 'env') return envLines;
  if (section === 'session') return sessionLines;
  if (section === 'shell') return shellLines;

  return [
    '  [shell]',
    ...shellLines,
    '  [session]',
    ...sessionLines,
    '  [env]',
    ...envLines,
  ];
}

async function initializeProjectInstructions(projectPath: string, force: boolean): Promise<string[]> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const targets = [
    {
      path: path.join(projectPath, 'CLAUDE.md'),
      content: [
        '# Project Instructions',
        '',
        '- Describe the project goal and constraints here.',
        '- Capture preferred workflows, validation rules, and review expectations.',
        '- Keep this file concise and actionable for coding agents.',
        '',
      ].join('\n'),
    },
    {
      path: path.join(projectPath, 'AGENTS.md'),
      content: [
        '# Agent Instructions',
        '',
        '- List important roles, ownership boundaries, and handoff expectations.',
        '- Document repository conventions that planner/coder/reviewer should follow.',
        '- Add task-specific coordination notes as they stabilize.',
        '',
      ].join('\n'),
    },
  ];

  const created: string[] = [];

  for (const target of targets) {
    let exists = false;
    try {
      await fs.access(target.path);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists && !force) continue;
    await fs.mkdir(path.dirname(target.path), { recursive: true });
    await fs.writeFile(target.path, target.content, 'utf-8');
    created.push(target.path);
  }

  return created;
}
