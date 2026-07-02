export interface RepoCandidateMatch {
    path: string;
    kind: 'directory' | 'file';
    score: number;
    reason: string;
}
export declare class RepoCandidateFinder {
    find(projectPath: string, input: {
        taskDescription: string;
        recentText?: string[];
        sessionSummary?: string;
    }): Promise<RepoCandidateMatch[]>;
    private extractQueryTokens;
    private collectEntries;
    private scoreEntry;
}
//# sourceMappingURL=repo-candidate-finder.d.ts.map