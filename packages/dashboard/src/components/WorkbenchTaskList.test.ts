import { describe, expect, it } from 'vitest';
import { validateWorkbenchTaskLaunchDraft } from './WorkbenchTaskList';

describe('validateWorkbenchTaskLaunchDraft', () => {
  it('requires a visible goal before launching a task', () => {
    expect(validateWorkbenchTaskLaunchDraft({
      title: '清理worktree',
      goal: '',
    })).toEqual({
      valid: false,
      titleError: null,
      goalError: 'Task goal is required.',
    });
  });

  it('requires a visible title before launching a task', () => {
    expect(validateWorkbenchTaskLaunchDraft({
      title: '   ',
      goal: 'Clean stale worktrees',
    })).toEqual({
      valid: false,
      titleError: 'Task title is required.',
      goalError: null,
    });
  });

  it('accepts trimmed title and goal values', () => {
    expect(validateWorkbenchTaskLaunchDraft({
      title: ' 清理worktree ',
      goal: ' Clean stale worktrees ',
    })).toEqual({
      valid: true,
      titleError: null,
      goalError: null,
    });
  });
});
