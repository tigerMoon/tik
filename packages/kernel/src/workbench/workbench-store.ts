import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  WorkbenchDecisionRecord,
  WorkbenchEvidenceRecord,
  WorkbenchSessionRecord,
  WorkbenchTaskRecord,
  WorkbenchTimelineItem,
} from '@tik/shared';

interface WorkbenchIndexFile {
  tasks: WorkbenchTaskRecord[];
  decisions: WorkbenchDecisionRecord[];
  evidences: WorkbenchEvidenceRecord[];
}

export interface WorkbenchTaskBundle {
  task: WorkbenchTaskRecord | null;
  session: WorkbenchSessionRecord | null;
  timeline: WorkbenchTimelineItem[];
}

export class WorkbenchStore {
  private indexOperationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly rootPath: string) {}

  async upsertTask(task: WorkbenchTaskRecord): Promise<void> {
    await this.withIndexLock(async () => {
      const index = await this.readIndex();
      index.tasks = [...index.tasks.filter((item) => item.id !== task.id), task];
      await this.writeIndex(index);
    });
  }

  async upsertSession(session: WorkbenchSessionRecord): Promise<void> {
    await this.writeJsonFileAtomic(
      path.join(this.sessionDir(), `${session.id}.json`),
      session,
    );
  }

  async listTasks(): Promise<WorkbenchTaskRecord[]> {
    return this.withIndexLock(async () => (await this.readIndex()).tasks);
  }

  async appendTimelineItem(item: WorkbenchTimelineItem): Promise<void> {
    await fs.mkdir(this.timelineDir(), { recursive: true });
    await fs.appendFile(
      path.join(this.timelineDir(), `${item.taskId}.jsonl`),
      `${JSON.stringify(item)}\n`,
      'utf-8',
    );
  }

  async appendDecision(decision: WorkbenchDecisionRecord): Promise<void> {
    await this.withIndexLock(async () => {
      const index = await this.readIndex();
      index.decisions = [...index.decisions.filter((item) => item.id !== decision.id), decision];
      await this.writeIndex(index);
    });
  }

  async readPendingDecisions(taskId: string): Promise<WorkbenchDecisionRecord[]> {
    return this.withIndexLock(async () => {
      const index = await this.readIndex();
      return index.decisions.filter((decision) => decision.taskId === taskId && decision.status === 'pending');
    });
  }

  async readDecision(decisionId: string): Promise<WorkbenchDecisionRecord | null> {
    return this.withIndexLock(async () => {
      const index = await this.readIndex();
      return index.decisions.find((decision) => decision.id === decisionId) ?? null;
    });
  }

  async readTaskBundle(taskId: string): Promise<WorkbenchTaskBundle> {
    const task = await this.withIndexLock(async () => {
      const index = await this.readIndex();
      return index.tasks.find((item) => item.id === taskId) ?? null;
    });
    const timeline = await this.readJsonLines<WorkbenchTimelineItem>(path.join(this.timelineDir(), `${taskId}.jsonl`));

    return {
      task,
      session: task ? await this.readTaskSession(task) : null,
      timeline,
    };
  }

  private rootDir(): string {
    return path.join(this.rootPath, '.tik', 'workbench');
  }

  private sessionDir(): string {
    return path.join(this.rootDir(), 'sessions');
  }

  private timelineDir(): string {
    return path.join(this.rootDir(), 'timelines');
  }

  private indexPath(): string {
    return path.join(this.rootDir(), 'index.json');
  }

  private async readIndex(): Promise<WorkbenchIndexFile> {
    const index = await this.readJsonDocument<WorkbenchIndexFile>(this.indexPath(), {
      fallbackToNullOnParseError: false,
    });
    return index ?? { tasks: [], decisions: [], evidences: [] };
  }

  private async writeIndex(index: WorkbenchIndexFile): Promise<void> {
    await this.writeJsonFileAtomic(this.indexPath(), index);
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.indexOperationQueue;
    let release!: () => void;
    this.indexOperationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readTaskSession(task: WorkbenchTaskRecord): Promise<WorkbenchSessionRecord | null> {
    if (task.activeSessionId) {
      return this.readJsonFile<WorkbenchSessionRecord>(path.join(this.sessionDir(), `${task.activeSessionId}.json`));
    }

    const sessions = await this.listSessionsForTask(task.id);
    return sessions[0] ?? null;
  }

  private async listSessionsForTask(taskId: string): Promise<WorkbenchSessionRecord[]> {
    try {
      const entries = await fs.readdir(this.sessionDir());
      const sessions = await Promise.all(entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => this.readJsonFile<WorkbenchSessionRecord>(path.join(this.sessionDir(), entry))));
      return sessions
        .filter((session): session is WorkbenchSessionRecord => session?.taskId === taskId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    return this.readJsonDocument<T>(filePath, {
      fallbackToNullOnParseError: true,
    });
  }

  private async readJsonDocument<T>(
    filePath: string,
    options: { fallbackToNullOnParseError: boolean },
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return null;
        }
        if (error instanceof SyntaxError && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          continue;
        }
        if (error instanceof SyntaxError && options.fallbackToNullOnParseError) {
          return null;
        }
        throw error;
      }
    }

    return null;
  }

  private async writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  private async readJsonLines<T>(filePath: string): Promise<T[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const parsed: T[] = [];

      lines.forEach((line, index) => {
        try {
          parsed.push(JSON.parse(line) as T);
        } catch (error) {
          if (error instanceof SyntaxError && index === lines.length - 1) {
            return;
          }
          throw error;
        }
      });

      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
