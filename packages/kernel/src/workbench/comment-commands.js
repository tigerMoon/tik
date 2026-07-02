const COMMAND_TARGET = {
    approve: 'in_progress',
    done: 'completed',
    retry: 'todo',
    block: 'blocked',
    cancel: 'cancelled',
};
const COMMAND_REASON_VERB = {
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
export function parseSlashCommand(body, authorKind, authorId) {
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
    const command = match[1].toLowerCase();
    const actor = authorId?.trim() || 'an operator';
    const reason = `${COMMAND_REASON_VERB[command]} via comment by ${actor}`;
    return {
        command,
        target: COMMAND_TARGET[command],
        reason,
    };
}
//# sourceMappingURL=comment-commands.js.map