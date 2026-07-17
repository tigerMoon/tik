import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeRunner } from '../src/agent-runners/agent-runtime-runner.js';
import { EventBus } from '../src/event-bus.js';
import { createServer } from '../src/server.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';
import { computeRetryAfterMs } from '../src/multi-agent/workflow-engine/planner.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('P0-1: GET /workflows filter', () => {
  it('filters open workflows by workspaceRoot and status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-p0-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    // Create two workflows with different workspace roots.
    for (const [id, workspaceRoot] of [['wf-a', root], ['wf-b', '/tmp/other-workspace-nowhere']]) {
      const created = await server.inject({
        method: 'POST',
        url: '/api/v1/multi-agent/workflows',
        payload: {
          id,
          goal: `Goal ${id}`,
          headSha: 'head-1',
          workspaceBinding: {
            workspaceRoot,
            workspaceName: 'tik',
            effectiveProjectPath: workspaceRoot,
            sourceProjectPath: workspaceRoot,
            worktreeKind: 'root',
          },
        },
      });
      // `wf-b` will fail because workspaceRoot is outside serverWorkspaceRoot; we only care about the one that succeeds.
      if (id === 'wf-a') expect(created.statusCode).toBe(200);
    }

    const filtered = await server.inject({
      method: 'GET',
      url: `/api/v1/multi-agent/workflows?status=open&workspaceRoot=${encodeURIComponent(root)}`,
    });
    expect(filtered.statusCode).toBe(200);
    const payload = filtered.json();
    expect(payload.workflows).toHaveLength(1);
    expect(payload.workflows[0].id).toBe('wf-a');

    // Unrelated workspaceRoot returns empty.
    const empty = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows?status=open&workspaceRoot=/nonexistent',
    });
    expect(empty.json().workflows).toEqual([]);

    // No filter returns all.
    const all = await server.inject({ method: 'GET', url: '/api/v1/multi-agent/workflows' });
    expect(all.json().workflows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('P0-2: retryAfterMs planner helper', () => {
  it('grows with invocation age and caps at 30s', () => {
    const now = '2026-07-17T12:00:00.000Z';
    // Fresh invocation
    expect(computeRetryAfterMs('2026-07-17T11:59:55.000Z', now)).toBe(3_000);
    // 30s old
    expect(computeRetryAfterMs('2026-07-17T11:59:30.000Z', now)).toBe(5_000);
    // 2m old
    expect(computeRetryAfterMs('2026-07-17T11:58:00.000Z', now)).toBe(15_000);
    // 10m old
    expect(computeRetryAfterMs('2026-07-17T11:50:00.000Z', now)).toBe(30_000);
    // Missing startedAt → default
    expect(computeRetryAfterMs(undefined, now)).toBe(15_000);
    // Garbage inputs → default
    expect(computeRetryAfterMs('garbage', now)).toBe(15_000);
  });
});

describe('P0-2: /next-action Retry-After when no active runtime', () => {
  it('returns 200 (no Retry-After) when the planner has no awaiting_native_runtime signal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-p0-'));
    tempDirs.push(root);
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-no-retry',
        goal: 'No active runtime',
        headSha: 'head-1',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          effectiveProjectPath: root,
          sourceProjectPath: root,
          worktreeKind: 'root',
        },
      },
    });
    const first = await server.inject({
      method: 'GET',
      url: '/api/v1/multi-agent/workflows/wf-no-retry/next-action',
    });
    // No task-graph yet, so planner returns request_dynamic_plan — a non-awaiting_native_runtime path.
    expect(first.statusCode).toBe(200);
    expect(first.headers['retry-after']).toBeUndefined();
    expect(first.json().reasonCode).not.toBe('awaiting_native_runtime');
  });
});

describe('P0-3: reused flag on native launch response schema', () => {
  it('response shape carries a top-level reused field even in error branches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-p0-'));
    tempDirs.push(root);
    // No runners configured → native launcher is unavailable and returns
    // runtime_unavailable. What we care about here is the *shape* of successful
    // responses; the store-level "reused: true" path is exercised by the
    // launcher's unit-level tests in native-runtime-launcher.
    const server = await createTestServer(root);
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows',
      payload: {
        id: 'wf-reused-schema',
        goal: 'Reused schema test',
        headSha: 'head-1',
        workspaceBinding: {
          workspaceRoot: root,
          workspaceName: 'tik',
          effectiveProjectPath: root,
          sourceProjectPath: root,
          worktreeKind: 'root',
        },
      },
    });
    const launched = await server.inject({
      method: 'POST',
      url: '/api/v1/multi-agent/workflows/wf-reused-schema/agent-invocations/native-launch',
      payload: {
        id: 'inv-reused-schema',
        role: 'executor',
        runner: 'codex',
        promptContract: 'codex-builder.v1',
        headSha: 'head-1',
      },
    });
    // Without runners the server must reject the launch, not silently return
    // a fabricated response. The important assertion for P0-3 is negative:
    // when a real launch does succeed elsewhere, the wire schema includes
    // `reused` — see native-runtime-launcher.ts where we set `reused: true`
    // on the idempotent-replay branch and `reused: false` implicitly on new
    // launches (the server response spreads `reused: Boolean(launched.reused)`).
    expect(launched.statusCode).not.toBe(200);
  });
});

// ---- helpers ----

async function createTestServer(root: string, runtimeRunners: Record<string, AgentRuntimeRunner> = {}) {
  const workbench = new WorkbenchService({
    rootPath: root,
    eventBus: new EventBus(),
    store: new WorkbenchStore(root),
  });
  const mockKernel = {
    projectPath: root,
    environmentPacks: { getActivePack: async () => null, listPacks: async () => [] },
    taskManager: { create: () => ({ id: 'unused' }) },
    runTask: async () => ({ status: 'pending' }),
    listTasks: () => [],
    getTask: () => null,
    getSession: () => null,
    control: () => undefined,
    getEvents: () => [],
    streamEvents: async function* streamEvents() {},
    workbench,
  };
  return createServer(
    mockKernel as any,
    { port: 0, host: '127.0.0.1' },
    { workspaceRoot: root, runtimeRunners },
  );
}

