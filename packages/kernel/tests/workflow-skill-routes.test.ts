import { describe, expect, it } from 'vitest';
import { getWorkflowSkillRouteByContract, getWorkflowSkillRouteByPhase } from '../src/workflow-skill-routes.js';

describe('workflow skill routes', () => {
  it('resolves clarify route by phase', () => {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_CLARIFY');
    expect(route.contract).toBe('CLARIFY_SUBTASK');
    expect(route.skillName).toBe('superpowers-clarify');
    expect(route.skillSourceKind).toBe('superpowers');
    expect(route.skillPath).toContain('/.codex/skills/deep-interview/SKILL.md');
  });

  it('resolves specify route by phase', () => {
    const route = getWorkflowSkillRouteByPhase('PARALLEL_SPECIFY');
    expect(route.contract).toBe('SPECIFY_SUBTASK');
    expect(route.skillName).toBe('sdd-specify');
    expect(route.skillSourceKind).toBe('agents');
    expect(route.skillPath).toContain('/.agents/skills/sdd-specify/SKILL.md');
    expect(route.completionPromise).toBe('SPECIFY_COMPLETE');
  });

  it('resolves ace route by contract', () => {
    const route = getWorkflowSkillRouteByContract('ACE_SUBTASK');
    expect(route.phase).toBe('PARALLEL_ACE');
    expect(route.skillName).toBe('ace-sdd-workflow');
    expect(route.expectedOutput).toContain('convergence');
  });
});
