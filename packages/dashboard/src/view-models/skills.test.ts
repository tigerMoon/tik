import { describe, expect, it } from 'vitest';
import type { EnvironmentPackManifest } from '@tik/shared';
import type { WorkbenchTaskResponse } from '../api/client';
import {
  buildSkillManifestMutationInput,
  buildSkillBindingsSnippet,
  buildSkillChecklist,
  buildSkillChangeItems,
  buildSkillCommandSnippet,
  buildSkillDependenciesSnippet,
  buildSkillImpactItems,
  buildSkillManifestRecords,
  buildSkillPublishMutationInput,
  buildSkillPublishRecommendation,
  buildSkillManifestSnippet,
  buildSkillTestHarnessSnippet,
  buildSkillVersionEntries,
  labelizeSkillId,
  resolveSkillManifestPersistenceStatus,
} from './skills.js';

const BASE_PACK: EnvironmentPackManifest = {
  kind: 'EnvironmentPack',
  id: 'base-engineering',
  name: 'Base Engineering',
  version: '0.2.0',
  description: 'Default engineering pack',
  tools: ['github'],
  skills: ['coder', 'pr-review'],
  knowledge: [
    { id: 'repo-index', kind: 'repo-index', label: 'Repo Index' },
    { id: 'engineering-policies', kind: 'decision-log', label: 'Engineering Policies' },
  ],
  policies: ['peer-review'],
  workflowBindings: [
    {
      workflow: 'feature-delivery',
      phases: {
        implement: ['coder'],
        review: ['pr-review'],
        verify: ['github', 'risk-evaluator'],
      },
    },
  ],
  evaluators: ['risk-evaluator'],
};

const OPS_PACK: EnvironmentPackManifest = {
  kind: 'EnvironmentPack',
  id: 'commerce-ops',
  name: 'Commerce Ops',
  version: '1.1.0',
  description: 'Commerce-specific pack',
  tools: ['github', 'jira'],
  skills: ['pr-review', 'api-compat-check'],
  knowledge: [
    { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
    { id: 'repo-index', kind: 'repo-index', label: 'Repo Index' },
  ],
  policies: ['pii-redaction'],
  workflowBindings: [
    {
      workflow: 'feature-delivery',
      phases: {
        review: ['pr-review'],
        verify: ['api-compat-check'],
      },
    },
    {
      workflow: 'hotfix',
      phases: {
        verify: ['api-compat-check'],
      },
    },
  ],
  evaluators: ['risk-evaluator', 'contract-evaluator'],
};

const TASKS: WorkbenchTaskResponse[] = [
  {
    id: 'task-release',
    title: 'Audit service API compatibility',
    goal: 'Check backwards compatibility',
    status: 'running',
    createdAt: '2026-04-13T10:00:00.000Z',
    updatedAt: '2026-04-13T10:10:00.000Z',
    lastProgressAt: '2026-04-13T10:11:00.000Z',
    environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '1.1.0' },
    environmentPackSelection: {
      selectedSkills: ['api-compat-check'],
      selectedKnowledgeIds: ['operations-runbook', 'repo-index'],
    },
  },
  {
    id: 'task-review',
    title: 'Review base branch changes',
    goal: 'Review the latest diff',
    status: 'completed',
    createdAt: '2026-04-13T10:05:00.000Z',
    updatedAt: '2026-04-13T10:12:00.000Z',
    environmentPackSnapshot: { id: 'base-engineering', name: 'Base Engineering', version: '0.2.0' },
  },
  {
    id: 'task-shared',
    title: 'Prepare release gate',
    goal: 'Run shared review gates',
    status: 'paused',
    createdAt: '2026-04-13T10:15:00.000Z',
    updatedAt: '2026-04-13T10:20:00.000Z',
    lastProgressAt: '2026-04-13T10:25:00.000Z',
    environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '1.1.0' },
    environmentPackSelection: {
      selectedSkills: ['pr-review', 'api-compat-check'],
      selectedKnowledgeIds: ['operations-runbook'],
    },
  },
];

