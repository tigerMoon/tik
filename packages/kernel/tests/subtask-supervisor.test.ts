import { describe, expect, it, vi } from 'vitest';
import { WorkflowSubtaskSupervisor } from '../src/subtask-supervisor.js';
import type { WorkflowSubtaskResult, WorkflowSubtaskSpec } from '@tik/shared';

describe('WorkflowSubtaskSupervisor', () => {
  it('prepares child-task records before execution', () => {
    const runtime = {
      create: vi.fn((spec: WorkflowSubtaskSpec) => ({
        taskId: `task-${spec.projectName}`,
        spec,
        execute: vi.fn(),
      })),
    } as any;

    const supervisor = new WorkflowSubtaskSupervisor(runtime);
    const prepared = supervisor.prepare([
      {
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
        description: 'spec a',
        inputs: {
          demand: 'spec a',
        },
      },
    ]);

    expect(prepared.handles).toHaveLength(1);
    expect(prepared.records).toEqual([
      expect.objectContaining({
        taskId: 'task-service-a',
        projectName: 'service-a',
        state: 'prepared',
        attempt: 1,
        contract: 'SPECIFY_SUBTASK',
      }),
    ]);
  });

  it('emits running/completed transitions and returns results', async () => {
    const result: WorkflowSubtaskResult = {
      taskId: 'task-service-a',
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_ACE',
      contract: 'ACE_SUBTASK',
      skillName: 'ace-sdd-workflow',
      status: 'completed',
      summary: 'done',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const runtime = {
      create: vi.fn((spec: WorkflowSubtaskSpec) => ({
        taskId: result.taskId,
        spec,
        execute: vi.fn().mockResolvedValue(result),
      })),
    } as any;

    const transitions: string[] = [];
    const supervisor = new WorkflowSubtaskSupervisor(runtime);
    const prepared = supervisor.prepare([
      {
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_ACE',
        contract: 'ACE_SUBTASK',
        skillName: 'ace-sdd-workflow',
        skillPath: '/Users/huyuehui/.agents/skills/ace-sdd-workflow/SKILL.md',
        description: 'ace a',
        inputs: {
          demand: 'ace a',
        },
      },
    ]);

    const results = await supervisor.executePrepared(prepared, async (record) => {
      transitions.push(record.state);
    });

    expect(transitions).toEqual(['running', 'completed']);
    expect(results).toEqual([result]);
  });
});
