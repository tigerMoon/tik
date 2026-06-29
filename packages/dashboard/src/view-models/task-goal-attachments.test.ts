import { describe, expect, it } from 'vitest';
import {
  appendWorkbenchTaskGoalAttachments,
  buildWorkbenchTaskGoalImageMarkdown,
  buildWorkbenchTaskGoalMarkdownFileSection,
  validateWorkbenchTaskLaunchDraftWithAttachments,
} from './task-goal-attachments';

describe('task goal attachments', () => {
  it('allows attachments to satisfy the task goal requirement', () => {
    expect(validateWorkbenchTaskLaunchDraftWithAttachments({
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
    expect(validateWorkbenchTaskLaunchDraftWithAttachments({
      title: '   ',
      goal: '',
      attachmentCount: 1,
    })).toEqual({
      valid: false,
      titleError: 'Task title is required.',
      goalError: null,
    });
  });

  it('formats pasted images as markdown data urls', () => {
    expect(buildWorkbenchTaskGoalImageMarkdown({
      name: 'screenshot.png',
      type: 'image/png',
      dataUrl: 'data:image/png;base64,abc123',
    })).toBe('![screenshot.png](data:image/png;base64,abc123)');
  });

  it('formats markdown files as named sections', () => {
    expect(buildWorkbenchTaskGoalMarkdownFileSection({
      name: 'requirements.md',
      text: '# Requirements\n\n- Support paste',
    })).toBe([
      '### requirements.md',
      '',
      '# Requirements',
      '',
      '- Support paste',
    ].join('\n'));
  });

  it('appends markdown files and images to the visible goal', () => {
    const goal = appendWorkbenchTaskGoalAttachments('Fix the launch form', [
      {
        id: 'md-1',
        kind: 'markdown',
        name: 'context.md',
        markdown: '### context.md\n\nMore context',
      },
      {
        id: 'img-1',
        kind: 'image',
        name: 'clip.png',
        markdown: '![clip.png](data:image/png;base64,abc123)',
      },
    ]);

    expect(goal).toBe([
      'Fix the launch form',
      '',
      '### Attached context',
      '',
      '### context.md',
      '',
      'More context',
      '',
      '![clip.png](data:image/png;base64,abc123)',
    ].join('\n'));
  });
});
