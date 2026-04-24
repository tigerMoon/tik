import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkflowSubtaskSpec } from '@tik/shared';

export type WorkspaceEventLevel = 'workspace' | 'project';
export type WorkspaceEventKind =
  | 'phase.started'
  | 'phase.completed'
  | 'phase.blocked'
  | 'phase.recovered'
  | 'artifact.detected'
  | 'artifact.missing'
  | 'subtask.started'
  | 'subtask.completed'
  | 'feedback.recorded';

export interface WorkspaceEventRecord {
  timestamp: string;
  level: WorkspaceEventLevel;
  kind: WorkspaceEventKind;
  phase: WorkflowSubtaskSpec['phase'];
  projectName?: string;
  taskId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceEventStoreOptions {
  persistPath?: string;
}

export class WorkspaceEventStore {
  private readonly records: WorkspaceEventRecord[] = [];
  private readonly persistPath?: string;

  constructor(options?: WorkspaceEventStoreOptions) {
    this.persistPath = options?.persistPath;
    if (this.persistPath) {
      this.loadPersistedRecords();
    }
  }

  record(event: Omit<WorkspaceEventRecord, 'timestamp'>): WorkspaceEventRecord {
    const record: WorkspaceEventRecord = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.records.push(record);
    if (this.persistPath) {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.appendFileSync(this.persistPath, `${JSON.stringify(record)}\n`, 'utf-8');
    }
    return record;
  }

  list(filter?: { phase?: WorkflowSubtaskSpec['phase']; projectName?: string }): WorkspaceEventRecord[] {
    return this.records.filter((record) => {
      if (filter?.phase && record.phase !== filter.phase) return false;
      if (filter?.projectName && record.projectName !== filter.projectName) return false;
      return true;
    });
  }

  latest(): WorkspaceEventRecord | undefined {
    return this.records.at(-1);
  }

  snapshot(): WorkspaceEventRecord[] {
    return [...this.records];
  }

  count(filter?: { phase?: WorkflowSubtaskSpec['phase']; projectName?: string; kind?: WorkspaceEventKind }): number {
    return this.records.filter((record) => {
      if (filter?.phase && record.phase !== filter.phase) return false;
      if (filter?.projectName && record.projectName !== filter.projectName) return false;
      if (filter?.kind && record.kind !== filter.kind) return false;
      return true;
    }).length;
  }

  private loadPersistedRecords(): void {
    try {
      const content = fs.readFileSync(this.persistPath!, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.records.push(JSON.parse(trimmed) as WorkspaceEventRecord);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
