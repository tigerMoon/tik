import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Liquid } from 'liquidjs';
import { parse as parseYaml } from 'yaml';
import type { TrackerWorkflowConfig, TrackerWorkflowDefinition, TrackedTask } from './types.js';

const DEFAULT_CONFIG: TrackerWorkflowConfig = {
  tracker: {
    kind: 'json',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Closed', 'Canceled', 'Cancelled'],
  },
  polling: {
    intervalMs: 30_000,
    maxConcurrentAgents: 3,
  },
  workspace: {
    root: '.symphony/workspaces',
    cleanupTerminal: false,
    hooks: {
      afterCreate: [],
      beforeRun: [],
      afterRun: [],
      beforeRemove: [],
    },
  },
  agent: {
    timeoutMs: 90_000,
  },
};

export async function loadTrackerWorkflow(rootPath: string, fileName = 'WORKFLOW.md'): Promise<TrackerWorkflowDefinition> {
  const workflowPath = path.isAbsolute(fileName) ? fileName : path.join(rootPath, fileName);
  const raw = await fs.readFile(workflowPath, 'utf-8');
  const { frontMatter, body } = splitFrontMatter(raw);
  const parsed = parseWorkflowYaml(frontMatter);
  const config = normalizeConfig(parsed);
  const promptTemplate = body.trim();
  const engine = new Liquid({ strictVariables: true, strictFilters: true });
  const parsedTemplate = engine.parse(promptTemplate);
  return {
    config,
    promptTemplate,
    renderPrompt(task: TrackedTask, input?: { attempt?: number }) {
      return renderPrompt(engine, parsedTemplate, task, input);
    },
  };
}

