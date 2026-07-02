/**
 * Memory Engine
 *
 * Records and queries runs, failures, decisions, and patterns.
 * Persistent storage in .ace/memory/ directory.
 */
export interface RunMemoryEntry {
    id: string;
    taskId: string;
    featureName?: string;
    iterations: number;
    finalState: 'CONVERGED' | 'FAILED' | 'MAX_ITERATIONS' | 'BLOCKED' | 'NOT_CONVERGED';
    finalFitness: number;
    startedAt: number;
    completedAt: number;
}
export interface FailureMemoryEntry {
    id: string;
    taskId: string;
    runId: string;
    type: 'test' | 'build' | 'review' | 'constraint' | 'drift' | 'entropy';
    target: string;
    message: string;
    resolution?: string;
    timestamp: number;
}
export interface DecisionMemoryEntry {
    id: string;
    taskId: string;
    type: 'architecture' | 'refactoring' | 'complexity' | 'api';
    description: string;
    rationale: string;
    impact: {
        fitnessChange: number;
        driftChange: number;
        entropyChange: number;
    };
    timestamp: number;
}
export interface PatternEntry {
    id: string;
    type: 'architecture' | 'coding' | 'dependency' | 'design';
    description: string;
    confidence: number;
    occurrences: number;
    lastSeen: number;
}
export interface LearningInsights {
    commonFailures: Array<{
        type: string;
        count: number;
        resolution?: string;
    }>;
    successfulStrategies: Array<{
        strategy: string;
        successRate: number;
    }>;
    patterns: PatternEntry[];
}
export declare class MemoryEngine {
    private basePath;
    private runs;
    private failures;
    private decisions;
    private patterns;
    private loaded;
    constructor(projectPath: string);
    recordRun(entry: Omit<RunMemoryEntry, 'id'>): Promise<RunMemoryEntry>;
    recordFailure(entry: Omit<FailureMemoryEntry, 'id'>): Promise<FailureMemoryEntry>;
    recordDecision(entry: Omit<DecisionMemoryEntry, 'id'>): Promise<DecisionMemoryEntry>;
    getRuns(filter?: {
        taskId?: string;
        finalState?: string;
    }): Promise<RunMemoryEntry[]>;
    getFailures(filter?: {
        type?: string;
        target?: string;
    }): Promise<FailureMemoryEntry[]>;
    getDecisions(filter?: {
        type?: string;
    }): Promise<DecisionMemoryEntry[]>;
    getInsights(): Promise<LearningInsights>;
    getPatterns(): Promise<PatternEntry[]>;
    private learnFromFailure;
    private mapFailureToPatternType;
    private ensureLoaded;
    private load;
    private persist;
}
//# sourceMappingURL=memory-engine.d.ts.map