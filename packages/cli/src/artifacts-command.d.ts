import type { WorkbenchArtifactRecord } from '@tik/shared';
export declare function buildArtifactPreviewApiUrl(apiBase: string, artifactId: string, versionId: string): string;
export declare function buildArtifactDetailUrl(apiBase: string, artifactId: string): string;
export declare function formatArtifactList(artifacts: WorkbenchArtifactRecord[]): string;
export declare function formatArtifactShow(artifact: WorkbenchArtifactRecord, apiBase: string): string;
export declare function readArtifactResponse<T>(response: Response): Promise<T>;
//# sourceMappingURL=artifacts-command.d.ts.map