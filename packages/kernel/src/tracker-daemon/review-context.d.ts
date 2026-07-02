export interface ReviewContextOptions {
    baseRef?: string;
    headSha?: string;
    allowedScope?: string[];
    maxFiles?: number;
    maxDiffBytes?: number;
}
export declare function buildTikGeneratedReviewContext(projectPath: string, options?: ReviewContextOptions): Promise<string>;
export declare function hasTikReviewableChanges(projectPath: string, options?: ReviewContextOptions): boolean;
//# sourceMappingURL=review-context.d.ts.map