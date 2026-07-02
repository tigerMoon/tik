/**
 * Tool Result Store (Phase 2.8)
 *
 * Prevents large tool outputs from polluting session messages and prompt.
 * When output exceeds threshold:
 * - Full result saved to .tik/tool-results/<taskId>/<toolCallId>.txt
 * - Session message replaced with preview + artifact reference
 */
import type { ToolResultRef } from '@tik/shared';
export declare class ToolResultStore {
    private baseDir;
    constructor(projectPath: string);
    /** Check if a tool result should be stored externally */
    shouldStore(output: string): boolean;
    /** Store large tool result and return a preview reference */
    store(taskId: string, toolCallId: string, toolName: string, output: string, isError?: boolean): Promise<ToolResultRef>;
    /** Retrieve full tool result from store */
    retrieve(taskId: string, toolCallId: string): Promise<string | null>;
    /** Format a ToolResultRef as a message for session history */
    static formatPreview(ref: ToolResultRef): string;
}
//# sourceMappingURL=tool-result-store.d.ts.map