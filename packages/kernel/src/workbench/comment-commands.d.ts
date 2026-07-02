import type { WorkbenchTaskCommentRecord, WorkbenchTaskStatus } from '@tik/shared';
export type SlashCommandName = 'approve' | 'done' | 'retry' | 'block' | 'cancel';
export interface ParsedSlashCommand {
    command: SlashCommandName;
    target: WorkbenchTaskStatus;
    reason: string;
}
/**
 * Parse a comment body for the first slash-command keyword. Returns null when
 * the author is not human (`authorKind !== 'human'`) or when no recognized
 * keyword is anchored to a line start.
 *
 * Pure: no IO, no globals. Easy to unit test all branches.
 */
export declare function parseSlashCommand(body: string, authorKind: WorkbenchTaskCommentRecord['authorKind'], authorId?: string): ParsedSlashCommand | null;
//# sourceMappingURL=comment-commands.d.ts.map