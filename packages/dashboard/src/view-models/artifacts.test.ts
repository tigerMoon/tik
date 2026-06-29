import type { WorkbenchArtifactRecord } from '@tik/shared';
import { describe, expect, it } from 'vitest';
import type { WorkbenchTaskResponse } from '../api/client.js';
import {
  buildArtifactGalleryViewModel,
  buildTaskArtifactRailModel,
  countWorkbenchArtifactGroupsByStatus,
  groupWorkbenchArtifactsForReview,
} from './artifacts.js';

describe('artifact gallery view models', () => {
  it('folds duplicate run proof artifacts into one latest logical row', () => {
    const grouped = groupWorkbenchArtifactsForReview([
      makeArtifact({
        id: 'art-old-diff',
        title: 'Run Diff: TIK-104 attempt 1',
        kind: 'diff',
        contentType: 'text/x-diff',
        updatedAt: '2026-06-29T07:30:53.000Z',
        producedBy: { template: 'run-diff' },
      }),
      makeArtifact({
        id: 'art-new-diff',
        title: 'Run Diff: TIK-104 attempt 1',
        kind: 'diff',
        contentType: 'text/x-diff',
        updatedAt: '2026-06-29T07:31:17.000Z',
        producedBy: { template: 'run-diff' },
      }),
      makeArtifact({
        id: 'art-old-review',
        title: 'Run Review: TIK-104 attempt 1',
        kind: 'run_review',
        contentType: 'text/markdown',
        updatedAt: '2026-06-29T07:30:53.000Z',
        producedBy: { template: 'run-review' },
      }),
      makeArtifact({
        id: 'art-new-review',
        title: 'Run Review: TIK-104 attempt 1',
        kind: 'run_review',
        contentType: 'text/markdown',
        updatedAt: '2026-06-29T07:31:17.000Z',
        producedBy: { template: 'run-review' },
      }),
    ]);

    expect(grouped.map((artifact) => artifact.id)).toEqual(['art-new-diff', 'art-new-review']);
    expect(grouped[0]).toMatchObject({
      groupedArtifactCount: 2,
      groupedVersionCount: 2,
      groupedArtifactIds: ['art-new-diff', 'art-old-diff'],
    });
    expect(countWorkbenchArtifactGroupsByStatus(grouped)).toMatchObject({
      all: 2,
      needs_review: 2,
      accepted: 0,
      rejected: 0,
    });
  });

  it('keeps artifacts separate across tasks and producer templates', () => {
    const grouped = groupWorkbenchArtifactsForReview([
      makeArtifact({
        id: 'task-a-review',
        taskId: 'task-a',
        title: 'Run Review: TIK-1 attempt 1',
        kind: 'run_review',
        producedBy: { template: 'run-review' },
      }),
      makeArtifact({
        id: 'task-b-review',
        taskId: 'task-b',
        title: 'Run Review: TIK-1 attempt 1',
        kind: 'run_review',
        producedBy: { template: 'run-review' },
      }),
      makeArtifact({
        id: 'task-a-task-review',
        taskId: 'task-a',
        title: 'Run Review: TIK-1 attempt 1',
        kind: 'run_review',
        producedBy: { template: 'task-review' },
      }),
    ]);

    expect(grouped.map((artifact) => artifact.id).sort()).toEqual([
      'task-a-review',
      'task-a-task-review',
      'task-b-review',
    ]);
    expect(grouped.every((artifact) => artifact.groupedArtifactCount === 1)).toBe(true);
  });

  it('excludes artifacts for inactive tasks from actionable review groups', () => {
    const grouped = groupWorkbenchArtifactsForReview([
      makeArtifact({
        id: 'active-review',
        taskId: 'task-active',
        title: 'Run Review: TIK-1 attempt 1',
        kind: 'run_review',
      }),
      makeArtifact({
        id: 'cancelled-review',
        taskId: 'task-cancelled',
        title: 'Run Review: TIK-104 attempt 1',
        kind: 'run_review',
      }),
    ], {
      inactiveTaskIds: ['task-cancelled'],
    });

    expect(grouped.map((artifact) => artifact.id)).toEqual(['active-review']);
    expect(countWorkbenchArtifactGroupsByStatus(grouped)).toMatchObject({
      all: 1,
      needs_review: 1,
    });
  });

  it('builds gallery rows and counts without artifacts from inactive tasks', () => {
    const viewModel = buildArtifactGalleryViewModel({
      artifacts: [
        makeArtifact({
          id: 'active-review',
          taskId: 'task-active',
          title: 'Run Review: TIK-105 attempt 1',
        }),
        makeArtifact({
          id: 'cancelled-review',
          taskId: 'task-cancelled',
          title: 'Run Review: TIK-105 attempt 1',
        }),
        makeArtifact({
          id: 'archived-review',
          taskId: 'task-archived',
          title: 'Run Review: TIK-105 attempt 1',
        }),
      ],
      tasks: [
        makeTask({ id: 'task-active', status: 'running' }),
        makeTask({ id: 'task-cancelled', status: 'cancelled' }),
        makeTask({ id: 'task-archived', status: 'archived' }),
      ],
      filter: 'all',
    });

    expect(viewModel.rows.map((artifact) => artifact.id)).toEqual(['active-review']);
    expect(viewModel.counts).toMatchObject({
      all: 1,
      needs_review: 1,
      accepted: 0,
      rejected: 0,
    });
  });

  it('builds a compact task artifact rail model around count and latest artifact entrypoint', () => {
    const model = buildTaskArtifactRailModel([
      makeArtifact({
        id: 'art-review',
        title: 'Run Review: TIK-105 attempt 1',
        kind: 'run_review',
        status: 'needs_review',
        updatedAt: '2026-06-29T08:35:51.120Z',
      }),
      makeArtifact({
        id: 'art-diff',
        title: 'Run Diff: TIK-105 attempt 1',
        kind: 'diff',
        status: 'needs_review',
        updatedAt: '2026-06-29T08:35:51.117Z',
      }),
      makeArtifact({
        id: 'art-transcript',
        title: 'Run Transcript: TIK-105 attempt 1',
        kind: 'transcript',
        status: 'accepted',
        updatedAt: '2026-06-29T08:35:50.000Z',
      }),
    ]);

    expect(model).toEqual({
      totalCount: 3,
      needsReviewCount: 2,
      acceptedCount: 1,
      rejectedCount: 0,
      latestArtifactId: 'art-review',
      latestTitle: 'Run Review: TIK-105 attempt 1',
      latestMeta: 'run_review · v1 · needs review',
      primaryActionLabel: 'Open 3 artifacts',
      statusSummary: '2 need review · 1 accepted',
    });
  });
});

function makeArtifact(overrides: Partial<WorkbenchArtifactRecord>): WorkbenchArtifactRecord {
  return {
    id: 'art-default',
    taskId: 'task-104',
    title: 'Artifact',
    kind: 'text',
    status: 'needs_review',
    visibility: 'local',
    latestVersionId: 'ver-default',
    version: 1,
    safeRelativePath: '.tik/workbench/artifacts/art-default/versions/v1.txt',
    contentType: 'text/plain',
    sizeBytes: 10,
    contentHash: 'sha256:default',
    sourceEventIds: [],
    sourceEvidenceIds: [],
    producedBy: {},
    createdAt: '2026-06-29T07:30:00.000Z',
    updatedAt: '2026-06-29T07:30:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkbenchTaskResponse>): WorkbenchTaskResponse {
  return {
    id: 'task-default',
    identifier: 'TIK-1',
    shortIdentifier: 'TIK-1',
    title: 'Task',
    description: '',
    goal: '',
    status: 'running',
    priority: null,
    labels: [],
    createdAt: '2026-06-29T07:30:00.000Z',
    updatedAt: '2026-06-29T07:30:00.000Z',
    ...overrides,
  };
}
