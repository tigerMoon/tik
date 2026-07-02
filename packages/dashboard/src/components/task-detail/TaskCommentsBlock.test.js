import { describe, expect, it } from 'vitest';
import { buildCommentProcessingStates } from './TaskCommentsBlock';
describe('TaskCommentsBlock comment processing state', () => {
    it('shows a completed-task follow-up comment as queued until execution evidence appears', () => {
        const states = buildCommentProcessingStates([
            {
                id: 'comment-1',
                authorKind: 'human',
                body: '创建mr 并合并到 master',
                createdAt: '2026-06-18T07:01:51.367Z',
            },
        ], [
            {
                id: 'timeline-1',
                kind: 'summary',
                actor: 'user',
                body: 'Comment added:\n创建mr 并合并到 master',
                createdAt: '2026-06-18T07:01:51.367Z',
            },
            {
                id: 'timeline-2',
                kind: 'summary',
                actor: 'user',
                body: 'Task state changed: completed -> todo.\nReason: Human comment requested a follow-up run.',
                createdAt: '2026-06-18T07:01:52.000Z',
            },
        ]);
        expect(states['comment-1']).toMatchObject({
            label: 'Queued',
            tone: 'yellow',
        });
    });
    it('does not mark a merge request comment processed when later execution lacks merge evidence', () => {
        const states = buildCommentProcessingStates([
            {
                id: 'comment-merge',
                authorKind: 'human',
                body: '创建mr 并合并到 master',
                createdAt: '2026-06-18T07:01:51.367Z',
            },
        ], [
            {
                id: 'timeline-comment',
                kind: 'summary',
                actor: 'user',
                body: 'Comment added:\n创建mr 并合并到 master',
                createdAt: '2026-06-18T07:01:51.367Z',
            },
            {
                id: 'timeline-dispatch',
                kind: 'summary',
                actor: 'supervisor',
                body: 'Task entered the supervisor queue.',
                createdAt: '2026-06-18T07:02:00.000Z',
            },
            {
                id: 'timeline-run',
                kind: 'raw',
                actor: 'system',
                body: 'Tool: read_file\n\nOutput:\npackage.json',
                createdAt: '2026-06-18T07:03:00.000Z',
            },
        ]);
        expect(states['comment-merge']).toMatchObject({
            label: 'Needs merge evidence',
            tone: 'yellow',
        });
    });
});
//# sourceMappingURL=TaskCommentsBlock.test.js.map