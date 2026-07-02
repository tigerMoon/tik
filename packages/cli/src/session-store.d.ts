import type { ConvergenceStrategy } from '@tik/shared';
import type { ProviderOption } from './types.js';
export interface PersistedCliSession {
    version: 1;
    sessionId: string;
    createdAt: string;
    updatedAt: string;
    projectPath: string;
    provider: ProviderOption;
    llmName: string;
    model?: string;
    mode: 'single' | 'multi';
    strategy: ConvergenceStrategy;
    maxIterations: number;
    turns: number;
    compactedEntries?: number;
    compactSummary?: {
        keyFacts: string[];
        pendingWork: string[];
        currentWork?: string;
    };
    lastTaskId?: string;
    lastTaskStatus?: string;
    lastPrompt?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    transcript?: Array<{
        timestamp: string;
        kind: 'user' | 'result' | 'command' | 'system';
        content: string;
    }>;
}
export interface CliSessionSummary {
    sessionId: string;
    projectPath: string;
    updatedAt: string;
    turns: number;
    provider: ProviderOption;
    mode: 'single' | 'multi';
    strategy: ConvergenceStrategy;
    lastTaskId?: string;
    lastTaskStatus?: string;
}
export declare function saveCliSession(session: PersistedCliSession): Promise<string>;
export declare function listCliSessions(projectPath: string): Promise<CliSessionSummary[]>;
export declare function loadCliSession(projectPath: string, sessionIdOrPath: string): Promise<PersistedCliSession>;
export declare function resolveCliSessionPath(projectPath: string, sessionIdOrPath: string): Promise<string>;
export declare function createCliSession(input: Omit<PersistedCliSession, 'version' | 'createdAt' | 'updatedAt' | 'turns'>): PersistedCliSession;
export declare function sessionFilePath(projectPath: string, sessionId: string): string;
export declare function sessionDir(projectPath: string): string;
//# sourceMappingURL=session-store.d.ts.map