import type { SessionCompactMemory } from '@tik/shared';
export interface RuntimeToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
export interface ExecutedActionLike {
    tool: string;
    input: unknown;
    output?: unknown;
    success: boolean;
}
export type TaskIntent = 'implementation' | 'analysis' | 'review' | 'unknown';
export declare function normalizeToolCall(call: RuntimeToolCall): RuntimeToolCall;
export declare function dedupeToolCalls(calls: RuntimeToolCall[]): RuntimeToolCall[];
export declare function getToolCallSignature(call: RuntimeToolCall): string;
export declare function isReadLikeTool(toolName: string): boolean;
export declare function isRedundantReadBatch(calls: RuntimeToolCall[], successfulReadSignatures: Set<string>): boolean;
export declare function shouldShiftFromExplorationToImplementation(calls: RuntimeToolCall[], executedActions: ExecutedActionLike[]): boolean;
export declare function sessionMemorySuggestsImplementation(summary?: string | SessionCompactMemory): boolean;
export declare function assistantSuggestsImplementationComplete(content: string): boolean;
export declare function assistantSuggestsNoCodeChangeNeeded(content: string): boolean;
export declare function classifyTaskIntent(taskDescription: string): TaskIntent;
export declare function isVerificationProbeBatch(calls: RuntimeToolCall[]): boolean;
export declare function enoughEvidenceToConclude(summary: string | SessionCompactMemory | undefined, assistantContent: string, calls: RuntimeToolCall[]): boolean;
export declare function shouldForceImplementationAction(taskDescription: string, summary: string | SessionCompactMemory | undefined, calls: RuntimeToolCall[]): boolean;
export declare function hasMeaningfulPendingWork(summary?: string | SessionCompactMemory): boolean;
export declare function hasWriteLikeAction(actions: ExecutedActionLike[]): boolean;
export declare function hasSuccessfulValidationAction(actions: ExecutedActionLike[]): boolean;
export declare function hasFailedAction(actions: ExecutedActionLike[]): boolean;
export declare function shouldMarkTaskCompleted(taskDescription: string, summary: string | SessionCompactMemory | undefined, assistantContent: string, actions: ExecutedActionLike[], options?: {
    validationAvailable?: boolean;
}): boolean;
//# sourceMappingURL=tool-call-policy.d.ts.map