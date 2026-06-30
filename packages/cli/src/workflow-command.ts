import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  loadTrackerWorkflow,
  type TrackerWorkflowDefinition,
  type TrackedTask,
} from '@tik/kernel';

export interface WorkflowInitOptions {
  workspaceRoot: string;
  file?: string;
  force?: boolean;
}

export interface WorkflowValidateOptions {
  workspaceRoot: string;
  file?: string;
}

export interface WorkflowExplainOptions {
  workspaceRoot: string;
  file?: string;
  taskId: string;
  task?: Partial<TrackedTask>;
}

export async function initWorkflowV2(options: WorkflowInitOptions): Promise<{ path: string; content: string; created: boolean }> {
  const workflowPath = resolveWorkflowCliPath(options.workspaceRoot, options.file);
  const existing = await fs.readFile(workflowPath, 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing !== undefined && !options.force) {
    return { path: workflowPath, content: existing, created: false };
  }
  const content = defaultTrackerWorkflowV2Content();
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  await fs.writeFile(workflowPath, content, 'utf-8');
  return { path: workflowPath, content, created: true };
}

export async function validateWorkflow(options: WorkflowValidateOptions): Promise<string> {
  const workflow = await loadWorkflowForCli(options.workspaceRoot, options.file);
  return formatWorkflowValidation(workflow);
}

export async function explainWorkflowTask(options: WorkflowExplainOptions): Promise<string> {
  const workflow = await loadWorkflowForCli(options.workspaceRoot, options.file);
  const task = makeExplainTask(options.taskId, options.task);
  const routing = workflow.resolveRouting(task);
  const projectPath = task.repository?.executionPath || task.repository?.path || options.workspaceRoot;
  return formatWorkflowExplain(workflow, task, {
    runner: routing.runner,
    mode: routing.mode,
    matchedSource: routing.matchedSource,
    projectPath,
  });
}

export function defaultTrackerWorkflowV2Content(): string {
  return [
    '---',
    'version: 2',
    'tracker:',
    '  kind: json',
    '  active_states:',
    '    - todo',
    '    - retry',
    '    - failed',
    '  terminal_states:',
    '    - completed',
    '    - accepted',
    '    - cancelled',
    '    - archived',
    'polling:',
    '  interval_ms: 30000',
    '  max_concurrent_agents: 2',
    'routing:',
    '  default_runner: codex',
    '  default_mode: codex_exec',
    'sandbox:',
    '  env_whitelist:',
    '    - NODE_ENV',
    '    - CI',
    'validation:',
    '  commands:',
    '    - pnpm typecheck',
    '    - pnpm test',
    'review:',
    '  require_human_acceptance: true',
    '---',
    'Implement {{ task.shortIdentifier }}: {{ task.title }}.',
    '',
    '{{ task.description }}',
    '',
    'Attempt: {{ attempt }}',
    '',
    '{% if previousReview %}',
    'Previous review rejection reason:',
    '{{ previousReview }}',
    '{% endif %}',
    '',
  ].join('\n');
}

export function formatWorkflowValidation(workflow: TrackerWorkflowDefinition): string {
  return [
    `Workflow: ${workflow.path || '(inline)'}`,
    `Version: ${workflow.version}`,
    `Routing: ${workflow.config.routing?.defaultRunner || 'none'} ${workflow.config.routing?.defaultMode || ''}`.trimEnd(),
    `Validation: ${workflow.config.validation?.commands.length ? workflow.config.validation.commands.join(', ') : 'none'}`,
    `Config hash: ${workflow.workflowConfigHash}`,
    `Prompt hash: ${workflow.workflowPromptHash}`,
  ].join('\n');
}

export function formatWorkflowExplain(
  workflow: TrackerWorkflowDefinition,
  task: TrackedTask,
  routing: {
    runner: string;
    mode: string;
    matchedSource: string;
    projectPath: string;
  },
): string {
  const validation = workflow.config.validation?.commands || [];
  return [
    `Task: ${task.shortIdentifier} ${task.title}`,
    `Selected runner: ${routing.runner}`,
    `Mode: ${routing.mode}`,
    `Matched: ${routing.matchedSource}`,
    `Project path: ${routing.projectPath}`,
    `Worktree: ${workflow.config.workspace.root}/${task.shortIdentifier}`,
    `Branch: tik/${task.shortIdentifier}`,
    `Sandbox env: ${workflow.config.sandbox?.envWhitelist.length ? workflow.config.sandbox.envWhitelist.join(', ') : 'none'}`,
    'Validation:',
    ...(validation.length ? validation.map((command) => `  - ${command}`) : ['  - none']),
    'Expected artifacts:',
    '  - run-review.md',
    '  - run-diff.patch',
    '  - run-diff-stat.txt',
    '  - run-transcript.txt',
    'Review policy:',
    '  - human required',
  ].join('\n');
}

function resolveWorkflowCliPath(workspaceRoot: string, file?: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  if (!file) return path.join(resolvedRoot, 'WORKFLOW.md');
  return path.isAbsolute(file) ? file : path.join(resolvedRoot, file);
}

function loadWorkflowForCli(workspaceRoot: string, file?: string): Promise<TrackerWorkflowDefinition> {
  const workflowPath = resolveWorkflowCliPath(workspaceRoot, file);
  return loadTrackerWorkflow(path.dirname(workflowPath), path.basename(workflowPath));
}

function makeExplainTask(taskId: string, task?: Partial<TrackedTask>): TrackedTask {
  return {
    id: task?.id || taskId,
    shortIdentifier: task?.shortIdentifier || taskId,
    title: task?.title || taskId,
    description: task?.description || '',
    state: task?.state || 'todo',
    stateKind: task?.stateKind || 'active',
    labels: task?.labels || [],
    blockedBy: task?.blockedBy || [],
    repository: task?.repository,
    comments: task?.comments,
    latestSummary: task?.latestSummary,
    agentLoop: task?.agentLoop,
  };
}
