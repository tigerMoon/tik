import { describe, expect, it } from 'vitest';
import type { EnvironmentPackManifest } from './environment-pack.js';
import {
  applyEnvironmentPackSelection,
  buildEnvironmentPackWorkflowCoverage,
  getEnvironmentPackCapabilitySource,
} from './environment-pack.js';

const PACK: EnvironmentPackManifest = {
  kind: 'EnvironmentPack',
  id: 'design-to-code',
  name: 'Design To Code',
  version: '0.1.0',
  description: 'Frontend delivery environment',
  tools: ['frontend-preview'],
  skills: ['figma-to-react', 'ui-review'],
  knowledge: [
    { id: 'design-system', kind: 'design-system', label: 'Design System' },
  ],
  policies: ['design-review-before-publish'],
  workflowBindings: [
    {
      workflow: 'feature-delivery',
      phases: {
        plan: ['ui-review'],
        implement: ['figma-to-react'],
        verify: ['frontend-preview', 'ux-consistency-evaluator'],
      },
    },
  ],
  evaluators: ['ux-consistency-evaluator'],
};

describe('environment pack capability helpers', () => {
  it('resolves capability sources across skills, tools, and evaluators', () => {
    expect(getEnvironmentPackCapabilitySource(PACK, 'figma-to-react')).toBe('skill');
    expect(getEnvironmentPackCapabilitySource(PACK, 'frontend-preview')).toBe('tool');
    expect(getEnvironmentPackCapabilitySource(PACK, 'ux-consistency-evaluator')).toBe('evaluator');
    expect(getEnvironmentPackCapabilitySource(PACK, 'missing-capability')).toBeNull();
  });

  it('keeps non-skill capabilities when applying task-level skill selection', () => {
    const selected = applyEnvironmentPackSelection(PACK, {
      selectedSkills: ['figma-to-react'],
      selectedKnowledgeIds: ['design-system'],
    });

    expect(selected.skills).toEqual(['figma-to-react']);
    expect(selected.workflowBindings[0]?.phases).toEqual({
      plan: [],
      implement: ['figma-to-react'],
      verify: ['frontend-preview', 'ux-consistency-evaluator'],
    });
  });

  it('builds workflow coverage using every capability source', () => {
    expect(buildEnvironmentPackWorkflowCoverage(PACK)).toEqual([
      {
        workflow: 'feature-delivery',
        coveredPhaseCount: 3,
        totalPhaseCount: 3,
        missingCapabilities: [],
        phases: [
          {
            phase: 'plan',
            covered: true,
            missingCapabilities: [],
            requirements: [
              {
                capability: 'ui-review',
                source: 'skill',
              },
            ],
          },
          {
            phase: 'implement',
            covered: true,
            missingCapabilities: [],
            requirements: [
              {
                capability: 'figma-to-react',
                source: 'skill',
              },
            ],
          },
          {
            phase: 'verify',
            covered: true,
            missingCapabilities: [],
            requirements: [
              {
                capability: 'frontend-preview',
                source: 'tool',
              },
              {
                capability: 'ux-consistency-evaluator',
                source: 'evaluator',
              },
            ],
          },
        ],
      },
    ]);
  });
});
