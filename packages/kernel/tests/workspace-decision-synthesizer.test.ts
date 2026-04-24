import { describe, expect, it } from 'vitest';
import { synthesizeWorkspaceDecision } from '../src/workspace-decision-synthesizer.js';

describe('synthesizeWorkspaceDecision', () => {
  it('builds high-confidence artifact choices from ambiguous feature artifact blockers', () => {
    const decision = synthesizeWorkspaceDecision({
      projectName: 'service-a',
      phase: 'PARALLEL_SPECIFY',
      blockerKind: 'NEED_HUMAN',
      summary: 'Multiple feature specs found; unable to choose automatically: /tmp/specs/feature-a/spec.md, /tmp/specs/feature-b/spec.md',
    }, '2026-04-07T00:00:00.000Z');

    expect(decision.kind).toBe('approach_choice');
    expect(decision.confidence).toBe('high');
    expect(decision.options).toHaveLength(2);
    expect(decision.options?.[0]).toMatchObject({
      artifactField: 'specPath',
      recommended: true,
    });
    expect(decision.signals).toContain('artifact-options:2');
  });

  it('builds reroute decisions for replan blockers with explicit options', () => {
    const decision = synthesizeWorkspaceDecision({
      projectName: 'service-a',
      phase: 'PARALLEL_PLAN',
      blockerKind: 'REPLAN',
      summary: 'Generated plan still looks like a template skeleton.',
    }, '2026-04-07T00:00:00.000Z');

    expect(decision.kind).toBe('phase_reroute');
    expect(decision.confidence).toBe('medium');
    expect(decision.options?.map((option) => option.id)).toEqual([
      'rerun-current-phase',
      'go-back-to-specify',
    ]);
    expect(decision.rationale).toContain('replan condition');
  });

  it('builds clarification decisions with explanation signals when only freeform clarification is safe', () => {
    const decision = synthesizeWorkspaceDecision({
      projectName: 'service-a',
      phase: 'PARALLEL_ACE',
      blockerKind: 'NEED_HUMAN',
      summary: '需求范围不明确，缺少缓存一致性约束，需要 clarify 后继续。',
    }, '2026-04-07T00:00:00.000Z');

    expect(decision.kind).toBe('clarification');
    expect(decision.allowFreeform).toBe(true);
    expect(decision.title).toContain('Clarify');
    expect(decision.signals).toEqual(expect.arrayContaining([
      'needs-clarification',
      'unclear-scope',
    ]));
  });
});
