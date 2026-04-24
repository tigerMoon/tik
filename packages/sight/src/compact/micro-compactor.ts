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

const DEFAULTS: Required<CompactionOptions> = {
  keepRecent: 5,
  maxTokens: 4000,
  maxToolResultChars: 500,
  maxAssistantChars: 300,
};

export class MicroCompactor {
  /**
   * Compact session messages.
   * Recent messages kept raw; older messages truncated or removed.
   */
  compact(messages: ChatMessage[], options?: CompactionOptions): CompactionResult {
    const opts = { ...DEFAULTS, ...options };

    if (messages.length <= opts.keepRecent) {
      return { messages: [...messages], removed: 0, truncated: 0 };
    }

    // Split into old and recent
    const splitPoint = messages.length - opts.keepRecent;
    const oldMessages = messages.slice(0, splitPoint);
    const recentMessages = messages.slice(splitPoint);

    // Process old messages
    const compacted: ChatMessage[] = [];
    let removed = 0;
    let truncated = 0;
    const summaryParts: string[] = [];

    // Keep only the last system message from old messages
    const lastSystemIdx = this.findLastIndex(oldMessages, m => m.role === 'system');

    for (let i = 0; i < oldMessages.length; i++) {
      const msg = oldMessages[i];

      // Remove old system messages (keep only the last one)
      if (msg.role === 'system' && i !== lastSystemIdx) {
        removed++;
        continue;
      }

      // Truncate old tool results
      if (msg.role === 'tool') {
        if (msg.content.length > opts.maxToolResultChars) {
          compacted.push({
            ...msg,
            content: msg.content.slice(0, opts.maxToolResultChars) + '\n[... truncated]',
          });
          truncated++;
        } else {
          compacted.push(msg);
        }
        continue;
      }

      // Truncate old assistant messages
      if (msg.role === 'assistant') {
        if (msg.content.length > opts.maxAssistantChars) {
          summaryParts.push(`[${msg.name || 'assistant'}] ${msg.content.slice(0, 100)}...`);
          compacted.push({
            ...msg,
            content: msg.content.slice(0, opts.maxAssistantChars) + '\n[... truncated]',
          });
          truncated++;
        } else {
          compacted.push(msg);
        }
        continue;
      }

      // Keep user messages
      compacted.push(msg);
    }

    // Token budget check on compacted old messages
    let tokenEstimate = this.estimateTokens(compacted);
    while (tokenEstimate > opts.maxTokens && compacted.length > 0) {
      const dropped = compacted.shift()!;
      removed++;
      tokenEstimate -= Math.ceil(dropped.content.length / 4);
    }

    // Build summary
    const summary = summaryParts.length > 0
      ? [
          'Continuation summary:',
          `- Scope: compacted ${removed} messages, truncated ${truncated}.`,
          `- Pending work: Continue from the latest assistant/tool context instead of re-reading the full history.`,
          `- Current work: Resume the last active coding or review thread with the preserved recent messages.`,
          '- Key timeline:',
          ...summaryParts.slice(-5).map((part) => `  - ${part}`),
        ].join('\n')
      : undefined;

    return {
      messages: [...compacted, ...recentMessages],
      removed,
      truncated,
      summary,
    };
  }

  private estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  private findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i])) return i;
    }
    return -1;
  }
}
