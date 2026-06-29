import type { WorkbenchArtifactRecord } from '@tik/shared';
import { describe, expect, it } from 'vitest';
import {
  classifyArtifactPreviewMode,
  parseArtifactDiff,
  parseArtifactDiffStat,
  parseArtifactLogSections,
} from './artifact-preview.js';

describe('artifact preview view models', () => {
  it('classifies preview modes from content type and run proof metadata', () => {
    expect(classifyArtifactPreviewMode(makeArtifact({
      kind: 'diff',
      contentType: 'text/x-diff',
      producedBy: { template: 'run-diff' },
    }))).toBe('diff');
    expect(classifyArtifactPreviewMode(makeArtifact({
      kind: 'diff',
      contentType: 'text/plain',
      producedBy: { template: 'run-diff-stat' },
      tags: ['run-diff-stat'],
    }))).toBe('diff-stat');
    expect(classifyArtifactPreviewMode(makeArtifact({
      kind: 'run_review',
      contentType: 'text/markdown',
      producedBy: { template: 'run-review' },
    }))).toBe('document');
    expect(classifyArtifactPreviewMode(makeArtifact({
      kind: 'transcript',
      contentType: 'text/plain',
      producedBy: { template: 'run-transcript' },
    }))).toBe('log');
  });

  it('parses unified diffs into files and line roles', () => {
    const parsed = parseArtifactDiff([
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      ' context',
    ].join('\n'));

    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe('src/app.ts');
    expect(parsed.files[0]?.lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'remove',
      'add',
      'context',
    ]);
  });

  it('parses diff stat rows and totals for compact display', () => {
    const parsed = parseArtifactDiffStat([
      ' src/app.ts      | 4 +++-',
      ' src/removed.ts  | 2 --',
      ' 2 files changed, 3 insertions(+), 3 deletions(-)',
    ].join('\n'));

    expect(parsed.rows).toEqual([
      { filePath: 'src/app.ts', changes: 4, additions: 3, deletions: 1 },
      { filePath: 'src/removed.ts', changes: 2, additions: 0, deletions: 2 },
    ]);
    expect(parsed.summary).toBe('2 files changed, 3 insertions(+), 3 deletions(-)');
  });

  it('splits run transcripts into named log sections', () => {
    const sections = parseArtifactLogSections([
      '## stdout.log',
      '',
      'implemented',
      'tests passed',
      '',
      '## stderr.log',
      '',
      'warning: slow test',
    ].join('\n'));

    expect(sections).toEqual([
      {
        title: 'stdout.log',
        lines: [
          { number: 1, text: 'implemented' },
          { number: 2, text: 'tests passed' },
        ],
      },
      {
        title: 'stderr.log',
        lines: [
          { number: 1, text: 'warning: slow test' },
        ],
      },
    ]);
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
