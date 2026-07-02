import type { ArtifactKind, ArtifactStatus, ArtifactVisibility, WorkbenchArtifactRecord, WorkbenchArtifactVersion } from '@tik/shared';
import { type ArtifactFileExtension } from './artifact-security.js';
export interface ArtifactFilter {
    taskId?: string;
    workspaceId?: string;
    projectId?: string;
    status?: ArtifactStatus;
    kind?: ArtifactKind;
    tag?: string;
    limit?: number;
    offset?: number;
    sort?: 'updatedAt.desc' | 'updatedAt.asc';
}
export interface CreateArtifactInput {
    taskId: string;
    workspaceId?: string;
    projectId?: string;
    sessionId?: string;
    attemptId?: string;
    title: string;
    description?: string;
    kind: ArtifactKind;
    status?: ArtifactStatus;
    visibility?: ArtifactVisibility;
    content: string | Buffer;
    contentType: string;
    extension: ArtifactFileExtension;
    sourceEventIds?: string[];
    sourceEvidenceIds?: string[];
    changedFiles?: string[];
    validationRefs?: string[];
    decisionIds?: string[];
    producedBy?: WorkbenchArtifactRecord['producedBy'];
    summary?: string;
    risks?: string[];
    tags?: string[];
}
export interface AppendArtifactVersionInput {
    artifactId: string;
    content: string | Buffer;
    contentType: string;
    extension: ArtifactFileExtension;
    sourceEventIds?: string[];
    sourceEvidenceIds?: string[];
    changedFiles?: string[];
    validationRefs?: string[];
    decisionIds?: string[];
    summary?: string;
}
export interface ArtifactPreviewPayload {
    artifact: WorkbenchArtifactRecord;
    version: WorkbenchArtifactVersion;
    content: Buffer;
}
export interface ArtifactRegistry {
    list(filter?: ArtifactFilter): Promise<WorkbenchArtifactRecord[]>;
    get(id: string): Promise<WorkbenchArtifactRecord | null>;
    listVersions(id: string): Promise<WorkbenchArtifactVersion[]>;
    readPreview(artifactId: string, versionId?: string): Promise<ArtifactPreviewPayload | null>;
    create(input: CreateArtifactInput): Promise<WorkbenchArtifactRecord>;
    appendVersion(input: AppendArtifactVersionInput): Promise<WorkbenchArtifactRecord>;
    accept(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    reject(id: string, reason: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    archive(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
}
interface FileArtifactRegistryOptions {
    rootPath: string;
    maxArtifactBytes?: number;
}
export declare class FileArtifactRegistry implements ArtifactRegistry {
    private readonly options;
    private operationQueue;
    private readonly maxArtifactBytes;
    constructor(options: FileArtifactRegistryOptions);
    list(filter?: ArtifactFilter): Promise<WorkbenchArtifactRecord[]>;
    get(id: string): Promise<WorkbenchArtifactRecord | null>;
    listVersions(id: string): Promise<WorkbenchArtifactVersion[]>;
    create(input: CreateArtifactInput): Promise<WorkbenchArtifactRecord>;
    appendVersion(input: AppendArtifactVersionInput): Promise<WorkbenchArtifactRecord>;
    accept(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    reject(id: string, reason: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    archive(id: string, actor?: string): Promise<WorkbenchArtifactRecord>;
    readPreview(artifactId: string, versionId?: string): Promise<ArtifactPreviewPayload | null>;
    private updateStatus;
    private writeVersionFile;
    private writeArtifactRecord;
    private replaceInIndex;
    private artifactIdsForTask;
    private writeTaskIndex;
    private getUnlocked;
    private artifactDir;
    private byTaskDir;
    private rootDir;
    private indexPath;
    private readIndex;
    private writeIndex;
    private readJsonFile;
    private writeJsonFileAtomic;
    private withLock;
}
export {};
//# sourceMappingURL=artifact-registry.d.ts.map