import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspaceEventProjection } from '../src/workspace-event-projection.js';
import { WorkspaceEventStore } from '../src/workspace-event-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceEventStore', () => {
  it('persists records to jsonl and reloads them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tik-event-store-'));
    tempDirs.push(root);
    const persistPath = path.join(root, 'events.jsonl');

    const store = new WorkspaceEventStore({ persistPath });
    store.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_SPECIFY',
      message: 'Specify started.',
    });
    store.record({
      level: 'project',
      kind: 'subtask.started',
      phase: 'PARALLEL_SPECIFY',
      projectName: 'catalog-suite',
      taskId: 'task-1',
      message: 'Delegated specify started.',
    });

    expect(store.count()).toBe(2);
    expect(fs.readFileSync(persistPath, 'utf-8').trim().split('\n')).toHaveLength(2);

    const reloaded = new WorkspaceEventStore({ persistPath });
    expect(reloaded.count()).toBe(2);
    expect(reloaded.latest()?.message).toBe('Delegated specify started.');
  });

  it('builds event projections for phases, projects, and recent records', () => {
    const store = new WorkspaceEventStore();
    store.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_SPECIFY',
      message: 'Specify started.',
    });
    store.record({
      level: 'project',
      kind: 'feedback.recorded',
      phase: 'PARALLEL_SPECIFY',
      projectName: 'catalog-suite',
      message: 'Need another specify pass.',
    });
    store.record({
      level: 'project',
      kind: 'phase.completed',
      phase: 'PARALLEL_PLAN',
      projectName: 'catalog-suite',
      message: 'Plan completed.',
    });
    store.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_PLAN',
      message: 'Plan phase started.',
    });
    store.record({
      level: 'workspace',
      kind: 'phase.started',
      phase: 'PARALLEL_PLAN',
      message: 'Plan phase started.',
    });

    const projection = buildWorkspaceEventProjection(store.snapshot());

    expect(projection.totalEvents).toBe(5);
    expect(projection.phases).toEqual([
      expect.objectContaining({ phase: 'PARALLEL_SPECIFY', eventCount: 2 }),
      expect.objectContaining({ phase: 'PARALLEL_PLAN', eventCount: 3 }),
    ]);
    expect(projection.projects).toEqual([
      expect.objectContaining({
        projectName: 'catalog-suite',
        eventCount: 2,
        feedbackCount: 1,
        completionCount: 1,
        lastMessage: 'Plan completed.',
      }),
    ]);
    expect(projection.recent).toHaveLength(5);
    expect(projection.recentDisplay).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'PARALLEL_PLAN',
        kind: 'phase.started',
        message: 'Plan phase started.',
        count: 2,
      }),
    ]));
  });
});
