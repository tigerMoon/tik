import * as fs from 'node:fs/promises';
export class JsonTaskImporter {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async listCandidateTasks() {
        return this.readTasks();
    }
    async fetchTaskStatesByIds(taskIds) {
        const ids = new Set(taskIds);
        return (await this.readTasks()).filter((task) => ids.has(task.id));
    }
    async fetchTasksByStates(stateNames) {
        const states = new Set(stateNames);
        return (await this.readTasks()).filter((task) => states.has(task.state));
    }
    async readTasks() {
        const raw = await fs.readFile(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const tasks = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed.tasks)
                ? parsed.tasks
                : Array.isArray(parsed.issues)
                    ? parsed.issues
                    : [];
        return tasks.map(normalizeTask);
    }
}
function normalizeTask(input) {
    const task = input;
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
function normalizeBlockers(blockers) {
    return blockers.map((blocker) => ({
        id: blocker.id,
        shortIdentifier: blocker.shortIdentifier || blocker.identifier,
        state: blocker.state,
    }));
}
function inferStateKind(state) {
    const normalized = state?.toLowerCase();
    if (!normalized)
        return 'active';
    if (['done', 'closed', 'completed', 'cancelled', 'terminal'].includes(normalized))
        return 'terminal';
    if (['blocked', 'waiting', 'needs human'].includes(normalized))
        return 'blocked';
    return 'active';
}
//# sourceMappingURL=json-tracker-client.js.map