import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TrackerDaemonState, TrackerDaemonStateStore } from './types.js';

export class FileTrackerDaemonStateStore implements TrackerDaemonStateStore {
  constructor(private readonly statePath: string) {}

  static forWorkspace(workspaceRoot: string): FileTrackerDaemonStateStore {
    return new FileTrackerDaemonStateStore(
      path.join(workspaceRoot, '.tik', 'tracker-daemon', 'state.json'),
    );
  }

  async load(): Promise<TrackerDaemonState> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyState();
      }
      throw err;
    }
  }

  async save(state: TrackerDaemonState): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, `${JSON.stringify(persistableState(state), null, 2)}\n`, 'utf-8');
  }
}

export function emptyState(): TrackerDaemonState {
  return { retries: {}, watching: false, recent: [] };
}

function normalizeState(value: unknown): TrackerDaemonState {
  const candidate = value as Partial<TrackerDaemonState> | null;
  return {
    runs: normalizeRuns(candidate?.runs),
    retries: normalizeRetries(candidate?.retries),
    watching: typeof candidate?.watching === 'boolean' ? candidate.watching : false,
    recent: normalizeRecent(candidate?.recent),
  };
}

function persistableState(value: TrackerDaemonState): TrackerDaemonState {
  return {
    retries: normalizeRetries(value.retries),
    watching: value.watching ?? false,
    recent: normalizeRecent(value.recent),
  };
}

function normalizeRuns(value: unknown): TrackerDaemonState['runs'] {
  if (!value || typeof value !== 'object') return {};
  const normalized: TrackerDaemonState['runs'] = {};
  for (const [key, rawRun] of Object.entries(value as Record<string, any>)) {
    const taskId = rawRun.taskId && rawRun.kernelTaskId ? rawRun.taskId : rawRun.issueId || key;
    const kernelTaskId = rawRun.kernelTaskId || rawRun.taskId;
    if (!taskId || !kernelTaskId) continue;
    normalized[taskId] = {
      taskId,
      shortIdentifier: rawRun.shortIdentifier || rawRun.identifier || taskId,
      kernelTaskId,
      workspaceRoot: rawRun.workspaceRoot,
      projectPath: rawRun.projectPath,
      startedAt: rawRun.startedAt,
      status: rawRun.status || 'running',
      lastTaskState: rawRun.lastTaskState || rawRun.lastIssueState || 'Unknown',
      lastSeenAt: rawRun.lastSeenAt || rawRun.startedAt,
    };
  }
  return normalized;
}

function normalizeRetries(value: unknown): TrackerDaemonState['retries'] {
  if (!value || typeof value !== 'object') return {};
  const normalized: TrackerDaemonState['retries'] = {};
  for (const [key, rawRetry] of Object.entries(value as Record<string, any>)) {
    const taskId = rawRetry.taskId || rawRetry.issueId || key;
    if (!taskId) continue;
    normalized[taskId] = {
      taskId,
      shortIdentifier: rawRetry.shortIdentifier || rawRetry.identifier || taskId,
      attempt: rawRetry.attempt || 0,
      dueAtMs: rawRetry.dueAtMs || 0,
      lastError: rawRetry.lastError || '',
      updatedAt: rawRetry.updatedAt || new Date(0).toISOString(),
    };
  }
  return normalized;
}

function normalizeRecent(value: unknown): NonNullable<TrackerDaemonState['recent']> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate?.type !== 'string' || typeof candidate?.message !== 'string' || typeof candidate?.createdAt !== 'string') {
        return null;
      }
      return {
        type: candidate.type as 'dispatched' | 'stopped' | 'skipped' | 'failed',
        shortIdentifier: typeof candidate.shortIdentifier === 'string' ? candidate.shortIdentifier : 'tracker',
        message: candidate.message,
        createdAt: candidate.createdAt,
      };
    })
    .filter((entry): entry is NonNullable<TrackerDaemonState['recent']>[number] => Boolean(entry))
    .slice(-20);
}
