/**
 * Micro-Compactor (Phase 2.8)
 *
 * Cheap message cleanup without LLM calls.
 * Goal: reduce noise and control token growth in session messages.
 *
 * Strategy:
 * - Keep last N raw messages untouched
 * - For older messages: truncate tool results, trim assistant text
 * - Remove redundant system messages
 * - Track what was removed for debugging
 */
import type { ChatMessage } from '@tik/shared';
export interface CompactionOptions {
    /** Number of recent messages to keep raw (default: 5) */
    keepRecent?: number;
    /** Max tokens for compacted message window (default: 4000) */
    maxTokens?: number;
    /** Max chars for old tool results (default: 500) */
    maxToolResultChars?: number;
    /** Max chars for old assistant messages (default: 300) */
    maxAssistantChars?: number;
}
export interface CompactionResult {
    /** Compacted messages */
    messages: ChatMessage[];
    /** Number of messages removed */
    removed: number;
    /** Number of messages truncated */
    truncated: number;
    /** Generated summary of removed content */
    summary?: string;
}
export declare class MicroCompactor {
    /**
     * Compact session messages.
     * Recent messages kept raw; older messages truncated or removed.
     */
    compact(messages: ChatMessage[], options?: CompactionOptions): CompactionResult;
    private estimateTokens;
    private findLastIndex;
}
//# sourceMappingURL=micro-compactor.d.ts.map