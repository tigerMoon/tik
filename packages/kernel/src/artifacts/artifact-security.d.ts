export declare const ARTIFACT_EXTENSION_CONTENT_TYPES: {
    readonly html: "text/html";
    readonly md: "text/markdown";
    readonly svg: "image/svg+xml";
    readonly json: "application/json";
    readonly txt: "text/plain";
    readonly diff: "text/x-diff";
};
export type ArtifactFileExtension = keyof typeof ARTIFACT_EXTENSION_CONTENT_TYPES;
export declare function normalizeArtifactExtension(extension: string): ArtifactFileExtension;
export declare function toArtifactContentBuffer(content: string | Buffer): Buffer;
export declare function assertArtifactSize(content: Buffer, maxArtifactBytes: number): void;
export declare function hashArtifactContent(content: Buffer): string;
export declare function resolveSafeArtifactPath(rootPath: string, safeRelativePath: string): Promise<string>;
//# sourceMappingURL=artifact-security.d.ts.map