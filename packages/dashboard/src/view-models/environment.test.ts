import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentPackManifest } from '@tik/shared';
import {
  buildEnvironmentActivationSummary,
  buildEnvironmentCommandSnippet,
  buildEnvironmentPromotionQueue,
  buildEnvironmentWorkflowCoverage,
  countEnvironmentPromotionItems,
  getEnvironmentPackStatusBadge,
} from './environment.js';
import type { WorkbenchTaskResponse } from '../api/client';

const PACK: EnvironmentPackManifest = {
  kind: 'EnvironmentPack',
  id: 'commerce-ops',
  name: 'Commerce Ops',
  version: '0.1.0',
  description: 'Commerce-focused environment',
  tools: ['github', 'jira'],
  skills: ['pr-review', 'incident-rca'],
  knowledge: [
    { id: 'repo-index', kind: 'repo-index', label: 'Repo Index' },
  ],
  policies: ['prod-change-requires-approval', 'pii-redaction'],
  workflowBindings: [
    {
      workflow: 'feature-delivery',
      phases: {
        plan: ['solution-proposal'],
        review: ['pr-review'],
        verify: ['github', 'risk-evaluator'],
      },
    },
  ],
  evaluators: ['risk-evaluator'],
};

describe('environment view models', () => {
  it('marks the active pack and non-active packs correctly', () => {
    expect(getEnvironmentPackStatusBadge(PACK, 'commerce-ops')).toEqual({
      label: 'Active',
      tone: 'active',
    });

    expect(getEnvironmentPackStatusBadge(PACK, 'design-to-code')).toEqual({
      label: 'Ready',
      tone: 'ready',
    });
  });

  it('builds promotion queue items only for missing capabilities', () => {
    expect(buildEnvironmentPromotionQueue(PACK)).toEqual([
      {
        id: 'missing-capability:feature-delivery:plan:solution-proposal',
        kind: 'capability proposal',
        detail: 'Promote "solution-proposal" into feature-delivery / plan so this pack can satisfy its declared workflow binding.',
      },
    ]);

    expect(countEnvironmentPromotionItems([PACK])).toBe(1);
  });

  it('reports workflow coverage across skills, tools, and evaluators', () => {
    expect(buildEnvironmentWorkflowCoverage(PACK)).toEqual([
      {
        workflow: 'feature-delivery',
        coveredPhaseCount: 2,
        totalPhaseCount: 3,
        missingCapabilities: ['solution-proposal'],
        phases: [
          {
            phase: 'plan',
            covered: false,
            missingCapabilities: ['solution-proposal'],
            requirements: [
              {
                capability: 'solution-proposal',
                source: 'missing',
              },
            ],
          },
          {
            phase: 'review',
            covered: true,
            missingCapabilities: [],
            requirements: [
              {
                capability: 'pr-review',
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
                capability: 'github',
                source: 'tool',
              },
              {
                capability: 'risk-evaluator',
                source: 'evaluator',
              },
            ],
          },
        ],
      },
    ]);
  });

  it('builds activation summaries from bound task state', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T10:05:00.000Z'));

    const tasks: WorkbenchTaskResponse[] = [
      {
        id: 'task-1',
        title: 'one',
        goal: 'one',
        status: 'running',
        createdAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:00.000Z',
        environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '0.1.0' },
      },
      {
        id: 'task-2',
        title: 'two',
        goal: 'two',
        status: 'waiting_for_user',
        createdAt: '2026-04-13T10:01:00.000Z',
        updatedAt: '2026-04-13T10:01:00.000Z',
        environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '0.1.0' },
      },
      {
        id: 'task-3',
        title: 'three',
        goal: 'three',
        status: 'completed',
        createdAt: '2026-04-13T10:02:00.000Z',
        updatedAt: '2026-04-13T10:02:00.000Z',
        environmentPackSnapshot: { id: 'base-engineering', name: 'Base Engineering', version: '0.1.0' },
      },
    ];

    expect(buildEnvironmentActivationSummary(
      PACK,
      tasks,
      'commerce-ops',
      '2026-04-13T10:03:00.000Z',
    )).toEqual({
      statusLabel: 'Mounted and healthy',
      boundTaskCount: 2,
      activeTaskCount: 2,
      waitingTaskCount: 1,
      lastSyncLabel: '2 min ago',
      mountedNamespaces: ['env/commerce-ops/*'],
    });

    vi.useRealTimers();
  });

  it('builds a command snippet for the selected environment', () => {
    expect(buildEnvironmentCommandSnippet(PACK, 2))
      .toContain('@env/commerce-ops #open-manifest');
  });
});
