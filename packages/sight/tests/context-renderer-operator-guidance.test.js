import { describe, expect, it } from 'vitest';
import { ContextRenderer } from '../src/renderer/context-renderer.js';
function envelopeWithOperatorComments(comments) {
    return {
        bootstrap: {
            cwd: '/repo',
            timestamp: '2026-06-17T00:00:00.000Z',
            os: 'darwin',
            git: { branch: 'main', commit: 'abc1234', dirty: false },
            env: {},
        },
        execution: {
            environment: undefined,
        },
        conversation: {
            recentMessages: [],
            compactSummary: undefined,
            sessionMemory: undefined,
            operatorComments: comments,
        },
        meta: {
            taskId: 'task-x',
            sessionId: 'session-x',
            iteration: 1,
            agent: 'supervisor',
            strategy: 'incremental',
        },
    };
}
describe('ContextRenderer operator guidance', () => {
    const renderer = new ContextRenderer();
    it('renders an Operator Guidance section with each comment when comments are present', () => {
        const envelope = envelopeWithOperatorComments([
            {
                authorId: 'huyuehui',
                body: 'Prioritize the failing acceptance test before docs.',
                createdAt: '2026-06-17T03:14:00.000Z',
            },
            {
                authorId: 'reviewer',
                body: 'Push for a previewable artifact.',
                createdAt: '2026-06-17T03:15:30.000Z',
            },
        ]);
        const rendered = renderer.render(envelope);
        expect(rendered).toContain('# Operator Guidance');
        expect(rendered).toContain('Treat these as authoritative direction');
        expect(rendered).toContain('## huyuehui (2026-06-17 03:14 UTC)');
        expect(rendered).toContain('Prioritize the failing acceptance test before docs.');
        expect(rendered).toContain('## reviewer (2026-06-17 03:15 UTC)');
        expect(rendered).toContain('Push for a previewable artifact.');
    });
    it('omits the Operator Guidance section entirely when there are no comments', () => {
        const renderedEmpty = renderer.render(envelopeWithOperatorComments(undefined));
        const renderedZeroLength = renderer.render(envelopeWithOperatorComments([]));
        expect(renderedEmpty).not.toContain('# Operator Guidance');
        expect(renderedZeroLength).not.toContain('# Operator Guidance');
    });
    it('falls back to "human" when authorId is missing', () => {
        const rendered = renderer.render(envelopeWithOperatorComments([
            {
                authorId: undefined,
                body: 'do not deploy',
                createdAt: '2026-06-17T08:00:00.000Z',
            },
        ]));
        expect(rendered).toContain('## human (2026-06-17 08:00 UTC)');
        expect(rendered).toContain('do not deploy');
    });
});
//# sourceMappingURL=context-renderer-operator-guidance.test.js.map