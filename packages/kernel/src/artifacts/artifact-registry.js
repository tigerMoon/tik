import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { generateId } from '@tik/shared';
import { assertArtifactSize, hashArtifactContent, normalizeArtifactExtension, resolveSafeArtifactPath, toArtifactContentBuffer, } from './artifact-security.js';
const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export class FileArtifactRegistry {
    options;
    operationQueue = Promise.resolve();
    maxArtifactBytes;
    constructor(options) {
        this.options = options;
        this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    }
    async list(filter = {}) {
        return this.withLock(async () => {
            const index = await this.readIndex();
            const tag = filter.tag?.trim();
            const offset = Math.max(0, filter.offset ?? 0);
            const limit = filter.limit && filter.limit > 0 ? filter.limit : undefined;
            const sorted = [...index.artifacts]
                .filter((artifact) => !filter.taskId || artifact.taskId === filter.taskId)
                .filter((artifact) => !filter.workspaceId || artifact.workspaceId === filter.workspaceId)
                .filter((artifact) => !filter.projectId || artifact.projectId === filter.projectId)
                .filter((artifact) => !filter.status || artifact.status === filter.status)
                .filter((artifact) => !filter.kind || artifact.kind === filter.kind)
                .filter((artifact) => !tag || artifact.tags?.includes(tag))
                .sort((left, right) => {
                const direction = filter.sort === 'updatedAt.asc' ? 1 : -1;
                return direction * left.updatedAt.localeCompare(right.updatedAt);
            });
            return sorted.slice(offset, limit ? offset + limit : undefined);
        });
    }
    async get(id) {
        return this.withLock(async () => {
            const index = await this.readIndex();
            return index.artifacts.find((artifact) => artifact.id === id) ?? null;
        });
    }
    async listVersions(id) {
        const metadata = await this.readJsonFile(path.join(this.artifactDir(id), 'versions', 'index.json'));
        return [...(metadata?.versions || [])].sort((left, right) => left.version - right.version);
    }
    async create(input) {
        return this.withLock(async () => {
            const now = new Date().toISOString();
            const artifactId = `art_${generateId()}`;
            const version = await this.writeVersionFile({
                artifactId,
                version: 1,
                content: input.content,
                contentType: input.contentType,
                extension: input.extension,
                sourceEventIds: input.sourceEventIds,
                sourceEvidenceIds: input.sourceEvidenceIds,
                changedFiles: input.changedFiles,
                validationRefs: input.validationRefs,
                decisionIds: input.decisionIds,
                summary: input.summary,
                createdAt: now,
            });
            const artifact = {
                id: artifactId,
                taskId: input.taskId,
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                sessionId: input.sessionId,
                attemptId: input.attemptId,
                title: input.title,
                description: input.description,
                kind: input.kind,
                status: input.status || 'needs_review',
                visibility: input.visibility || 'local',
                latestVersionId: version.id,
                version: version.version,
                safeRelativePath: version.safeRelativePath,
                contentType: version.contentType,
                sizeBytes: version.sizeBytes,
                contentHash: version.contentHash,
                sourceEventIds: version.sourceEventIds,
                sourceEvidenceIds: version.sourceEvidenceIds,
                changedFiles: version.changedFiles,
                validationRefs: version.validationRefs,
                decisionIds: version.decisionIds,
                producedBy: input.producedBy || {},
                summary: input.summary,
                risks: input.risks,
                tags: normalizeTags(input.tags),
                createdAt: now,
                updatedAt: now,
            };
            await this.writeArtifactRecord(artifact, [version]);
            const index = await this.readIndex();
            await this.writeIndex({
                schemaVersion: 1,
                artifacts: [...index.artifacts.filter((item) => item.id !== artifact.id), artifact],
            });
            await this.writeTaskIndex(artifact.taskId, await this.artifactIdsForTask(artifact.taskId, artifact.id));
            return artifact;
        });
    }
    async appendVersion(input) {
        return this.withLock(async () => {
            const artifact = await this.getUnlocked(input.artifactId);
            if (!artifact) {
                throw new Error(`Artifact not found: ${input.artifactId}`);
            }
            const now = new Date().toISOString();
            const nextVersionNumber = artifact.version + 1;
            const version = await this.writeVersionFile({
                artifactId: artifact.id,
                version: nextVersionNumber,
                content: input.content,
                contentType: input.contentType,
                extension: input.extension,
                sourceEventIds: input.sourceEventIds,
                sourceEvidenceIds: input.sourceEvidenceIds,
                changedFiles: input.changedFiles,
                validationRefs: input.validationRefs,
                decisionIds: input.decisionIds,
                summary: input.summary,
                createdAt: now,
            });
            const versions = await this.listVersions(artifact.id);
            const updated = {
                ...artifact,
                status: 'needs_review',
                latestVersionId: version.id,
                version: version.version,
                safeRelativePath: version.safeRelativePath,
                contentType: version.contentType,
                sizeBytes: version.sizeBytes,
                contentHash: version.contentHash,
                sourceEventIds: version.sourceEventIds,
                sourceEvidenceIds: version.sourceEvidenceIds,
                changedFiles: version.changedFiles,
                validationRefs: version.validationRefs,
                decisionIds: version.decisionIds,
                summary: input.summary ?? artifact.summary,
                updatedAt: now,
                acceptedAt: undefined,
                acceptedBy: undefined,
                rejectedAt: undefined,
                rejectedBy: undefined,
                rejectionReason: undefined,
            };
            await this.writeArtifactRecord(updated, [...versions.filter((item) => item.id !== version.id), version]);
            await this.replaceInIndex(updated);
            return updated;
        });
    }
    async accept(id, actor = 'user') {
        return this.updateStatus(id, 'accepted', actor);
    }
    async reject(id, reason, actor = 'user') {
        const trimmedReason = reason.trim();
        if (!trimmedReason) {
            throw new Error('Artifact rejection reason is required.');
        }
        return this.updateStatus(id, 'rejected', actor, trimmedReason);
    }
    async archive(id, actor = 'user') {
        return this.updateStatus(id, 'archived', actor);
    }
    async readPreview(artifactId, versionId) {
        const artifact = await this.get(artifactId);
        if (!artifact) {
            return null;
        }
        const versions = await this.listVersions(artifactId);
        const version = versionId
            ? versions.find((item) => item.id === versionId || String(item.version) === versionId || `v${item.version}` === versionId)
            : versions.find((item) => item.id === artifact.latestVersionId);
        if (!version) {
            return null;
        }
        const filePath = await resolveSafeArtifactPath(this.options.rootPath, version.safeRelativePath);
        return {
            artifact,
            version,
            content: await fs.readFile(filePath),
        };
    }
    async updateStatus(id, status, actor, rejectionReason) {
        return this.withLock(async () => {
            const artifact = await this.getUnlocked(id);
            if (!artifact) {
                throw new Error(`Artifact not found: ${id}`);
            }
            const now = new Date().toISOString();
            const updated = {
                ...artifact,
                status,
                updatedAt: now,
                acceptedAt: status === 'accepted' ? now : artifact.acceptedAt,
                acceptedBy: status === 'accepted' ? actor : artifact.acceptedBy,
                rejectedAt: status === 'rejected' ? now : artifact.rejectedAt,
                rejectedBy: status === 'rejected' ? actor : artifact.rejectedBy,
                rejectionReason: status === 'rejected' ? rejectionReason : artifact.rejectionReason,
            };
            await this.writeArtifactRecord(updated, await this.listVersions(id));
            await this.replaceInIndex(updated);
            return updated;
        });
    }
    async writeVersionFile(input) {
        const extension = normalizeArtifactExtension(input.extension);
        const buffer = toArtifactContentBuffer(input.content);
        assertArtifactSize(buffer, this.maxArtifactBytes);
        const safeRelativePath = `.tik/workbench/artifacts/${input.artifactId}/versions/v${input.version}.${extension}`;
        const filePath = await resolveSafeArtifactPath(this.options.rootPath, safeRelativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, buffer);
        const version = {
            id: `ver_${generateId()}`,
            artifactId: input.artifactId,
            version: input.version,
            safeRelativePath,
            contentType: input.contentType,
            sizeBytes: buffer.byteLength,
            contentHash: hashArtifactContent(buffer),
            sourceEventIds: input.sourceEventIds || [],
            sourceEvidenceIds: input.sourceEvidenceIds || [],
            changedFiles: input.changedFiles,
            validationRefs: input.validationRefs,
            decisionIds: input.decisionIds,
            summary: input.summary,
            createdAt: input.createdAt,
        };
        await this.writeJsonFileAtomic(path.join(this.artifactDir(input.artifactId), 'versions', `v${input.version}.metadata.json`), version);
        return version;
    }
    async writeArtifactRecord(artifact, versions) {
        await this.writeJsonFileAtomic(path.join(this.artifactDir(artifact.id), 'metadata.json'), artifact);
        await this.writeJsonFileAtomic(path.join(this.artifactDir(artifact.id), 'versions', 'index.json'), {
            artifactId: artifact.id,
            versions: versions.sort((left, right) => left.version - right.version),
        });
    }
    async replaceInIndex(artifact) {
        const index = await this.readIndex();
        await this.writeIndex({
            schemaVersion: 1,
            artifacts: [...index.artifacts.filter((item) => item.id !== artifact.id), artifact],
        });
        await this.writeTaskIndex(artifact.taskId, await this.artifactIdsForTask(artifact.taskId));
    }
    async artifactIdsForTask(taskId, includeId) {
        const index = await this.readIndex();
        return Array.from(new Set([
            ...index.artifacts.filter((artifact) => artifact.taskId === taskId).map((artifact) => artifact.id),
            ...(includeId ? [includeId] : []),
        ])).sort();
    }
    async writeTaskIndex(taskId, artifactIds) {
        await this.writeJsonFileAtomic(path.join(this.byTaskDir(), `${safeFileSegment(taskId)}.json`), {
            taskId,
            artifactIds,
        });
    }
    async getUnlocked(id) {
        const index = await this.readIndex();
        return index.artifacts.find((artifact) => artifact.id === id) ?? null;
    }
    artifactDir(artifactId) {
        return path.join(this.rootDir(), safeFileSegment(artifactId));
    }
    byTaskDir() {
        return path.join(this.rootDir(), 'by-task');
    }
    rootDir() {
        return path.join(this.options.rootPath, '.tik', 'workbench', 'artifacts');
    }
    indexPath() {
        return path.join(this.rootDir(), 'index.json');
    }
    async readIndex() {
        const index = await this.readJsonFile(this.indexPath());
        return index ?? { schemaVersion: 1, artifacts: [] };
    }
    async writeIndex(index) {
        await this.writeJsonFileAtomic(this.indexPath(), index);
    }
    async readJsonFile(filePath) {
        try {
            return JSON.parse(await fs.readFile(filePath, 'utf-8'));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
    async writeJsonFileAtomic(filePath, value) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
        await fs.rename(tempPath, filePath);
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
function safeFileSegment(value) {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!normalized || normalized === '.' || normalized === '..') {
        throw new Error(`Unsafe artifact path segment: ${value}`);
    }
    return normalized;
}
function normalizeTags(tags) {
    if (!tags) {
        return undefined;
    }
    return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort();
}
//# sourceMappingURL=artifact-registry.js.map