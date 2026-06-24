import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentRunRecord, RunEvent } from '@tik/shared';

export class FileAgentRunStore {
  private readonly runsRoot: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.runsRoot = path.join(workspaceRoot, '.tik', 'runs');
    this.indexPath = path.join(this.runsRoot, 'agent-runs.jsonl');
  }

  async createRun(record: AgentRunRecord): Promise<AgentRunRecord> {
    await fs.mkdir(this.runDir(record.id), { recursive: true });
    await fs.mkdir(this.runsRoot, { recursive: true });
    const existing = await this.readRun(record.id).catch(() => null);
    const next = existing || record;
    await this.writeMetadata(next);
    if (!existing) {
      await fs.appendFile(this.indexPath, `${JSON.stringify(indexRecord(next))}\n`, 'utf-8');
    }
    return next;
  }

  async appendEvent(event: RunEvent): Promise<void> {
    const run = await this.readRun(event.runId);
    await fs.mkdir(this.runDir(event.runId), { recursive: true });
    await fs.appendFile(this.eventsPath(event.runId), `${JSON.stringify(event)}\n`, 'utf-8');
    await this.writeMetadata(applyRunEvent(run, event));
  }

  async readRun(runId: string): Promise<AgentRunRecord> {
    const metadata = JSON.parse(await fs.readFile(this.metadataPath(runId), 'utf-8')) as AgentRunRecord;
    const events = await this.readEvents(runId).catch(() => []);
    return events.reduce(applyRunEvent, metadata);
  }

  async listRuns(): Promise<AgentRunRecord[]> {
    const index = await readJsonl<Pick<AgentRunRecord, 'id'>>(this.indexPath).catch(() => []);
    const seen = new Set<string>();
    const runs: AgentRunRecord[] = [];
    for (const item of index) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      runs.push(await this.readRun(item.id));
    }
    return runs;
  }

  async readEvents(runId: string): Promise<RunEvent[]> {
    return readJsonl<RunEvent>(this.eventsPath(runId));
  }

  private async writeMetadata(record: AgentRunRecord): Promise<void> {
    await fs.mkdir(this.runDir(record.id), { recursive: true });
    await fs.writeFile(this.metadataPath(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  }

  private runDir(runId: string): string {
    return path.join(this.runsRoot, runId);
  }

  private metadataPath(runId: string): string {
    return path.join(this.runDir(runId), 'metadata.json');
  }

  private eventsPath(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl');
  }
}

function indexRecord(record: AgentRunRecord): Pick<AgentRunRecord, 'id' | 'taskId' | 'shortIdentifier' | 'runner' | 'runnerMode'> {
  return {
    id: record.id,
    taskId: record.taskId,
    shortIdentifier: record.shortIdentifier,
    runner: record.runner,
    runnerMode: record.runnerMode,
  };
}

function applyRunEvent(record: AgentRunRecord, event: RunEvent): AgentRunRecord {
  const next: AgentRunRecord = {
    ...record,
    eventRefs: record.eventRefs.includes(event.kind) ? record.eventRefs : [...record.eventRefs, event.kind],
  };

  switch (event.kind) {
    case 'run.start':
      return {
        ...next,
        status: 'running',
        startedAt: event.ts,
        lastHeartbeatAt: event.ts,
      };
    case 'run.heartbeat':
      return {
        ...next,
        lastHeartbeatAt: event.ts,
      };
    case 'run.complete':
      return {
        ...next,
        status: 'completed_by_agent',
        endedAt: event.ts,
        artifactIds: mergeStrings(next.artifactIds, event.payload.artifactIds),
      };
    case 'run.fail':
      return {
        ...next,
        status: 'failed',
        endedAt: event.ts,
        failure: {
          kind: normalizeFailureKind(event.payload.kind),
          message: typeof event.payload.message === 'string' ? event.payload.message : 'Run failed.',
          retryable: event.payload.retryable !== false,
        },
      };
    case 'run.cancel':
      return {
        ...next,
        status: 'cancelled',
        endedAt: event.ts,
      };
    case 'artifact.discovered':
      return {
        ...next,
        artifactIds: mergeStrings(next.artifactIds, event.payload.artifactIds || event.payload.artifactId),
      };
    default:
      return next;
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function mergeStrings(current: string[], value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const next = new Set(current);
  for (const item of values) {
    if (typeof item === 'string' && item) next.add(item);
  }
  return Array.from(next);
}

function normalizeFailureKind(value: unknown): NonNullable<AgentRunRecord['failure']>['kind'] {
  return value === 'runtime_error'
    || value === 'permission_denied'
    || value === 'timeout'
    || value === 'validation_failed'
    || value === 'unknown'
    ? value
    : 'unknown';
}
