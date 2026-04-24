import { describe, expect, it } from 'vitest';
import {
  canArchiveWorkbenchTask,
  canRetryWorkbenchTask,
  isWorkbenchTerminalStatus,
  type CreateWorkbenchTaskInput,
  type WorkbenchDecisionRecord,
  type WorkbenchEvidenceRecord,
  type WorkbenchSessionRecord,
  type WorkbenchTaskRecord,
  type WorkbenchTimelineItem,
} from '../src/index.js';

describe('workbench shared types', () => {
  it('treats completed, failed, and archived as terminal statuses', () => {
    expect(isWorkbenchTerminalStatus('completed')).toBe(true);
    expect(isWorkbenchTerminalStatus('failed')).toBe(true);
    expect(isWorkbenchTerminalStatus('cancelled')).toBe(true);
    expect(isWorkbenchTerminalStatus('archived')).toBe(true);
    expect(isWorkbenchTerminalStatus('running')).toBe(false);
  });

  it('allows retry for inactive workbench tasks but blocks running and waiting tasks', () => {
    expect(canRetryWorkbenchTask('new')).toBe(true);
    expect(canRetryWorkbenchTask('failed')).toBe(true);
    expect(canRetryWorkbenchTask('cancelled')).toBe(true);
    expect(canRetryWorkbenchTask('paused')).toBe(true);
    expect(canRetryWorkbenchTask('completed')).toBe(true);
    expect(canRetryWorkbenchTask('archived')).toBe(true);
    expect(canRetryWorkbenchTask('running')).toBe(false);
    expect(canRetryWorkbenchTask('waiting_for_user')).toBe(false);
  });

  it('allows archiving only for inactive workbench tasks', () => {
    expect(canArchiveWorkbenchTask('new')).toBe(true);
    expect(canArchiveWorkbenchTask('failed')).toBe(true);
    expect(canArchiveWorkbenchTask('cancelled')).toBe(true);
    expect(canArchiveWorkbenchTask('paused')).toBe(true);
    expect(canArchiveWorkbenchTask('completed')).toBe(true);
    expect(canArchiveWorkbenchTask('archived')).toBe(false);
    expect(canArchiveWorkbenchTask('running')).toBe(false);
    expect(canArchiveWorkbenchTask('waiting_for_user')).toBe(false);
  });

  it('allows summary timeline items to reference raw evidence ids', () => {
    const input: CreateWorkbenchTaskInput = {
      title: 'Ship the workbench',
      goal: 'Build a task-first cockpit',
    };

    const task: WorkbenchTaskRecord = {
      id: 'wb-task-1',
      title: input.title,
      goal: input.goal,
      status: 'running',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      activeSessionId: 'wb-session-1',
      currentOwner: 'supervisor',
      latestSummary: 'Supervisor is preparing the first task slice.',
    };

    const item: WorkbenchTimelineItem = {
      id: 'msg-1',
      taskId: task.id,
      kind: 'summary',
      actor: 'supervisor',
      body: 'Prepared the first implementation slice.',
      evidenceIds: ['ev-1', 'ev-2'],
      createdAt: '2026-04-09T00:00:01.000Z',
    };

    expect(item.evidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('models session, decision, and evidence records for an active task', () => {
    const session: WorkbenchSessionRecord = {
      id: 'wb-session-1',
      taskId: 'wb-task-1',
      status: 'running',
      owner: 'supervisor',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:05.000Z',
      compactSummary: 'Supervisor is coordinating the current work slice.',
    };

    const decision: WorkbenchDecisionRecord = {
      id: 'decision-1',
      taskId: session.taskId,
      title: 'Approve the next risky step',
      summary: 'A write operation is ready for review.',
      risk: 'high',
      recommendedOptionId: 'approve',
      status: 'pending',
      options: [
        {
          id: 'approve',
          label: 'Approve',
          description: 'Allow the step to proceed.',
          recommended: true,
        },
        {
          id: 'hold',
          label: 'Hold',
          description: 'Keep the task paused for review.',
        },
      ],
      createdAt: '2026-04-09T00:00:06.000Z',
      updatedAt: '2026-04-09T00:00:06.000Z',
    };

    const evidence: WorkbenchEvidenceRecord = {
      id: 'ev-1',
      taskId: session.taskId,
      kind: 'test',
      title: 'Shared package test run',
      body: 'pnpm --filter @tik/shared test -- workbench.test.ts',
      createdAt: '2026-04-09T00:00:07.000Z',
    };

    expect(session.compactSummary).toContain('Supervisor');
    expect(decision.options.find((option) => option.id === 'approve')).toEqual(
      expect.objectContaining({ recommended: true }),
    );
    expect(evidence).toMatchObject({
      taskId: session.taskId,
      kind: 'test',
      title: 'Shared package test run',
    });
  });
});
