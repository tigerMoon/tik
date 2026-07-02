import { describe, expect, it } from 'vitest';
import { buildArtifactPreviewApiUrl, formatArtifactList, formatArtifactShow, } from '../src/artifacts-command.js';
describe('artifacts command helpers', () => {
    it('formats artifact lists with review metadata', () => {
        expect(formatArtifactList([
            {
                id: 'art_abc123',
                status: 'needs_review',
                version: 3,
                kind: 'report',
                taskId: 'TIK-42',
                title: 'Task Review: Add cache',
                updatedAt: '2026-06-23T00:00:00.000Z',
            },
            {
                id: 'art_def456',
                status: 'accepted',
                version: 1,
                kind: 'timeline',
                taskId: 'TIK-45',
                title: 'Investigation: flaky test',
                updatedAt: '2026-06-23T00:05:00.000Z',
            },
        ])).toContain('art_abc123  needs_review  3    report    TIK-42');
    });
    it('formats artifact details with preview URL', () => {
        const output = formatArtifactShow({
            id: 'art_abc123',
            title: 'Task Review: Add cache',
            status: 'needs_review',
            version: 3,
            kind: 'report',
            taskId: 'TIK-42',
            changedFiles: ['src/cache.ts', 'src/cache.test.ts'],
            validationRefs: ['pnpm test'],
            risks: ['Cache invalidation'],
            latestVersionId: 'ver_123',
        }, 'http://localhost:3000');
        expect(output).toContain('Title: Task Review: Add cache');
        expect(output).toContain('Changed files: 2');
        expect(output).toContain('Preview: http://localhost:3000/api/workbench/artifacts/art_abc123/versions/ver_123/preview');
    });
    it('builds artifact-id preview URLs instead of path preview URLs', () => {
        expect(buildArtifactPreviewApiUrl('http://localhost:3000/', 'art_abc123', 'ver_123')).toBe('http://localhost:3000/api/workbench/artifacts/art_abc123/versions/ver_123/preview');
    });
});
//# sourceMappingURL=artifacts-command.test.js.map