export async function resolveTrackerWorkflowPath(workspaceRoot: string, explicitPath?: string): Promise<string> {
  const candidates = explicitPath
    ? [path.isAbsolute(explicitPath) ? explicitPath : path.join(workspaceRoot, explicitPath)]
    : [
        path.join(workspaceRoot, '.tik', 'WORKFLOW.md'),
        path.join(workspaceRoot, 'WORKFLOW.md'),
      ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return candidates[0]!;
}

function splitFrontMatter(raw: string): { frontMatter: string; body: string } {
  if (!raw.startsWith('---\n')) {
    return { frontMatter: '', body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end === -1) {
    return { frontMatter: '', body: raw };
  }
  return {
    frontMatter: raw.slice(4, end),
    body: raw.slice(end + 4).replace(/^\r?\n/, ''),
  };
}

function normalizeConfig(parsed: Record<string, any>): TrackerWorkflowConfig {
  const topLevelHooks = parsed.hooks || {};
  const workspaceHooks = parsed.workspace?.hooks || {};
  const apiKeyEnv = parsed.tracker?.api_key_env || parsed.tracker?.apiKeyEnv;
  return {
    tracker: {
      kind: parsed.tracker?.kind || DEFAULT_CONFIG.tracker.kind,
      taskFile: parsed.tracker?.task_file || parsed.tracker?.taskFile || parsed.tracker?.issue_file || parsed.tracker?.issueFile,
      endpoint: parsed.tracker?.endpoint,
      ...(apiKeyEnv ? { apiKeyEnv: stripEnvPrefix(String(apiKeyEnv)) } : resolveApiKey(parsed.tracker?.api_key || parsed.tracker?.apiKey)),
      projectSlug: parsed.tracker?.project_slug || parsed.tracker?.projectSlug,
      activeStates: toStringArray(parsed.tracker?.active_states || parsed.tracker?.activeStates, DEFAULT_CONFIG.tracker.activeStates),
      terminalStates: toStringArray(parsed.tracker?.terminal_states || parsed.tracker?.terminalStates, DEFAULT_CONFIG.tracker.terminalStates),
    },
    polling: {
      intervalMs: toNumber(parsed.polling?.interval_ms || parsed.polling?.intervalMs, DEFAULT_CONFIG.polling.intervalMs),
      maxConcurrentAgents: toNumber(
        parsed.polling?.max_concurrent_agents
          || parsed.polling?.maxConcurrentAgents
          || parsed.agent?.max_concurrent_agents
          || parsed.agent?.maxConcurrentAgents,
        DEFAULT_CONFIG.polling.maxConcurrentAgents,
      ),
    },
    workspace: {
      root: parsed.workspace?.root || DEFAULT_CONFIG.workspace.root,
      cleanupTerminal: toBoolean(parsed.workspace?.cleanup_terminal ?? parsed.workspace?.cleanupTerminal, DEFAULT_CONFIG.workspace.cleanupTerminal),
      hooks: {
        afterCreate: toStringArray(workspaceHooks.after_create || workspaceHooks.afterCreate || topLevelHooks.after_create || topLevelHooks.afterCreate, []),
        beforeRun: toStringArray(workspaceHooks.before_run || workspaceHooks.beforeRun || topLevelHooks.before_run || topLevelHooks.beforeRun, []),
        afterRun: toStringArray(workspaceHooks.after_run || workspaceHooks.afterRun || topLevelHooks.after_run || topLevelHooks.afterRun, []),
        beforeRemove: toStringArray(workspaceHooks.before_remove || workspaceHooks.beforeRemove || topLevelHooks.before_remove || topLevelHooks.beforeRemove, []),
      },
    },
    agent: {
      timeoutMs: toNumber(parsed.agent?.timeout_ms || parsed.agent?.timeoutMs, DEFAULT_CONFIG.agent.timeoutMs),
    },
  };
}

function renderPrompt(
  engine: Liquid,
  parsedTemplate: ReturnType<Liquid['parse']>,
  task: TrackedTask,
  input?: { attempt?: number },
): string {
  const view = {
    task: {
      id: task.id,
      shortIdentifier: task.shortIdentifier,
      title: task.title,
      description: task.description || '',
      state: task.state,
      sourceUrl: task.sourceUrl || '',
      labels: task.labels,
    },
    issue: {
      id: task.id,
      identifier: task.shortIdentifier,
      title: task.title,
      description: task.description || '',
      state: task.state,
      url: task.sourceUrl || '',
      labels: task.labels,
    },
    attempt: input?.attempt || 0,
  };
  try {
    return engine.renderSync(parsedTemplate, view);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const variable = message.match(/undefined variable:\s*([^,]+)/i)?.[1]?.trim();
    throw new Error(variable ? `Unknown workflow template variable: ${variable}` : message);
  }
}

function parseWorkflowYaml(source: string): Record<string, any> {
  if (!source.trim()) return {};
  const parsed = parseYaml(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, any>;
}

export function defaultTrackerWorkflowContent(): string {
  return [
    '---',
    'tracker:',
    '  kind: json',
    'polling:',
    '  interval_ms: 30000',
    '  max_concurrent_agents: 3',
    'workspace:',
    '  root: .tik/workspaces',
    '  cleanup_terminal: false',
    '  hooks:',
    '    after_create: []',
    '    before_run: []',
    '    after_run: []',
    '    before_remove: []',
    'agent:',
    '  timeout_ms: 90000',
    '---',
    'Implement {{ task.shortIdentifier }}: {{ task.title }}.',
    '',
    '{{ task.description }}',
    '',
  ].join('\n');
}

export async function readTrackerWorkflowFile(workspaceRoot: string): Promise<{
  path: string;
  exists: boolean;
  content: string;
}> {
  const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot);
  try {
    return {
      path: workflowPath,
      exists: true,
      content: await fs.readFile(workflowPath, 'utf-8'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      path: workflowPath,
      exists: false,
      content: defaultTrackerWorkflowContent(),
    };
  }
}

export async function writeTrackerWorkflowFile(workspaceRoot: string, content: string): Promise<{
  path: string;
  content: string;
}> {
  const workflowPath = await resolveTrackerWorkflowPath(workspaceRoot);
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  await fs.writeFile(workflowPath, normalized, 'utf-8');
  return {
    path: workflowPath,
    content: normalized,
  };
}

function resolveApiKey(value: unknown): { apiKey?: string; apiKeyEnv?: string } {
  if (typeof value !== 'string' || !value) return {};
  if (value.startsWith('$')) return { apiKeyEnv: stripEnvPrefix(value) };
  return { apiKey: value };
}

function stripEnvPrefix(value: string): string {
  return value.startsWith('$') ? value.slice(1) : value;
}

function toStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
