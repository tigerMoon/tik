import type { WorkbenchDecisionRecord, WorkbenchSessionRecord, WorkbenchTaskRecord, WorkbenchTimelineItem } from '@tik/shared';
export interface WorkbenchTaskBundle {
    task: WorkbenchTaskRecord | null;
    session: WorkbenchSessionRecord | null;
    timeline: WorkbenchTimelineItem[];
}
export declare class WorkbenchStore {
    private readonly rootPath;
    private indexOperationQueue;
    constructor(rootPath: string);
    upsertTask(task: WorkbenchTaskRecord): Promise<void>;
    upsertSession(session: WorkbenchSessionRecord): Promise<void>;
    listTasks(): Promise<WorkbenchTaskRecord[]>;
    appendTimelineItem(item: WorkbenchTimelineItem): Promise<void>;
    appendDecision(decision: WorkbenchDecisionRecord): Promise<void>;
    readPendingDecisions(taskId: string): Promise<WorkbenchDecisionRecord[]>;
    readDecision(decisionId: string): Promise<WorkbenchDecisionRecord | null>;
    readTaskBundle(taskId: string): Promise<WorkbenchTaskBundle>;
    private rootDir;
    private sessionDir;
    private timelineDir;
    private indexPath;
    private readIndex;
    private writeIndex;
    private backfillTaskIdentifiers;
    private normalizeTaskIdentifiers;
    private buildNextIdentifier;
    private withIndexLock;
    private readTaskSession;
    private listSessionsForTask;
    private readJsonFile;
    private readJsonDocument;
    private writeJsonFileAtomic;
    private readJsonLines;
}
//# sourceMappingURL=workbench-store.d.ts.map