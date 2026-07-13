import { describe, expect, it } from 'vitest';
import {
  assertContextBudget,
  buildNativeAgentContextBundle,
  renderNativeContextPrompt,
} from '../src/multi-agent/native-context-bundle.js';

describe('native agent context bundles', () => {
  it('builds a deterministic bounded role context without workflow history', () => {
    const workflowBundle = {
      workflow: {
        id: 'wf-context',
        goal: 'Evaluate the committed change.',
        currentHeadSha: 'head-1',
      },
      contracts: [{
        id: 'contract-st-api-v1',
        subtaskId: 'st-api',
        version: 1,
        status: 'accepted',
        goal: 'Keep retries stage-local.',
        scope: { allowedPaths: ['packages/kernel/**'], blockedPaths: [] },
        acceptanceCriteria: [{ id: 'ac-1', statement: 'Command failures resume commands only.', priority: 'must' }],
      }],
      evidence: [{
        id: 'ev-implementation',
        subtaskId: 'st-api',
        kind: 'implementation',
        title: 'Implementation',
        summary: 'Added checkpoints.',
        headSha: 'head-1',
        createdAt: '2026-07-13T00:00:00.000Z',
        payload: { observedChangedFiles: [{ path: 'packages/kernel/src/checkpoint.ts' }] },
      }],
      evaluationRuns: [],
      invocations: [{ result: { content: 'must not be copied into context' } }],
      decisions: [{ reason: 'must not be copied into context' }],
      events: [{ payload: { history: 'must not be copied into context' } }],
    } as any;
    const invocation = {
      role: 'evaluator' as const,
      runner: 'codex-evaluator' as const,
      subtaskId: 'st-api',
      promptContract: 'codex-evaluator.v1',
      headSha: 'head-1',
      allowedPaths: ['packages/kernel/**'],
      validationCommands: ['pnpm --filter @tik/kernel test'],
      input: {
        targetModule: 'kernel',
        workflowHistory: 'must not be copied into context',
        transcript: ['must not be copied into context'],
      },
    };

    const first = buildNativeAgentContextBundle(workflowBundle, invocation);
    const second = buildNativeAgentContextBundle(workflowBundle, invocation);
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first.contextHash).toMatch(/^sha256:/);
    expect(first.budget).toMatchObject({ maxTokens: 24_000, truncated: false });
    expect(first.budget.estimatedTokens).toBeLessThan(2_000);
    expect(first.implementation?.changedFiles).toEqual(['packages/kernel/src/checkpoint.ts']);
    expect(first.taskInput).toEqual({ targetModule: 'kernel' });
    expect(serialized).not.toContain('must not be copied into context');
  });

  it('rejects an oversized caller prompt before starting the runtime', () => {
    const context = buildNativeAgentContextBundle({
      workflow: { id: 'wf-budget', goal: 'Small goal', currentHeadSha: 'head-1' },
      contracts: [],
      evidence: [],
      evaluationRuns: [],
    } as any, {
      role: 'evaluator',
      runner: 'codex-evaluator',
      promptContract: 'codex-evaluator.v1',
      headSha: 'head-1',
    });
    const prompt = renderNativeContextPrompt(context, 'x'.repeat(context.budget.maxTokens * 5));

    expect(() => assertContextBudget(context, prompt)).toThrow(/context_budget_exceeded/);
  });
});
