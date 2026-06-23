import { describe, expect, it } from 'vitest';
import type { EnvironmentPackManifest } from './environment-pack.js';
import {
  applyEnvironmentPackSelection,
  buildEnvironmentPackPromotionQueue,
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
  taskLabels: [
    {
      value: 'frontend',
      label: 'Frontend',
      action: 'codex_dispatch',
      description: 'Frontend implementation work.',
      aliases: [],
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

  it('builds promotion queue items with a shared limit option', () => {
    const pack: EnvironmentPackManifest = {
      ...PACK,
      workflowBindings: [
        {
          workflow: 'feature-delivery',
          phases: {
            plan: ['missing-plan'],
            review: ['missing-review'],
            verify: ['frontend-preview'],
          },
        },
      ],
      evaluators: [],
    };

    expect(buildEnvironmentPackPromotionQueue(pack, { limit: 2 })).toEqual([
      {
        id: 'missing-capability:feature-delivery:plan:missing-plan',
        kind: 'capability proposal',
        detail: 'Promote "missing-plan" into feature-delivery / plan so this pack can satisfy its declared workflow binding.',
      },
      {
        id: 'missing-capability:feature-delivery:review:missing-review',
        kind: 'capability proposal',
        detail: 'Promote "missing-review" into feature-delivery / review so this pack can satisfy its declared workflow binding.',
      },
    ]);
    expect(buildEnvironmentPackPromotionQueue(pack)).toHaveLength(3);
  });
});