describe('skills view models', () => {
  it('builds shared and environment-scoped skill manifests from packs and task selections', () => {
    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );

    const prReview = records.find((record) => record.id === 'pr-review');
    const apiCompat = records.find((record) => record.id === 'api-compat-check');

    expect(prReview).toMatchObject({
      scope: 'shared',
      ownerPackId: 'commerce-ops',
      ownerPackName: 'Commerce Ops',
      taskCount: 3,
      activeTaskCount: 1,
      selectedTaskCount: 2,
      lastObservedAt: '2026-04-13T10:25:00.000Z',
    });
    expect(prReview?.packIds).toEqual(['base-engineering', 'commerce-ops']);
    expect(prReview?.versions).toEqual(['1.1.0', '0.2.0']);
    expect(prReview?.requiredTools).toEqual(['github', 'jira']);
    expect(prReview?.requiredKnowledge.map((entry) => entry.id)).toEqual([
      'repo-index',
      'engineering-policies',
      'operations-runbook',
    ]);
    expect(prReview?.bindings).toEqual([
      { workflow: 'feature-delivery', phase: 'review', packId: 'base-engineering' },
      { workflow: 'feature-delivery', phase: 'review', packId: 'commerce-ops' },
    ]);

    expect(apiCompat).toMatchObject({
      scope: 'environment',
      ownerPackId: 'commerce-ops',
      ownerPackName: 'Commerce Ops',
      taskCount: 2,
      activeTaskCount: 2,
      selectedTaskCount: 2,
      lastObservedAt: '2026-04-13T10:25:00.000Z',
    });
    expect(apiCompat?.bindings).toEqual([
      { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
      { workflow: 'hotfix', phase: 'verify', packId: 'commerce-ops' },
    ]);
  });

  it('renders manifest snippets, harness data, impact summaries, and command text', () => {
    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );
    const apiCompat = records.find((record) => record.id === 'api-compat-check');

    expect(apiCompat).toBeTruthy();
    expect(buildSkillManifestSnippet(apiCompat!)).toContain('entrypoint: skill://commerce-ops/api-compat-check');
    expect(buildSkillManifestSnippet(apiCompat!)).toContain('feature-delivery/verify @ commerce-ops');
    expect(buildSkillDependenciesSnippet(apiCompat!)).toContain('operations-runbook (runbook)');
    expect(buildSkillBindingsSnippet(apiCompat!)).toContain('allowed_agents: [reviewer, evaluator]');
    expect(buildSkillTestHarnessSnippet(apiCompat!)).toContain('sample_task: task-shared');
    expect(buildSkillImpactItems(apiCompat!)).toEqual([
      {
        title: 'Workflow impact',
        detail: '2 bindings currently route work through this skill',
      },
      {
        title: 'Pack impact',
        detail: '1 pack depend on this manifest',
      },
      {
        title: 'Task impact',
        detail: '2 tasks selected this skill in recent runs',
      },
    ]);
    expect(buildSkillChecklist(apiCompat!)).toEqual([
      { label: 'Manifest has an owner pack', tone: 'green' },
      { label: 'Bindings discovered', tone: 'green' },
      { label: 'Observed in live task setup', tone: 'green' },
      { label: 'Promotion review needed', tone: 'yellow' },
    ]);
    expect(buildSkillVersionEntries(apiCompat!)).toEqual([
      {
        id: 'observed-1.1.0-0',
        version: '1.1.0',
        detail: 'Current manifest observed in 1 pack',
      },
    ]);
    expect(buildSkillCommandSnippet(apiCompat!))
      .toContain('@skill/api-compat-check #show-impact review 2 bindings, 2 tools, and 2 selected tasks');
  });

  it('humanizes skill ids for sidebar labels', () => {
    expect(labelizeSkillId('api-compat-check')).toBe('Api Compat Check');
  });

  it('derives persistence state from saved draft and published registry entries', () => {
    const baseRecords = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );
    const baseApiCompat = baseRecords.find((record) => record.id === 'api-compat-check');
    expect(baseApiCompat).toBeTruthy();

    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
      [
        {
          skillId: 'api-compat-check',
          ownerPackId: 'commerce-ops',
          scope: 'environment',
          draft: {
            notes: 'Review portability before publish.',
            savedAt: '2026-04-13T11:00:00.000Z',
            snapshot: buildSkillManifestMutationInput(baseApiCompat!, 'Review portability before publish.').snapshot,
          },
          published: null,
          revisions: [
            {
              id: 'draft_saved:2026-04-13T11:00:00.000Z',
              kind: 'draft_saved',
              createdAt: '2026-04-13T11:00:00.000Z',
              notes: 'Review portability before publish.',
              snapshot: buildSkillManifestMutationInput(baseApiCompat!, 'Review portability before publish.').snapshot,
            },
          ],
        },
      ],
    );

    const apiCompat = records.find((record) => record.id === 'api-compat-check');
    expect(apiCompat).toBeTruthy();
    expect(resolveSkillManifestPersistenceStatus(apiCompat!, 'Review portability before publish.')).toBe('draft-saved');
    expect(resolveSkillManifestPersistenceStatus(apiCompat!, 'Changed notes')).toBe('changes-unsaved');
  });

  it('allows an initial publish when only a saved draft exists', () => {
    const baseRecords = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );
    const currentApiCompat = baseRecords.find((record) => record.id === 'api-compat-check');
    expect(currentApiCompat).toBeTruthy();

    const draftSnapshot = buildSkillManifestMutationInput(
      currentApiCompat!,
      'Review portability before publish.',
    ).snapshot;

    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
      [
        {
          skillId: 'api-compat-check',
          ownerPackId: 'commerce-ops',
          scope: 'environment',
          draft: {
            notes: 'Review portability before publish.',
            savedAt: '2026-04-13T11:00:00.000Z',
            snapshot: draftSnapshot,
          },
          published: null,
          revisions: [
            {
              id: 'draft_saved:2026-04-13T11:00:00.000Z',
              kind: 'draft_saved',
              createdAt: '2026-04-13T11:00:00.000Z',
              notes: 'Review portability before publish.',
              snapshot: draftSnapshot,
            },
          ],
        },
      ],
    );

    const apiCompat = records.find((record) => record.id === 'api-compat-check');
    expect(apiCompat).toBeTruthy();
    expect(buildSkillPublishRecommendation(apiCompat!, 'Review portability before publish.')).toMatchObject({
      currentVersion: '1.1.0',
      nextVersion: '1.1.0',
      strategy: 'initial',
      canPublish: true,
    });
  });

  it('builds version entries and change items from published history', () => {
    const baseRecords = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );
    const currentApiCompat = baseRecords.find((record) => record.id === 'api-compat-check');
    expect(currentApiCompat).toBeTruthy();

    const publishedSnapshot = {
      ...buildSkillManifestMutationInput(currentApiCompat!, 'Published baseline notes').snapshot,
      requiredTools: ['github'],
      bindings: [
        { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
      ],
    };

    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
      [
        {
          skillId: 'api-compat-check',
          ownerPackId: 'commerce-ops',
          scope: 'environment',
          draft: {
            notes: 'Published baseline notes',
            savedAt: '2026-04-13T11:00:00.000Z',
            snapshot: publishedSnapshot,
          },
          published: {
            notes: 'Published baseline notes',
            publishedAt: '2026-04-13T11:05:00.000Z',
            snapshot: publishedSnapshot,
          },
          revisions: [
            {
              id: 'draft_saved:2026-04-13T11:00:00.000Z',
              kind: 'draft_saved',
              createdAt: '2026-04-13T11:00:00.000Z',
              notes: 'Published baseline notes',
              snapshot: publishedSnapshot,
            },
            {
              id: 'published:2026-04-13T11:05:00.000Z',
              kind: 'published',
              createdAt: '2026-04-13T11:05:00.000Z',
              notes: 'Published baseline notes',
              snapshot: publishedSnapshot,
            },
          ],
        },
      ],
    );

    const apiCompat = records.find((record) => record.id === 'api-compat-check');
    expect(apiCompat).toBeTruthy();
    expect(buildSkillVersionEntries(apiCompat!).slice(0, 2)).toEqual([
      {
        id: 'published:2026-04-13T11:05:00.000Z',
        version: '1.1.0',
        detail: 'Published · 2026-04-13T11:05:00.000Z',
      },
      {
        id: 'draft_saved:2026-04-13T11:00:00.000Z',
        version: '1.1.0',
        detail: 'Draft saved · 2026-04-13T11:00:00.000Z',
      },
    ]);
    expect(buildSkillChangeItems(apiCompat!, 'Updated notes for publish')).toEqual([
      {
        id: 'requiredTools',
        title: 'Tool changes',
        detail: 'added jira',
        tone: 'blue',
      },
      {
        id: 'bindings',
        title: 'Binding changes',
        detail: 'added hotfix/verify@commerce-ops',
        tone: 'blue',
      },
      {
        id: 'notes',
        title: 'Manifest notes updated',
        detail: 'Review notes changed relative to the published manifest.',
        tone: 'blue',
      },
    ]);
    expect(buildSkillPublishRecommendation(apiCompat!, 'Updated notes for publish')).toMatchObject({
      currentVersion: '1.1.0',
      nextVersion: '1.2.0',
      strategy: 'minor',
      canPublish: true,
    });
    expect(buildSkillPublishMutationInput(apiCompat!, 'Updated notes for publish').snapshot.version).toBe('1.2.0');
  });

  it('uses none and patch bumps when published baseline only changes through notes', () => {
    const baseRecords = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
    );
    const currentPrReview = baseRecords.find((record) => record.id === 'pr-review');
    expect(currentPrReview).toBeTruthy();

    const publishedSnapshot = buildSkillManifestMutationInput(
      currentPrReview!,
      'Stable baseline notes',
    ).snapshot;

    const records = buildSkillManifestRecords(
      [BASE_PACK, OPS_PACK],
      TASKS,
      'commerce-ops',
      [
        {
          skillId: 'pr-review',
          ownerPackId: 'commerce-ops',
          scope: 'shared',
          draft: {
            notes: 'Stable baseline notes',
            savedAt: '2026-04-13T11:00:00.000Z',
            snapshot: publishedSnapshot,
          },
          published: {
            notes: 'Stable baseline notes',
            publishedAt: '2026-04-13T11:05:00.000Z',
            snapshot: publishedSnapshot,
          },
          revisions: [
            {
              id: 'draft_saved:2026-04-13T11:00:00.000Z',
              kind: 'draft_saved',
              createdAt: '2026-04-13T11:00:00.000Z',
              notes: 'Stable baseline notes',
              snapshot: publishedSnapshot,
            },
            {
              id: 'published:2026-04-13T11:05:00.000Z',
              kind: 'published',
              createdAt: '2026-04-13T11:05:00.000Z',
              notes: 'Stable baseline notes',
              snapshot: publishedSnapshot,
            },
          ],
        },
      ],
    );

    const prReview = records.find((record) => record.id === 'pr-review');
    expect(prReview).toBeTruthy();
    expect(buildSkillPublishRecommendation(prReview!, 'Stable baseline notes')).toMatchObject({
      currentVersion: '1.1.0',
      nextVersion: '1.1.0',
      strategy: 'none',
      canPublish: false,
    });
    expect(buildSkillPublishRecommendation(prReview!, 'Stable baseline notes updated')).toMatchObject({
      currentVersion: '1.1.0',
      nextVersion: '1.1.1',
      strategy: 'patch',
      canPublish: true,
    });
    expect(buildSkillPublishMutationInput(prReview!, 'Stable baseline notes updated').snapshot.version).toBe('1.1.1');
  });
});
