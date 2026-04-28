import { describe, expect, it } from 'vitest';
import {
  EventType,
  type WorkspaceExplanation,
  type WorkspaceState,
} from '../src/index.js';

describe('explainability shared contract', () => {
  it('exposes an event type for created explanations', () => {
    expect(EventType.EXPLANATION_CREATED).toBe('explanation.created');
  });

  it('allows workspace state snapshots to carry the latest explanation', () => {
    const explanation: WorkspaceExplanation = {
      status: 'completed',
      summary: 'Workspace completed with explainable evidence.',
      whyThisStatus: ['Workspace phase is COMPLETED.'],
      phases: [],
      changedFiles: [],
      blockers: [],
      unresolvedItems: [],
      nextActions: ['Review generated artifacts and phase summaries.'],
      confidence: 'high',
      generatedAt: '2026-04-28T00:00:00.000Z',
    };

    const state: WorkspaceState = {
      currentPhase: 'COMPLETED',
      demand: 'Close the explainability loop.',
      activeProjectNames: [],
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
      explanation,
    };

    expect(state.explanation).toBe(explanation);
  });
});
