import * as fs from 'node:fs/promises';
import type { TrackedTask, TrackedTaskStateKind, TrackedTaskImporter } from './types.js';

export class JsonTaskImporter implements TrackedTaskImporter {
  constructor(private readonly filePath: string) {}

  async listCandidateTasks(): Promise<TrackedTask[]> {
    return this.readTasks();
  }

  async fetchTaskStatesByIds(taskIds: string[]): Promise<TrackedTask[]> {
    const ids = new Set(taskIds);
    return (await this.readTasks()).filter((task) => ids.has(task.id));
  }

  async fetchTasksByStates(stateNames: string[]): Promise<TrackedTask[]> {
    const states = new Set(stateNames);
    return (await this.readTasks()).filter((task) => states.has(task.state));
  }

  private async readTasks(): Promise<TrackedTask[]> {
    const raw = await fs.readFile(this.filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const tasks = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { tasks?: unknown[] }).tasks)
        ? (parsed as { tasks: unknown[] }).tasks
        : Array.isArray((parsed as { issues?: unknown[] }).issues)
        ? (parsed as { issues: unknown[] }).issues
        : [];
    return tasks.map(normalizeTask);
  }
}

function normalizeTask(input: unknown): TrackedTask {
  const task = input as Partial<TrackedTask> & {
    identifier?: string;
    url?: string | null;
    blocked_by?: Array<TrackedTask['blockedBy'][number] & { identifier?: string | null }>;
    state_kind?: TrackedTaskStateKind;
  };
  const shortIdentifier = task.shortIdentifier || task.identifier;
  if (!task.id || !shortIdentifier || !task.title) {
    throw new Error('Tracked task requires id, shortIdentifier, and title.');
  }
  return {
    id: task.id,
    shortIdentifier,
    title: task.title,
    description: task.description ?? null,
    priority: task.priority ?? null,
    state: task.state || task.stateKind || task.state_kind || 'active',
    stateKind: task.stateKind || task.state_kind || inferStateKind(task.state),
    sourceUrl: task.sourceUrl ?? task.url ?? null,
    labels: (task.labels || []).map((label) => label.toLowerCase()),
    blockedBy: normalizeBlockers(task.blockedBy || task.blocked_by || []),
    repository: task.repository,
    assignee: task.assignee ?? null,
    createdBy: task.createdBy ?? null,
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
  };
}

function normalizeBlockers(blockers: Array<TrackedTask['blockedBy'][number] & { identifier?: string | null }>): TrackedTask['blockedBy'] {
  return blockers.map((blocker) => ({
    id: blocker.id,
    shortIdentifier: blocker.shortIdentifier || blocker.identifier,
    state: blocker.state,
  }));
}

function inferStateKind(state?: string): TrackedTaskStateKind {
  const normalized = state?.toLowerCase();
  if (!normalized) return 'active';
  if (['done', 'closed', 'completed', 'cancelled', 'terminal'].includes(normalized)) return 'terminal';
  if (['blocked', 'waiting', 'needs human'].includes(normalized)) return 'blocked';
  return 'active';
}
