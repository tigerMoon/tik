import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchTaskLaunchInput,
  shouldInitializeWorkbenchTaskLaunchDraft,
  validateWorkbenchTaskLaunchDraft,
} from './workbench-task-launch';

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

  it('allows attachments to satisfy the task goal requirement', () => {
    expect(validateWorkbenchTaskLaunchDraft({
      title: '修复任务详情体验问题',
      goal: '',
      attachmentCount: 1,
    })).toEqual({
      valid: true,
      titleError: null,
      goalError: null,
    });
  });

  it('still requires a title when attachments provide the goal body', () => {
    expect(validateWorkbenchTaskLaunchDraft({
      title: '   ',
      goal: '',
      attachmentCount: 1,
    })).toEqual({
      valid: false,
      titleError: 'Task title is required.',
      goalError: null,
    });
  });

  it('does not reset an open launch draft when surrounding workspace state refreshes', () => {
    expect(shouldInitializeWorkbenchTaskLaunchDraft({
      launcherOpen: true,
      wasLauncherOpen: true,
    })).toBe(false);
  });

  it('initializes the launch draft when the panel first opens', () => {
    expect(shouldInitializeWorkbenchTaskLaunchDraft({
      launcherOpen: true,
      wasLauncherOpen: false,
    })).toBe(true);
  });

  it('adds a dispatchable docs label for todo documentation tasks without explicit labels', () => {
    expect(buildWorkbenchTaskLaunchInput({
      title: '更新项目 README.md',
      status: 'todo',
      labels: [],
      selectedPack: {
        taskLabels: [
          { value: 'implementation', label: 'Implementation', action: 'codex_dispatch', description: 'Implementation work.', aliases: [] },
          { value: 'docs', label: 'Docs', action: 'codex_dispatch', description: 'Documentation work.', aliases: [] },
        ],
      },
    })).toEqual({
      status: 'todo',
      labels: ['docs'],
    });
  });

  it('adds a docs dispatch label before review labels on new todo documentation tasks', () => {
    expect(buildWorkbenchTaskLaunchInput({
      title: '更新项目 README.md',
      status: 'todo',
      labels: ['needs-claude-review'],
      selectedPack: {
        taskLabels: [
          { value: 'docs', label: 'Docs', action: 'codex_dispatch', description: 'Documentation work.', aliases: [] },
          { value: 'needs-claude-review', label: 'Claude review', action: 'claude_code_review', description: 'Review after implementation.', aliases: ['claude-review'] },
        ],
      },
    })).toEqual({
      status: 'todo',
      labels: ['docs', 'needs-claude-review'],
    });
  });

  it('preserves explicit labels for todo tasks', () => {
    expect(buildWorkbenchTaskLaunchInput({
      title: 'Update API handler',
      status: 'todo',
      labels: ['backend'],
      selectedPack: {
        taskLabels: [
          { value: 'implementation', label: 'Implementation', action: 'codex_dispatch', description: 'Implementation work.', aliases: [] },
          { value: 'backend', label: 'Backend', action: 'codex_dispatch', description: 'Backend work.', aliases: [] },
        ],
      },
    })).toEqual({
      status: 'todo',
      labels: ['backend'],
    });
  });
});
