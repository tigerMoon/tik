import { describe, expect, it } from 'vitest';
import { SkillManifestRegistryEntrySchema, SkillManifestMutationInputSchema } from './skill-manifest.js';

describe('skill manifest shared types', () => {
  it('parses mutation input snapshots', () => {
    expect(SkillManifestMutationInputSchema.parse({
      notes: 'Review portability before publish.',
      snapshot: {
        skillId: 'api-compat-check',
        label: 'API Compat Check',
        scope: 'environment',
        version: '1.1.0',
        ownerPackId: 'commerce-ops',
        ownerPackName: 'Commerce Ops',
        packIds: ['commerce-ops'],
        packNames: ['Commerce Ops'],
        requiredTools: ['github'],
        requiredKnowledge: [
          { id: 'operations-runbook', label: 'Operations Runbook', kind: 'runbook' },
        ],
        policyHooks: ['pii-redaction'],
        evaluators: ['risk-evaluator'],
        bindings: [
          { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
        ],
        taskCount: 2,
        activeTaskCount: 1,
        selectedTaskCount: 2,
      },
    }).snapshot.skillId).toBe('api-compat-check');
  });

  it('parses registry entries with draft and published revisions', () => {
    expect(SkillManifestRegistryEntrySchema.parse({
      skillId: 'api-compat-check',
      ownerPackId: 'commerce-ops',
      scope: 'environment',
      draft: {
        notes: 'Tighten rollback guidance.',
        savedAt: '2026-04-13T06:00:00.000Z',
        snapshot: {
          skillId: 'api-compat-check',
          label: 'API Compat Check',
          scope: 'environment',
          version: '1.1.0',
          ownerPackId: 'commerce-ops',
          ownerPackName: 'Commerce Ops',
          packIds: ['commerce-ops'],
          packNames: ['Commerce Ops'],
          requiredTools: ['github'],
          requiredKnowledge: [],
          policyHooks: [],
          evaluators: [],
          bindings: [],
          taskCount: 0,
          activeTaskCount: 0,
          selectedTaskCount: 0,
        },
      },
      published: null,
      revisions: [],
    }).draft?.notes).toBe('Tighten rollback guidance.');
  });
});
