import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSkillExecutorRegistry } from '../src/workspace-skill-executors.js';
import { WorkflowSkillExecutorRegistry } from '../src/workflow-skill-executor.js';
import type { WorkflowSkillExecutionRequest } from '../src/workflow-skill-executor.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('WorkflowSkillExecutorRegistry', () => {
  it('registers and executes contract-bound executors', async () => {
    const registry = new WorkflowSkillExecutorRegistry();
    const executor = vi.fn(async (_request: WorkflowSkillExecutionRequest) => ({
      summary: 'done',
      outputPath: '/tmp/spec.md',
      valid: true,
      status: 'completed' as const,
    }));

    registry.register('SPECIFY_SUBTASK', executor);

    const outcome = await registry.execute('SPECIFY_SUBTASK', {
      spec: {
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
        description: 'specify',
        inputs: {
          demand: 'generate spec',
        },
      },
      subtask: {
        taskId: 'task-1',
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        status: 'completed',
        summary: 'task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });

    expect(executor).toHaveBeenCalledOnce();
    expect(outcome.outputPath).toBe('/tmp/spec.md');
    expect(outcome.status).toBe('completed');
  });

  it('throws for missing executors', async () => {
    const registry = new WorkflowSkillExecutorRegistry();
    await expect(registry.execute('PLAN_SUBTASK', {
      spec: {
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-plan/SKILL.md',
        description: 'plan',
        inputs: {
          demand: 'generate plan',
        },
      },
      subtask: {
        taskId: 'task-2',
        projectName: 'service-a',
        projectPath: '/tmp/service-a',
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        status: 'completed',
        summary: 'task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    })).rejects.toThrow('No workflow skill executor registered');
  });

  it('creates default workspace executors that use structured demand inputs', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-executor-'));
    tempDirs.push(projectPath);
    const completion = vi.fn(async (_projectPath: string, prompt: string) => {
      if (prompt.includes('implementation spec')) {
        return {
          content: '# Goal\n\nImplement cache.\n',
          executionMode: 'native' as const,
        };
      }
      return {
        content: [
          '# Architecture Changes',
          '',
          '- Add cache',
          '',
          '# Implementation Steps',
          '',
          '- Update service',
          '',
          '# Validation',
          '',
          '- Run tests',
          '',
          '# Risks',
          '',
          '- Cache invalidation',
          '',
          '# Rollout Notes',
          '',
          '- Deploy gradually',
        ].join('\n'),
        executionMode: 'native' as const,
      };
    });
    const skillRuntime = {
      load: vi.fn(async (spec) => ({
        skillName: spec.skillName,
        skillPath: spec.skillPath,
        description: 'Loaded skill description',
        prompt: '# Skill Prompt\nFollow the skill strictly.',
      })),
    };
    const registry = createWorkspaceSkillExecutorRegistry({
      completion: { complete: completion },
      skillRuntime,
    });

    const specOutcome = await registry.execute('SPECIFY_SUBTASK', {
      spec: {
        projectName: 'service-a',
        projectPath,
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
        description: 'specify',
        inputs: {
          demand: '给 service-a 增加缓存',
          targetSpecPath: path.join(projectPath, '.specify', 'specs', 'feature-a', 'spec.md'),
        },
      },
      subtask: {
        taskId: 'task-1',
        projectName: 'service-a',
        projectPath,
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        status: 'completed',
        summary: 'task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    expect(specOutcome.outputPath).toBe(path.join(projectPath, '.specify', 'specs', 'feature-a', 'spec.md'));
    expect(completion).toHaveBeenCalledWith(
      projectPath,
      expect.stringContaining('给 service-a 增加缓存'),
      expect.any(Object),
    );
    expect(completion).toHaveBeenCalledWith(
      projectPath,
      expect.stringContaining('Skill Runtime Binding:'),
      expect.any(Object),
    );

    const planOutcome = await registry.execute('PLAN_SUBTASK', {
      spec: {
        projectName: 'service-a',
        projectPath,
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-plan/SKILL.md',
        description: 'plan',
        inputs: {
          demand: '给 service-a 增加缓存',
          resolvedSpecPath: path.join(projectPath, '.specify', 'specs', 'feature-a', 'spec.md'),
          targetPlanPath: path.join(projectPath, '.specify', 'specs', 'feature-a', 'plan.md'),
        },
      },
      subtask: {
        taskId: 'task-2',
        projectName: 'service-a',
        projectPath,
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        status: 'completed',
        summary: 'plan task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    expect(planOutcome.outputPath).toBe(path.join(projectPath, '.specify', 'specs', 'feature-a', 'plan.md'));
    expect(planOutcome.valid).toBe(true);
    expect(skillRuntime.load).toHaveBeenCalledTimes(2);
  });

  it('does not synthesize local fallback content when completion fails', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workflow-fallback-'));
    tempDirs.push(projectPath);
    const completion = vi.fn(async () => {
      throw new Error('Codex App Server did not emit a visible workspace turn event within 35s.');
    });
    const skillRuntime = {
      load: vi.fn(async (spec) => ({
        skillName: spec.skillName,
        skillPath: spec.skillPath,
        description: 'Loaded skill description',
        prompt: '# Skill Prompt',
      })),
    };
    const registry = createWorkspaceSkillExecutorRegistry({
      completion: { complete: completion },
      skillRuntime,
    });

    const demand = '给 service-b 增加缓存并同步 service-a 契约';
    await expect(registry.execute('SPECIFY_SUBTASK', {
      spec: {
        projectName: 'service-b',
        projectPath,
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-specify/SKILL.md',
        description: 'specify',
        inputs: {
          demand,
        },
      },
      subtask: {
        taskId: 'task-fallback-spec',
        projectName: 'service-b',
        projectPath,
        phase: 'PARALLEL_SPECIFY',
        contract: 'SPECIFY_SUBTASK',
        skillName: 'sdd-specify',
        status: 'completed',
        summary: 'task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    })).rejects.toThrow('Codex App Server did not emit a visible workspace turn event within 35s.');

    await expect(registry.execute('PLAN_SUBTASK', {
      spec: {
        projectName: 'service-b',
        projectPath,
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        skillPath: '/Users/huyuehui/.agents/skills/sdd-plan/SKILL.md',
        description: 'plan',
        inputs: {
          demand,
        },
      },
      subtask: {
        taskId: 'task-fallback-plan',
        projectName: 'service-b',
        projectPath,
        phase: 'PARALLEL_PLAN',
        contract: 'PLAN_SUBTASK',
        skillName: 'sdd-plan',
        status: 'completed',
        summary: 'task done',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    })).rejects.toThrow('Codex App Server did not emit a visible workspace turn event within 35s.');

    await expect(fs.access(path.join(projectPath, '.specify', 'specs', 'spec.md'))).rejects.toBeTruthy();
    await expect(fs.access(path.join(projectPath, '.specify', 'specs', 'plan.md'))).rejects.toBeTruthy();
  });
});
