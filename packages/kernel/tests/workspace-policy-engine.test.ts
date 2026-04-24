import { describe, expect, it } from 'vitest';
import { WorkspacePolicyEngine } from '../src/workspace-policy-engine.js';

describe('WorkspacePolicyEngine', () => {
  it('allows native rescue for missing specify/plan artifacts but not ace', () => {
    const policy = new WorkspacePolicyEngine();

    expect(policy.shouldRunNativeArtifactRescue({
      phase: 'PARALLEL_SPECIFY',
      artifactState: 'missing',
      timedOut: false,
      delegatedStatus: 'completed',
    })).toBe(true);

    expect(policy.shouldRunNativeArtifactRescue({
      phase: 'PARALLEL_ACE',
      artifactState: 'missing',
      timedOut: true,
      delegatedStatus: 'failed',
    })).toBe(false);
  });

  it('formats native and reused artifact labels consistently', () => {
    const policy = new WorkspacePolicyEngine();

    expect(policy.formatArtifactModeLabel({ reused: true })).toBe('reused');
    expect(policy.formatArtifactModeLabel({ reused: false, executionMode: 'native' })).toBe('mode=native');
  });

  it('exposes configurable phase budgets and feedback escalation limits', () => {
    const policy = new WorkspacePolicyEngine({
      profile: 'fast-feedback',
      phaseBudgetsMs: {
        PARALLEL_PLAN: 123_000,
      },
      maxFeedbackRetriesPerPhase: {
        PARALLEL_ACE: 4,
      },
      enableNativeArtifactRescue: false,
    });

    expect(policy.getConfig().profile).toBe('fast-feedback');
    expect(policy.getPhaseBudgetMs('PARALLEL_PLAN')).toBe(123_000);
    expect(policy.getPhaseBudgetMs('PARALLEL_SPECIFY')).toBe(180_000);
    expect(policy.shouldRunNativeArtifactRescue({
      phase: 'PARALLEL_PLAN',
      artifactState: 'missing',
      timedOut: false,
      delegatedStatus: 'failed',
    })).toBe(false);
    expect(policy.shouldEscalateFeedback({ phase: 'PARALLEL_ACE', retryCount: 3 })).toBe(true);
    expect(policy.shouldEscalateFeedback({ phase: 'PARALLEL_ACE', retryCount: 4 })).toBe(false);
  });
});
