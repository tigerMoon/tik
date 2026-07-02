import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class FileAgentRunStore {
    runsRoot;
    indexPath;
    constructor(workspaceRoot) {
        this.runsRoot = path.join(workspaceRoot, '.tik', 'runs');
        this.indexPath = path.join(this.runsRoot, 'agent-runs.jsonl');
    }
    async createRun(record) {
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
    async appendEvent(event) {
        const run = await this.readRun(event.runId);
        await fs.mkdir(this.runDir(event.runId), { recursive: true });
        await fs.appendFile(this.eventsPath(event.runId), `${JSON.stringify(event)}\n`, 'utf-8');
        await this.writeMetadata(applyRunEvent(run, event));
    }
    async readRun(runId) {
        const metadata = JSON.parse(await fs.readFile(this.metadataPath(runId), 'utf-8'));
        const events = await this.readEvents(runId).catch(() => []);
        return events.reduce(applyRunEvent, metadata);
    }
    async listRuns() {
        const index = await readJsonl(this.indexPath).catch(() => []);
        const seen = new Set();
        const runs = [];
        for (const item of index) {
            if (!item.id || seen.has(item.id))
                continue;
            seen.add(item.id);
            runs.push(await this.readRun(item.id));
        }
        return runs;
    }
    async readEvents(runId) {
        return readJsonl(this.eventsPath(runId));
    }
    async writeMetadata(record) {
        await fs.mkdir(this.runDir(record.id), { recursive: true });
        await fs.writeFile(this.metadataPath(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    }
    runDir(runId) {
        return path.join(this.runsRoot, runId);
    }
    metadataPath(runId) {
        return path.join(this.runDir(runId), 'metadata.json');
    }
    eventsPath(runId) {
        return path.join(this.runDir(runId), 'events.jsonl');
    }
}
function indexRecord(record) {
    return {
        id: record.id,
        taskId: record.taskId,
        shortIdentifier: record.shortIdentifier,
        runner: record.runner,
        runnerMode: record.runnerMode,
    };
}
function applyRunEvent(record, event) {
    const next = {
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
                status: event.payload.status === 'needs_review' ? 'needs_review' : next.status,
                artifactIds: mergeStrings(next.artifactIds, event.payload.artifactIds || event.payload.artifactId),
                transcriptRefs: mergeTranscriptRefs(next.transcriptRefs, event.payload.transcriptRefs),
                diffSummary: normalizeDiffSummary(event.payload.diffSummary) || next.diffSummary,
            };
        default:
            return next;
    }
}
async function readJsonl(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
function mergeStrings(current, value) {
    const values = Array.isArray(value) ? value : [value];
    const next = new Set(current);
    for (const item of values) {
        if (typeof item === 'string' && item)
            next.add(item);
    }
    return Array.from(next);
}
function mergeTranscriptRefs(current, value) {
    if (!Array.isArray(value)) {
        return current;
    }
    const byPath = new Map(current.map((ref) => [ref.path, ref]));
    for (const item of value) {
        if (item && typeof item === 'object' && typeof item.path === 'string') {
            const ref = item;
            byPath.set(ref.path, {
                path: ref.path,
                contentType: typeof ref.contentType === 'string' ? ref.contentType : undefined,
            });
        }
    }
    return Array.from(byPath.values());
}
function normalizeDiffSummary(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value;
    if (!Array.isArray(candidate.changedFiles)) {
        return undefined;
    }
    return {
        changedFiles: candidate.changedFiles.filter((item) => typeof item === 'string'),
        insertions: typeof candidate.insertions === 'number' ? candidate.insertions : undefined,
        deletions: typeof candidate.deletions === 'number' ? candidate.deletions : undefined,
        patchPath: typeof candidate.patchPath === 'string' ? candidate.patchPath : undefined,
        statPath: typeof candidate.statPath === 'string' ? candidate.statPath : undefined,
    };
}
function normalizeFailureKind(value) {
    return value === 'runtime_error'
        || value === 'permission_denied'
        || value === 'timeout'
        || value === 'validation_failed'
        || value === 'unknown'
        ? value
        : 'unknown';
}
//# sourceMappingURL=agent-run-store.js.map