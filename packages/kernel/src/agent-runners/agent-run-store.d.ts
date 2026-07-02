import type { AgentRunRecord, RunEvent } from '@tik/shared';
export declare class FileAgentRunStore {
    private readonly runsRoot;
    private readonly indexPath;
    constructor(workspaceRoot: string);
    createRun(record: AgentRunRecord): Promise<AgentRunRecord>;
    appendEvent(event: RunEvent): Promise<void>;
    readRun(runId: string): Promise<AgentRunRecord>;
    listRuns(): Promise<AgentRunRecord[]>;
    readEvents(runId: string): Promise<RunEvent[]>;
    private writeMetadata;
    private runDir;
    private metadataPath;
    private eventsPath;
}
//# sourceMappingURL=agent-run-store.d.ts.map