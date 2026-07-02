import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class WorkbenchStore {
    rootPath;
    indexOperationQueue = Promise.resolve();
    constructor(rootPath) {
        this.rootPath = rootPath;
    }
    async upsertTask(task) {
        await this.withIndexLock(async () => {
            const index = await this.readIndex();
            const { normalizedTask } = this.normalizeTaskIdentifiers(task, index.tasks);
            index.tasks = [...index.tasks.filter((item) => item.id !== task.id), normalizedTask];
            await this.writeIndex(index);
        });
    }
    async upsertSession(session) {
        await this.writeJsonFileAtomic(path.join(this.sessionDir(), `${session.id}.json`), session);
    }
    async listTasks() {
        return this.withIndexLock(async () => {
            const index = await this.readIndex();
            const { tasks, changed } = this.backfillTaskIdentifiers(index.tasks);
            if (changed) {
                await this.writeIndex({ ...index, tasks });
            }
            return tasks;
        });
    }
    async appendTimelineItem(item) {
        await fs.mkdir(this.timelineDir(), { recursive: true });
        await fs.appendFile(path.join(this.timelineDir(), `${item.taskId}.jsonl`), `${JSON.stringify(item)}\n`, 'utf-8');
    }
    async appendDecision(decision) {
        await this.withIndexLock(async () => {
            const index = await this.readIndex();
            index.decisions = [...index.decisions.filter((item) => item.id !== decision.id), decision];
            await this.writeIndex(index);
        });
    }
    async readPendingDecisions(taskId) {
        return this.withIndexLock(async () => {
            const index = await this.readIndex();
            return index.decisions.filter((decision) => decision.taskId === taskId && decision.status === 'pending');
        });
    }
    async readDecision(decisionId) {
        return this.withIndexLock(async () => {
            const index = await this.readIndex();
            return index.decisions.find((decision) => decision.id === decisionId) ?? null;
        });
    }
    async readTaskBundle(taskId) {
        const task = await this.withIndexLock(async () => {
            const index = await this.readIndex();
            const { tasks, changed } = this.backfillTaskIdentifiers(index.tasks);
            if (changed) {
                await this.writeIndex({ ...index, tasks });
            }
            return tasks.find((item) => item.id === taskId) ?? null;
        });
        const timeline = await this.readJsonLines(path.join(this.timelineDir(), `${taskId}.jsonl`));
        return {
            task,
            session: task ? await this.readTaskSession(task) : null,
            timeline,
        };
    }
    rootDir() {
        return path.join(this.rootPath, '.tik', 'workbench');
    }
    sessionDir() {
        return path.join(this.rootDir(), 'sessions');
    }
    timelineDir() {
        return path.join(this.rootDir(), 'timelines');
    }
    indexPath() {
        return path.join(this.rootDir(), 'index.json');
    }
    async readIndex() {
        const index = await this.readJsonDocument(this.indexPath(), {
            fallbackToNullOnParseError: false,
        });
        return index ?? { tasks: [], decisions: [], evidences: [] };
    }
    async writeIndex(index) {
        await this.writeJsonFileAtomic(this.indexPath(), index);
    }
    backfillTaskIdentifiers(tasks) {
        let changed = false;
        const nextIdentifier = this.buildNextIdentifier(tasks);
        const legacyTasks = [...tasks]
            .filter((task) => !task.identifier || !task.shortIdentifier)
            .sort((left, right) => {
            const createdDelta = (left.createdAt || '').localeCompare(right.createdAt || '');
            if (createdDelta !== 0)
                return createdDelta;
            return left.id.localeCompare(right.id);
        });
        const generatedById = new Map();
        for (const task of legacyTasks) {
            generatedById.set(task.id, task.identifier || task.shortIdentifier || nextIdentifier());
        }
        const normalized = tasks.map((task) => {
            const identifier = task.identifier || task.shortIdentifier || generatedById.get(task.id);
            if (!identifier) {
                return task;
            }
            if (task.identifier === identifier && task.shortIdentifier === identifier) {
                return task;
            }
            changed = true;
            return {
                ...task,
                identifier,
                shortIdentifier: identifier,
            };
        });
        return { tasks: normalized, changed };
    }
    normalizeTaskIdentifiers(task, existingTasks) {
        const identifier = task.identifier || task.shortIdentifier || this.buildNextIdentifier(existingTasks)();
        if (task.identifier === identifier && task.shortIdentifier === identifier) {
            return { normalizedTask: task, changed: false };
        }
        return {
            normalizedTask: {
                ...task,
                identifier,
                shortIdentifier: identifier,
            },
            changed: true,
        };
    }
    buildNextIdentifier(tasks) {
        const usedNumbers = new Set();
        for (const task of tasks) {
            const identifier = task.identifier || task.shortIdentifier;
            const match = identifier?.match(/^TIK-(\d+)$/i);
            if (match) {
                usedNumbers.add(Number(match[1]));
            }
        }
        let nextNumber = 1;
        return () => {
            while (usedNumbers.has(nextNumber)) {
                nextNumber += 1;
            }
            const identifier = `TIK-${nextNumber}`;
            usedNumbers.add(nextNumber);
            nextNumber += 1;
            return identifier;
        };
    }
    async withIndexLock(operation) {
        const previous = this.indexOperationQueue;
        let release;
        this.indexOperationQueue = new Promise((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    async readTaskSession(task) {
        if (task.activeSessionId) {
            return this.readJsonFile(path.join(this.sessionDir(), `${task.activeSessionId}.json`));
        }
        const sessions = await this.listSessionsForTask(task.id);
        return sessions[0] ?? null;
    }
    async listSessionsForTask(taskId) {
        try {
            const entries = await fs.readdir(this.sessionDir());
            const sessions = await Promise.all(entries
                .filter((entry) => entry.endsWith('.json'))
                .map(async (entry) => this.readJsonFile(path.join(this.sessionDir(), entry))));
            return sessions
                .filter((session) => session?.taskId === taskId)
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }
    async readJsonFile(filePath) {
        return this.readJsonDocument(filePath, {
            fallbackToNullOnParseError: true,
        });
    }
    async readJsonDocument(filePath, options) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                return JSON.parse(await fs.readFile(filePath, 'utf-8'));
            }
            catch (error) {
                const code = error.code;
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
    async writeJsonFileAtomic(filePath, value) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
        await fs.rename(tempPath, filePath);
    }
    async readJsonLines(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            const parsed = [];
            lines.forEach((line, index) => {
                try {
                    parsed.push(JSON.parse(line));
                }
                catch (error) {
                    if (error instanceof SyntaxError && index === lines.length - 1) {
                        return;
                    }
                    throw error;
                }
            });
            return parsed;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }
}
//# sourceMappingURL=workbench-store.js.map