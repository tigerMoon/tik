import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class FileTrackerDaemonStateStore {
    statePath;
    constructor(statePath) {
        this.statePath = statePath;
    }
    static forWorkspace(workspaceRoot) {
        return new FileTrackerDaemonStateStore(path.join(workspaceRoot, '.tik', 'tracker-daemon', 'state.json'));
    }
    async load() {
        try {
            const raw = await fs.readFile(this.statePath, 'utf-8');
            return normalizeState(JSON.parse(raw));
        }
        catch (err) {
            if (err.code === 'ENOENT') {
                return emptyState();
            }
            throw err;
        }
    }
    async save(state) {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await fs.writeFile(this.statePath, `${JSON.stringify(persistableState(state), null, 2)}\n`, 'utf-8');
    }
}
export function emptyState() {
    return { retries: {}, watching: false, recent: [] };
}
function normalizeState(value) {
    const candidate = value;
    return {
        runs: normalizeRuns(candidate?.runs),
        retries: normalizeRetries(candidate?.retries),
        watching: typeof candidate?.watching === 'boolean' ? candidate.watching : false,
        recent: normalizeRecent(candidate?.recent),
    };
}
function persistableState(value) {
    return {
        retries: normalizeRetries(value.retries),
        watching: value.watching ?? false,
        recent: normalizeRecent(value.recent),
    };
}
function normalizeRuns(value) {
    if (!value || typeof value !== 'object')
        return {};
    const normalized = {};
    for (const [key, rawRun] of Object.entries(value)) {
        const taskId = rawRun.taskId && rawRun.kernelTaskId ? rawRun.taskId : rawRun.issueId || key;
        const kernelTaskId = rawRun.kernelTaskId || rawRun.taskId;
        if (!taskId || !kernelTaskId)
            continue;
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
function normalizeRetries(value) {
    if (!value || typeof value !== 'object')
        return {};
    const normalized = {};
    for (const [key, rawRetry] of Object.entries(value)) {
        const taskId = rawRetry.taskId || rawRetry.issueId || key;
        if (!taskId)
            continue;
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
function normalizeRecent(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((entry) => {
        const candidate = entry;
        if (typeof candidate?.type !== 'string' || typeof candidate?.message !== 'string' || typeof candidate?.createdAt !== 'string') {
            return null;
        }
        return {
            type: candidate.type,
            shortIdentifier: typeof candidate.shortIdentifier === 'string' ? candidate.shortIdentifier : 'tracker',
            message: candidate.message,
            createdAt: candidate.createdAt,
        };
    })
        .filter((entry) => Boolean(entry))
        .slice(-20);
}
//# sourceMappingURL=file-state-store.js.map