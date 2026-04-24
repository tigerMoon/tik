import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceMemoryStore } from '../src/workspace-memory.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceMemoryStore', () => {
  it('persists session and project memory snapshots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tik-workspace-memory-'));
    tempDirs.push(root);
    const store = new WorkspaceMemoryStore(root);

    const memory = await store.refresh({
      settings: {
        workspaceName: 'demo',
        workspaceRoot: root,
        workspaceFile: path.join(root, 'demo.code-workspace'),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        projects: [{ name: 'service-a', path: path.join(root, 'service-a') }],
        workflowPolicy: { profile: 'deep-verify' },
      },
      splitDemands: {
        demand: '给 service-a 增加缓存',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [{
          projectName: 'service-a',
          projectPath: path.join(root, 'service-a'),
          demand: '给 service-a 增加缓存',
          reason: 'ownership cues',
          status: 'completed',
        }],
      },
      state: {
        currentPhase: 'PARALLEL_PLAN',
        demand: '给 service-a 增加缓存',
        activeProjectNames: ['service-a'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        projects: [{
          projectName: 'service-a',
          projectPath: path.join(root, 'service-a'),
          phase: 'PARALLEL_PLAN',
          status: 'completed',
          workflowRole: 'reviewer',
          workflowContract: 'PLAN_SUBTASK',
          workflowSkillName: 'sdd-plan',
          executionMode: 'native',
          specPath: path.join(root, 'service-a/.specify/specs/feature/spec.md'),
          planPath: path.join(root, 'service-a/.specify/specs/feature/plan.md'),
          summary: 'Plan completed',
          updatedAt: '2026-01-01T00:10:00.000Z',
        }],
      },
      projection: {
        totalEvents: 2,
        phases: [],
        projects: [{
          projectName: 'service-a',
          eventCount: 2,
          feedbackCount: 0,
          recoveryCount: 0,
          completionCount: 1,
          lastKind: 'phase.completed',
          lastMessage: 'Plan completed',
        }],
        recent: [],
      },
    });

    expect(memory.session.workflowProfile).toBe('deep-verify');
    expect(memory.session.completedProjects).toEqual(['service-a']);
    expect(memory.projects[0]?.knownArtifacts).toHaveLength(2);

    const loaded = await store.load();
    expect(loaded?.session.nextAction).toBe('tik workspace next --provider codex');
    expect(loaded?.projects[0]?.executionMode).toBe('native');
  });

  it('sanitizes project names when writing project memory files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tik-workspace-memory-'));
    tempDirs.push(root);
    const store = new WorkspaceMemoryStore(root);

    await store.refresh({
      settings: null,
      splitDemands: null,
      state: {
        currentPhase: 'PARALLEL_SPECIFY',
        demand: 'demo',
        activeProjectNames: ['catalog suite/api'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        projects: [{
          projectName: 'catalog suite/api',
          projectPath: path.join(root, 'catalog-suite'),
          phase: 'PARALLEL_SPECIFY',
          status: 'pending',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      },
      projection: { totalEvents: 0, phases: [], projects: [], recent: [] },
    });

    expect(fs.existsSync(path.join(root, '.workspace', 'memory', 'projects', 'catalog-suite-api.json'))).toBe(true);
  });
});
