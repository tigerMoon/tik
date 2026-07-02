import type { WorkbenchArtifactRecord } from '@tik/shared';
export type ArtifactPreviewMode = 'document' | 'diff' | 'diff-stat' | 'log' | 'text' | 'embed';
export interface ArtifactDiffLine {
    kind: 'meta' | 'hunk' | 'add' | 'remove' | 'context';
    text: string;
}
export interface ArtifactDiffFile {
    path: string;
    lines: ArtifactDiffLine[];
}
export interface ArtifactDiffModel {
    files: ArtifactDiffFile[];
}
export interface ArtifactDiffStatRow {
    filePath: string;
    changes: number;
    additions: number;
    deletions: number;
}
export interface ArtifactDiffStatModel {
    rows: ArtifactDiffStatRow[];
    summary?: string;
    rawLines: string[];
}
export interface ArtifactLogSection {
    title: string;
    lines: Array<{
        number: number;
        text: string;
    }>;
}
export declare function classifyArtifactPreviewMode(artifact: WorkbenchArtifactRecord): ArtifactPreviewMode;
export declare function shouldFetchArtifactPreviewText(mode: ArtifactPreviewMode): boolean;
export declare function parseArtifactDiff(content: string): ArtifactDiffModel;
export declare function parseArtifactDiffStat(content: string): ArtifactDiffStatModel;
export declare function parseArtifactLogSections(content: string): ArtifactLogSection[];
//# sourceMappingURL=artifact-preview.d.ts.map