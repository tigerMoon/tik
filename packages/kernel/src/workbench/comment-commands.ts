import type { WorkbenchTaskCommentRecord, WorkbenchTaskStatus } from '@tik/shared';

export type SlashCommandName = 'approve' | 'done' | 'retry' | 'block' | 'cancel';

export interface ParsedSlashCommand {
  command: SlashCommandName;
  target: WorkbenchTaskStatus;
  reason: string;
}

const COMMAND_TARGET: Record<SlashCommandName, WorkbenchTaskStatus> = {
  approve: 'in_progress',
  done: 'completed',
  retry: 'todo',
  block: 'blocked',
  cancel: 'cancelled',
};

const COMMAND_REASON_VERB: Record<SlashCommandName, string> = {
  approve: 'Approved',
  done: 'Marked done',
  retry: 'Reopened',
  block: 'Blocked',
  cancel: 'Cancelled',
};

// Anchored to a line start (with optional leading whitespace), then `/cmd`,
// then a word boundary. Mid-paragraph occurrences (e.g. "see /done note")
// are intentionally ignored.
const SLASH_COMMAND_REGEX = /^\s*\/(approve|done|retry|block|cancel)\b/im;

/**
 * Parse a comment body for the first slash-command keyword. Returns null when
 * the author is not human (`authorKind !== 'human'`) or when no recognized
 * keyword is anchored to a line start.
 *
 * Pure: no IO, no globals. Easy to unit test all branches.
 */
export function parseSlashCommand(
  body: string,
  authorKind: WorkbenchTaskCommentRecord['authorKind'],
  authorId?: string,
): ParsedSlashCommand | null {
  if (authorKind !== 'human') {
    return null;
  }
  const trimmed = (body || '').trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(SLASH_COMMAND_REGEX);
  if (!match) {
    return null;
  }

  const command = match[1].toLowerCase() as SlashCommandName;
  const actor = authorId?.trim() || 'an operator';
  const reason = `${COMMAND_REASON_VERB[command]} via comment by ${actor}`;
  return {
    command,
    target: COMMAND_TARGET[command],
    reason,
  };
}
