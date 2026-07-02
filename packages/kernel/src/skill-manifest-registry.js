import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export class SkillManifestRegistry {
    rootPath;
    operationQueue = Promise.resolve();
    constructor(rootPath) {
        this.rootPath = rootPath;
    }
    async listSkills() {
        return this.withLock(async () => (await this.readIndex()).skills);
    }
    async readSkill(skillId) {
        return this.withLock(async () => {
            const index = await this.readIndex();
            return index.skills.find((entry) => entry.skillId === skillId) || null;
        });
    }
    async saveDraft(skillId, input) {
        const mutation = normalizeMutationInput(input);
        if (mutation.snapshot.skillId !== skillId) {
            throw new Error(`Skill id mismatch. Route requested ${skillId}, snapshot carried ${mutation.snapshot.skillId}.`);
        }
        return this.withLock(async () => {
            const index = await this.readIndex();
            const existing = index.skills.find((entry) => entry.skillId === skillId) || null;
            const timestamp = new Date().toISOString();
            const nextEntry = {
                skillId,
                ownerPackId: mutation.snapshot.ownerPackId,
                scope: mutation.snapshot.scope,
                draft: {
                    notes: mutation.notes,
                    savedAt: timestamp,
                    snapshot: mutation.snapshot,
                },
                published: existing?.published || null,
                revisions: appendRevision(existing?.revisions || [], {
                    kind: 'draft_saved',
                    createdAt: timestamp,
                    notes: mutation.notes,
                    snapshot: mutation.snapshot,
                }),
            };
            index.skills = [
                ...index.skills.filter((entry) => entry.skillId !== skillId),
                nextEntry,
            ].sort((left, right) => left.skillId.localeCompare(right.skillId));
            await this.writeIndex(index);
            return nextEntry;
        });
    }
    async publish(skillId, input) {
        const mutation = normalizeMutationInput(input);
        if (mutation.snapshot.skillId !== skillId) {
            throw new Error(`Skill id mismatch. Route requested ${skillId}, snapshot carried ${mutation.snapshot.skillId}.`);
        }
        return this.withLock(async () => {
            const index = await this.readIndex();
            const existing = index.skills.find((entry) => entry.skillId === skillId) || null;
            const timestamp = new Date().toISOString();
            const nextEntry = {
                skillId,
                ownerPackId: mutation.snapshot.ownerPackId,
                scope: mutation.snapshot.scope,
                draft: {
                    notes: mutation.notes,
                    savedAt: existing?.draft?.savedAt || timestamp,
                    snapshot: mutation.snapshot,
                },
                published: {
                    notes: mutation.notes,
                    publishedAt: timestamp,
                    snapshot: mutation.snapshot,
                },
                revisions: appendRevision(existing?.revisions || [], {
                    kind: 'published',
                    createdAt: timestamp,
                    notes: mutation.notes,
                    snapshot: mutation.snapshot,
                }),
            };
            index.skills = [
                ...index.skills.filter((entry) => entry.skillId !== skillId),
                nextEntry,
            ].sort((left, right) => left.skillId.localeCompare(right.skillId));
            await this.writeIndex(index);
            return nextEntry;
        });
    }
    rootDir() {
        return path.join(this.rootPath, '.tik', 'skills');
    }
    indexPath() {
        return path.join(this.rootDir(), 'index.json');
    }
    async readIndex() {
        try {
            const raw = JSON.parse(await fs.readFile(this.indexPath(), 'utf-8'));
            return {
                skills: Array.isArray(raw.skills)
                    ? raw.skills.map((entry) => ({
                        ...entry,
                        revisions: Array.isArray(entry.revisions) ? entry.revisions : [],
                    }))
                    : [],
            };
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { skills: [] };
            }
            throw error;
        }
    }
    async writeIndex(index) {
        await fs.mkdir(this.rootDir(), { recursive: true });
        const tempPath = `${this.indexPath()}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fs.writeFile(tempPath, JSON.stringify(index, null, 2), 'utf-8');
        await fs.rename(tempPath, this.indexPath());
    }
    async withLock(operation) {
        const previous = this.operationQueue;
        let release;
        this.operationQueue = new Promise((resolve) => {
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
}
function normalizeMutationInput(input) {
    if (!input || typeof input !== 'object') {
        throw new Error('Skill manifest payload is required.');
    }
    if (!input.snapshot || typeof input.snapshot !== 'object') {
        throw new Error('Skill manifest snapshot is required.');
    }
    if (!input.snapshot.skillId || typeof input.snapshot.skillId !== 'string') {
        throw new Error('Skill manifest snapshot.skillId is required.');
    }
    if (!input.snapshot.ownerPackId || typeof input.snapshot.ownerPackId !== 'string') {
        throw new Error('Skill manifest snapshot.ownerPackId is required.');
    }
    if (!input.snapshot.version || typeof input.snapshot.version !== 'string') {
        throw new Error('Skill manifest snapshot.version is required.');
    }
    return {
        ...input,
        notes: typeof input.notes === 'string' ? input.notes : '',
        snapshot: {
            ...input.snapshot,
            packIds: Array.isArray(input.snapshot.packIds) ? input.snapshot.packIds : [],
            packNames: Array.isArray(input.snapshot.packNames) ? input.snapshot.packNames : [],
            requiredTools: Array.isArray(input.snapshot.requiredTools) ? input.snapshot.requiredTools : [],
            requiredKnowledge: Array.isArray(input.snapshot.requiredKnowledge) ? input.snapshot.requiredKnowledge : [],
            policyHooks: Array.isArray(input.snapshot.policyHooks) ? input.snapshot.policyHooks : [],
            evaluators: Array.isArray(input.snapshot.evaluators) ? input.snapshot.evaluators : [],
            bindings: Array.isArray(input.snapshot.bindings) ? input.snapshot.bindings : [],
            taskCount: Number.isFinite(input.snapshot.taskCount) ? input.snapshot.taskCount : 0,
            activeTaskCount: Number.isFinite(input.snapshot.activeTaskCount) ? input.snapshot.activeTaskCount : 0,
            selectedTaskCount: Number.isFinite(input.snapshot.selectedTaskCount) ? input.snapshot.selectedTaskCount : 0,
        },
    };
}
function appendRevision(revisions, next) {
    const previous = revisions[revisions.length - 1];
    const nextRevision = {
        ...next,
        id: `${next.kind}:${next.createdAt}`,
    };
    if (previous
        && previous.kind === next.kind
        && JSON.stringify(previous.snapshot) === JSON.stringify(next.snapshot)
        && previous.notes === next.notes) {
        return revisions;
    }
    return [...revisions, nextRevision];
}
//# sourceMappingURL=skill-manifest-registry.js.map