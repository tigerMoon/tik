import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from '../src/workbench/comment-commands.js';

describe('parseSlashCommand', () => {
  it('returns null for non-human authors', () => {
    expect(parseSlashCommand('/done', 'agent', 'supervisor')).toBeNull();
    expect(parseSlashCommand('/done', 'system', 'sys')).toBeNull();
  });

  it('returns null for empty / whitespace bodies', () => {
    expect(parseSlashCommand('', 'human', 'op')).toBeNull();
    expect(parseSlashCommand('   ', 'human', 'op')).toBeNull();
  });

  it('parses each of the 5 supported keywords', () => {
    const author = 'op';
    expect(parseSlashCommand('/approve', 'human', author)).toMatchObject({
      command: 'approve',
      target: 'in_progress',
    });
    expect(parseSlashCommand('/done', 'human', author)).toMatchObject({
      command: 'done',
      target: 'completed',
    });
    expect(parseSlashCommand('/retry', 'human', author)).toMatchObject({
      command: 'retry',
      target: 'todo',
    });
    expect(parseSlashCommand('/block', 'human', author)).toMatchObject({
      command: 'block',
      target: 'blocked',
    });
    expect(parseSlashCommand('/cancel', 'human', author)).toMatchObject({
      command: 'cancel',
      target: 'cancelled',
    });
  });

  it('is case-insensitive', () => {
    expect(parseSlashCommand('/DONE', 'human', 'op')?.command).toBe('done');
    expect(parseSlashCommand('/Approve some note', 'human', 'op')?.command).toBe('approve');
  });

  it('tolerates leading whitespace and follow-on text', () => {
    expect(parseSlashCommand('  /done with the latest pass', 'human', 'op')?.command).toBe('done');
    expect(parseSlashCommand('\t/cancel — too risky', 'human', 'op')?.command).toBe('cancel');
  });

  it('does NOT match mid-paragraph slash mentions', () => {
    expect(parseSlashCommand('hello /done world', 'human', 'op')).toBeNull();
    expect(parseSlashCommand('see the /approve note', 'human', 'op')).toBeNull();
  });

  it('matches when the slash command is on its own line in a multi-line comment', () => {
    const body = 'Looking good.\n/approve\nThanks.';
    expect(parseSlashCommand(body, 'human', 'op')?.command).toBe('approve');
  });

  it('first command wins when multiple commands are present', () => {
    const body = '/approve\n/done';
    expect(parseSlashCommand(body, 'human', 'op')?.command).toBe('approve');
  });

  it('produces a reason text that includes the author', () => {
    const parsed = parseSlashCommand('/done', 'human', 'huyuehui');
    expect(parsed?.reason).toBe('Marked done via comment by huyuehui');
  });

  it('uses a sensible fallback reason when authorId is missing', () => {
    const parsed = parseSlashCommand('/approve', 'human');
    expect(parsed?.reason).toBe('Approved via comment by an operator');
  });

  it('rejects unknown slash commands', () => {
    expect(parseSlashCommand('/yes', 'human', 'op')).toBeNull();
    expect(parseSlashCommand('/lgtm', 'human', 'op')).toBeNull();
    expect(parseSlashCommand('/transition completed', 'human', 'op')).toBeNull();
  });
});
