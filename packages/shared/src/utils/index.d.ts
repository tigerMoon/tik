/**
 * Shared Utilities
 */
/** Generate a unique ID */
export declare function generateId(): string;
/** Generate a short task ID */
export declare function generateTaskId(): string;
/** Generate a run ID */
export declare function generateRunId(): string;
/** Current timestamp in ms */
export declare function now(): number;
/** Format duration in human-readable form */
export declare function formatDuration(ms: number): string;
/** Clamp a number between min and max */
export declare function clamp(value: number, min: number, max: number): number;
/** Truncate string with ellipsis */
export declare function truncate(str: string, maxLen: number): string;
/** Sleep for ms */
export declare function sleep(ms: number): Promise<void>;
/** Retry with exponential backoff */
export declare function retry<T>(fn: () => Promise<T>, maxRetries?: number, baseDelayMs?: number): Promise<T>;
export { extractModifiedFilesFromEvidenceBody } from './workbench-evidence.js';
export { getWorkbenchLabelAction, getWorkbenchLabelActionDefinition, getWorkbenchLabelActionTone, getWorkbenchLabelDefinition, getWorkbenchLabelDefinitions, normalizeWorkbenchLabel, WORKBENCH_LABEL_ACTIONS, type WorkbenchLabelEnvironment, type WorkbenchLabelAction, type WorkbenchLabelActionDefinition, type WorkbenchLabelDefinition, type WorkbenchLabelTone, } from './workbench-labels.js';
export { isWorkbenchTaskCodexDispatchable, isWorkbenchTaskExternallyOwnedClaudeReview, isWorkbenchTaskWorkflowDispatchable, isWorkbenchTaskMaintenance, } from './workbench-dispatch.js';
//# sourceMappingURL=index.d.ts.map