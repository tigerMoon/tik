import { describe, expect, it } from 'vitest';
import {
  getWorkspaceWorkflowPhaseSpec,
  getWorkspaceWorkflowPhaseSpecByContract,
} from '../src/workspace-workflow-spec.js';

describe('workspace workflow spec', () => {
  it('defines a first-class phase spec for clarify', () => {
    const spec = getWorkspaceWorkflowPhaseSpec('PARALLEL_CLARIFY');

    expect(spec.role).toBe('planner');
    expect(spec.contract).toBe('CLARIFY_SUBTASK');
    expect(spec.skillName).toBe('superpowers-clarify');
    expect(spec.nextPhase).toBe('PARALLEL_SPECIFY');
  });

  it('defines a first-class phase spec for specify', () => {
    const spec = getWorkspaceWorkflowPhaseSpec('PARALLEL_SPECIFY');

    expect(spec.role).toBe('planner');
    expect(spec.contract).toBe('SPECIFY_SUBTASK');
    expect(spec.requiredArtifacts).toContain('spec.md');
    expect(spec.nextPhase).toBe('PARALLEL_PLAN');
  });

  it('resolves ace spec by contract', () => {
    const spec = getWorkspaceWorkflowPhaseSpecByContract('ACE_SUBTASK');

    expect(spec.phase).toBe('PARALLEL_ACE');
    expect(spec.role).toBe('executor');
    expect(spec.nextPhase).toBe('COMPLETED');
  });
});
