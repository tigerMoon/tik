import { describe, expect, it } from 'vitest';
import { deriveComposerTaskDraft, parseUniversalComposerIntent } from './composer';

describe('universal composer intent parser', () => {
  const task = {
    id: 'task-1abc2345',
    title: 'Existing task',
    goal: 'Existing goal',
    status: 'running' as const,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
  };

  const secondaryTask = {
    id: 'task-2def6789',
    title: 'Secondary task',
    goal: 'Secondary goal',
    status: 'running' as const,
    createdAt: '2026-04-13T00:00:00.000Z',
    updatedAt: '2026-04-13T00:00:00.000Z',
  };

  it('creates a task from freeform input when no task is selected', () => {
    expect(parseUniversalComposerIntent('设计一个贪吃蛇游戏，H5 页面，可以玩耍', {
      task: null,
      decisions: [],
    })).toEqual({
      kind: 'create_task',
      title: '设计一个贪吃蛇游戏',
      goal: '设计一个贪吃蛇游戏，H5 页面，可以玩耍',
      explicit: false,
    });
  });

  it('creates a task from an explicit new-task command even while a task is active', () => {
    expect(parseUniversalComposerIntent('new: control console polish | refine the queue and acceptance rail', {
      task,
      decisions: [],
    })).toEqual({
      kind: 'create_task',
      title: 'control console polish',
      goal: 'refine the queue and acceptance rail',
      explicit: true,
    });
  });

  it('routes approve and reject commands to the current pending decision', () => {
    const decisionTask = {
      ...task,
      title: 'Pending review',
      goal: 'Wait for decision',
      status: 'waiting_for_user' as const,
    };
    const decisions = [
      {
        id: 'decision-1',
        taskId: decisionTask.id,
        title: 'High-risk action: bash',
        summary: 'Need approval',
        risk: 'high' as const,
        status: 'pending' as const,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        createdAt: '2026-04-13T00:00:00.000Z',
        updatedAt: '2026-04-13T00:00:00.000Z',
      },
    ];

    expect(parseUniversalComposerIntent('批准：继续 dry-run', { task: decisionTask, decisions })).toEqual({
      kind: 'resolve_decision',
      optionId: 'approve',
      message: '继续 dry-run',
      targetTaskId: decisionTask.id,
      targetTaskLabel: decisionTask.title,
    });

    expect(parseUniversalComposerIntent('reject: missing rollback plan', { task: decisionTask, decisions })).toEqual({
      kind: 'resolve_decision',
      optionId: 'reject',
      message: 'missing rollback plan',
      targetTaskId: decisionTask.id,
      targetTaskLabel: decisionTask.title,
    });
  });

  it('falls back to an operator note for active tasks when no command matches', () => {
    expect(parseUniversalComposerIntent('把验收标准再收紧一些，先出可预览产物。', {
      task,
      decisions: [],
    })).toEqual({
      kind: 'apply_note',
      note: '把验收标准再收紧一些，先出可预览产物。',
      targetTaskId: task.id,
      targetTaskLabel: task.title,
    });
  });

  it('supports hash commands for new task and note routing', () => {
    expect(parseUniversalComposerIntent('#new: Console cleanup | tighten command routing', {
      task,
      decisions: [],
    })).toEqual({
      kind: 'create_task',
      title: 'Console cleanup',
      goal: 'tighten command routing',
      explicit: true,
    });

    expect(parseUniversalComposerIntent('#note: 先产出可预览 UI，再补额外交互', {
      task,
      decisions: [],
    })).toEqual({
      kind: 'apply_note',
      note: '先产出可预览 UI，再补额外交互',
      targetTaskId: task.id,
      targetTaskLabel: task.title,
    });
  });

  it('does not reinterpret a hash note as a new task when no task is selected', () => {
    expect(parseUniversalComposerIntent('#note: keep the current mission focused', {
      task: null,
      decisions: [],
    })).toEqual({
      kind: 'apply_note',
      note: 'keep the current mission focused',
    });
  });

  it('targets another task by short id for operator notes', () => {
    expect(parseUniversalComposerIntent(`@${secondaryTask.id.slice(0, 8).toUpperCase()} #note: 收紧验收标准`, {
      task,
      tasks: [task, secondaryTask],
      decisions: [],
    })).toEqual({
      kind: 'apply_note',
      note: '收紧验收标准',
      targetTaskId: secondaryTask.id,
      targetTaskLabel: secondaryTask.title,
    });
  });

  it('preserves unresolved target tokens as regular note text', () => {
    expect(parseUniversalComposerIntent('@UNKNOWN #note: keep this on the current task', {
      task,
      tasks: [task, secondaryTask],
      decisions: [],
    })).toEqual({
      kind: 'apply_note',
      note: '@UNKNOWN #note: keep this on the current task',
      targetTaskId: task.id,
      targetTaskLabel: task.title,
    });
  });

  it('recognizes explicit hash decision commands even before submission-time validation', () => {
    expect(parseUniversalComposerIntent(`@${secondaryTask.id.slice(0, 8).toUpperCase()} #approve: ship it`, {
      task,
      tasks: [task, secondaryTask],
      decisions: [],
    })).toEqual({
      kind: 'resolve_decision',
      optionId: 'approve',
      message: 'ship it',
      targetTaskId: secondaryTask.id,
      targetTaskLabel: secondaryTask.title,
    });
  });

  it('derives a task draft from pipe-delimited input', () => {
    expect(deriveComposerTaskDraft('Control console polish | tighten task routing and review copy')).toEqual({
      title: 'Control console polish',
      goal: 'tighten task routing and review copy',
    });
  });
});
