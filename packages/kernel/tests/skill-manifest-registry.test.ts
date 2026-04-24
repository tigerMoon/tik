import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillManifestRegistry } from '../src/skill-manifest-registry.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('SkillManifestRegistry', () => {
  it('persists draft and published revisions for a skill manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-skill-manifest-registry-'));
    tempDirs.push(root);

    const registry = new SkillManifestRegistry(root);
    await registry.saveDraft('api-compat-check', {
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
        requiredKnowledge: [],
        policyHooks: ['pii-redaction'],
        evaluators: ['risk-evaluator'],
        bindings: [
          { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
        ],
        taskCount: 2,
        activeTaskCount: 1,
        selectedTaskCount: 2,
      },
    });

    const published = await registry.publish('api-compat-check', {
      notes: 'Ready to publish.',
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
        policyHooks: ['pii-redaction'],
        evaluators: ['risk-evaluator'],
        bindings: [
          { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
        ],
        taskCount: 2,
        activeTaskCount: 1,
        selectedTaskCount: 2,
      },
    });

    const reloaded = new SkillManifestRegistry(root);
    const entries = await reloaded.listSkills();

    expect(entries).toHaveLength(1);
    expect(entries[0].draft?.notes).toBe('Ready to publish.');
    expect(entries[0].published?.notes).toBe('Ready to publish.');
    expect(entries[0].revisions).toHaveLength(2);
    expect(entries[0].revisions.map((revision) => revision.kind)).toEqual(['draft_saved', 'published']);
    expect(published.published?.snapshot.skillId).toBe('api-compat-check');
  });
});
