import { describe, expect, it, vi } from 'vitest';
import { WorkflowSubtaskRuntime } from '../src/subtask-runtime.js';
import type { WorkflowSubtaskSpec } from '@tik/shared';

describe('WorkflowSubtaskRuntime', () => {
  it('creates a real child task identity before execution and returns normalized result', async () => {
    const eventBus = {
      onAny: vi.fn().mockReturnValue(() => {}),
    };
    const createSpy = vi.fn().mockImplementation((input) => ({
      id: 'task-child-1',
      description: input.description,
      projectPath: input.projectPath,
      strategy: input.strategy,
      maxIterations: input.maxIterations,
    }));
    const runTaskSpy = vi.fn().mockResolvedValue({
      status: 'converged',
      summary: 'Subtask converged.',
    });
    const disposeSpy = vi.fn();

    const runtime = new WorkflowSubtaskRuntime(() => ({
      kernel: {
        taskManager: { create: createSpy },
        eventBus,
        runTask: runTaskSpy,
        dispose: disposeSpy,
      } as any,
      dispose: disposeSpy,
    }));

    const spec: WorkflowSubtaskSpec = {
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_SPECIFY',
      contract: 'SPECIFY_SUBTASK',
      skillName: 'sdd-specify',
      skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
      description: 'Generate project spec',
      inputs: {
        demand: 'generate project spec',
      },
      maxIterations: 1,
      strategy: 'incremental',
    };

    const handle = runtime.create(spec);
    expect(handle.taskId).toBe('task-child-1');

    const result = await handle.execute();
    expect(result.taskId).toBe('task-child-1');
    expect(result.projectName).toBe('service-a');
    expect(result.contract).toBe('SPECIFY_SUBTASK');
    expect(result.skillName).toBe('sdd-specify');
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Subtask converged.');
    expect(runTaskSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-child-1' }), 'single');
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('can execute a batch of child tasks', async () => {
    let counter = 0;
    const eventBus = {
      onAny: vi.fn().mockReturnValue(() => {}),
    };
    const runtime = new WorkflowSubtaskRuntime(() => ({
      kernel: {
        taskManager: {
          create: vi.fn().mockImplementation((input) => {
            counter += 1;
            return {
              id: `task-child-${counter}`,
              description: input.description,
              projectPath: input.projectPath,
              strategy: input.strategy,
              maxIterations: input.maxIterations,
            };
          }),
        },
        eventBus,
        runTask: vi.fn().mockResolvedValue({
          status: 'completed',
          summary: 'ok',
        }),
        dispose: vi.fn(),
      } as any,
    }));

    const specs: WorkflowSubtaskSpec[] = [
      {
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-plan/SKILL.md',
        description: 'Generate plan a',
        inputs: {
          demand: 'generate plan a',
        },
      },
      {
        projectName: 'service-b',
        projectPath: '/tmp/service-b',
        phase: 'PARALLEL_ACE',
        contract: 'ACE_SUBTASK',
        skillName: 'ace-sdd-workflow',
        skillPath: '/Users/huyuehui/.agents/skills/ace-sdd-workflow/SKILL.md',
        description: 'Run ace b',
        inputs: {
          demand: 'run ace b',
        },
      },
    ];

    const results = await runtime.executeBatch(specs);
    expect(results).toHaveLength(2);
    expect(results.map((item) => item.taskId)).toEqual(['task-child-1', 'task-child-2']);
    expect(results.map((item) => item.projectName)).toEqual(['service-a', 'service-b']);
  });

  it('normalizes non-converged specify/plan subtasks to completed when they finished without a hard error', async () => {
    const eventBus = {
      onAny: vi.fn().mockReturnValue(() => {}),
    };
    const runtime = new WorkflowSubtaskRuntime(() => ({
      kernel: {
        taskManager: {
          create: vi.fn().mockReturnValue({
            id: 'task-child-2',
            description: 'Generate project spec',
            projectPath: '/tmp/service-a',
            strategy: 'incremental',
            maxIterations: 1,
          }),
        },
        eventBus,
        runTask: vi.fn().mockResolvedValue({
          status: 'failed',
          summary: 'Completed 1 steps in single mode',
        }),
        dispose: vi.fn(),
      } as any,
    }));

    const spec: WorkflowSubtaskSpec = {
      projectName: 'service-a',
      projectPath: '/tmp/service-a',
      phase: 'PARALLEL_SPECIFY',
      contract: 'SPECIFY_SUBTASK',
      skillName: 'sdd-specify',
      skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
      description: 'Generate project spec',
      inputs: {
        demand: 'generate project spec',
      },
      maxIterations: 1,
      strategy: 'incremental',
    };

    const result = await runtime.create(spec).execute();
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Completed 1 steps in single mode');
  });
});
