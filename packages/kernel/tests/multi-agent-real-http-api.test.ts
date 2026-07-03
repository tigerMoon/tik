import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus.js';
import { createServer } from '../src/server.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('multi-agent coordination API over real HTTP', () => {
  it('serves the Codex workflow coordination contract through a bound TCP port', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-multi-agent-real-http-'));
    const repoPath = path.join(root, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    tempDirs.push(root);

    const server = await createTestServer(root);
    servers.push(server);
    const client = createHttpClient(server);

    const created = await client.post('/api/v1/multi-agent/workflows', {
      id: 'wf-real-http',
      goal: 'Verify the multi-agent workflow service over real HTTP',
      rootTaskId: 'root-real-http',
      repo: 'repo',
      baseRef: 'main',
      headRef: 'codex/real-http',
      headSha: 'head-1',
      maxRounds: 2,
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        projectName: 'repo',
        effectiveProjectPath: repoPath,
        sourceProjectPath: repoPath,
        worktreeKind: 'root',
      },
    });
    expect(created.status).toBe(200);
    expect(created.body.workflow).toMatchObject({
      id: 'wf-real-http',
      driver: 'codex-workflow',
      status: 'active',
      goal: 'Verify the multi-agent workflow service over real HTTP',
      rootTaskId: 'root-real-http',
      currentHeadSha: 'head-1',
      maxRounds: 2,
    });

    const graph = buildTaskGraph('wf-real-http');
    const putGraph = await client.put('/api/v1/multi-agent/workflows/wf-real-http/task-graph', { graph });
    expect(putGraph.status).toBe(200);
    expect(putGraph.body.subtasks).toMatchObject({
      'st-api': { subtaskId: 'st-api', status: 'ready', fixRound: 0 },
      'st-validation': { subtaskId: 'st-validation', status: 'pending', fixRound: 0 },
    });

    const illegalSubtask = await client.patch('/api/v1/multi-agent/workflows/wf-real-http/subtasks/st-api', {
      status: 'done',
    });
    expect(illegalSubtask.status).toBe(409);
    expect(illegalSubtask.body.error.code).toBe('invalid_transition');

    const executing = await client.patch('/api/v1/multi-agent/workflows/wf-real-http/subtasks/st-api', {
      status: 'executing',
    });
    expect(executing.status).toBe(200);
    expect(executing.body.subtask.status).toBe('executing');

    const validationEvidence = await client.post('/api/v1/multi-agent/workflows/wf-real-http/evidence', {
      id: 'ev-real-http-validation',
      kind: 'validation',
      title: 'Real HTTP validation run',
      summary: 'The kernel multi-agent route accepted a real HTTP validation record.',
      subtaskId: 'st-api',
      command: 'pnpm --filter @tik/kernel exec vitest run tests/multi-agent-real-http-api.test.ts',
      passed: true,
      headSha: 'head-1',
    });
    expect(validationEvidence.status).toBe(200);
    expect(validationEvidence.body.evidence).toMatchObject({
      id: 'ev-real-http-validation',
      workflowId: 'wf-real-http',
      kind: 'validation',
      passed: true,
      headSha: 'head-1',
    });

    const implemented = await client.patch('/api/v1/multi-agent/workflows/wf-real-http/subtasks/st-api', {
      status: 'implemented',
      evidenceRefs: ['ev-real-http-validation'],
      implementationHeadSha: 'head-1',
    });
    expect(implemented.status).toBe(200);
    expect(implemented.body.subtask).toMatchObject({
      status: 'implemented',
      evidenceRefs: ['ev-real-http-validation'],
      implementationHeadSha: 'head-1',
    });

    const validated = await client.patch('/api/v1/multi-agent/workflows/wf-real-http/subtasks/st-api', {
      status: 'validated',
      validationRunIds: ['ev-real-http-validation'],
      lastValidatedHeadSha: 'head-1',
    });
    expect(validated.status).toBe(200);

    const decision = {
      id: 'dec-real-http-human-review-api',
      workflowId: 'wf-real-http',
      rootTaskId: 'root-real-http',
      subtaskId: 'st-api',
      decidedBy: 'codex-workflow',
      decidedAt: '2026-06-30T00:00:00.000Z',
      action: 'request_human_review',
      reason: 'Real HTTP validation evidence exists and can be escalated by Tik.',
      evidenceRefs: ['ev-real-http-validation'],
      inputs: {
        currentHeadSha: 'head-1',
      },
      expectedTikMutation: {
        taskStatus: 'human_review_required',
      },
      confidence: 0.94,
    };
    const recordDecision = await client.post('/api/v1/multi-agent/workflows/wf-real-http/decisions', { decision });
    expect(recordDecision.status).toBe(200);
    expect(recordDecision.body).toMatchObject({
      guard: { accepted: true, code: 'ok' },
      decision,
      workflow: {
        id: 'wf-real-http',
        lastDecisionId: 'dec-real-http-human-review-api',
      },
    });

    const missingEvidenceDecision = await client.post('/api/v1/multi-agent/workflows/wf-real-http/decisions', {
      decision: {
        ...decision,
        id: 'dec-real-http-missing-evidence',
        evidenceRefs: ['ev-does-not-exist'],
      },
    });
    expect(missingEvidenceDecision.status).toBe(409);
    expect(missingEvidenceDecision.body.guard).toMatchObject({
      accepted: false,
      code: 'missing_evidence',
    });

    const done = await client.patch('/api/v1/multi-agent/workflows/wf-real-http/subtasks/st-api', {
      status: 'human_review_required',
    });
    expect(done.status).toBe(200);
    expect(done.body.subtask).toMatchObject({
      status: 'human_review_required',
      evidenceRefs: ['ev-real-http-validation'],
      lastValidatedHeadSha: 'head-1',
    });

    const workflow = await client.get('/api/v1/multi-agent/workflows/wf-real-http');
    expect(workflow.status).toBe(200);
    expect(workflow.body).toMatchObject({
      workflow: {
        id: 'wf-real-http',
        driver: 'codex-workflow',
        status: 'active',
        taskGraphVersion: 1,
        lastDecisionId: 'dec-real-http-human-review-api',
      },
      taskGraph: graph,
      subtasks: {
        'st-api': { status: 'human_review_required' },
        'st-validation': { status: 'pending' },
      },
    });
    expect(workflow.body.evidence).toHaveLength(1);
    expect(workflow.body.decisions).toHaveLength(1);

    const timeline = await client.get('/api/v1/multi-agent/workflows/wf-real-http/timeline');
    expect(timeline.status).toBe(200);
    expect(timeline.body.events.map((event: { type: string }) => event.type)).toEqual([
      'workflow.created',
      'task_graph.created',
      'subtask.updated',
      'evidence.recorded',
      'subtask.updated',
      'subtask.updated',
      'decision.recorded',
      'subtask.updated',
    ]);

    const storedWorkflow = JSON.parse(
      await fs.readFile(path.join(root, '.tik', 'multi-agent', 'workflows', 'wf-real-http', 'workflow.json'), 'utf-8'),
    );
    expect(storedWorkflow).toMatchObject({
      id: 'wf-real-http',
      driver: 'codex-workflow',
      lastDecisionId: 'dec-real-http-human-review-api',
      workspaceBinding: {
        workspaceRoot: root,
        effectiveProjectPath: repoPath,
      },
    });
  });
});

async function createTestServer(root: string) {
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
    { workspaceRoot: root },
  );
}

function createHttpClient(server: { server: { address: () => AddressInfo | string | null } }) {
  const address = server.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Fastify to listen on a TCP address for real HTTP tests.');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(method: string, route: string, payload?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  }

  return {
    get: (route: string) => request('GET', route),
    post: (route: string, payload?: unknown) => request('POST', route, payload),
    put: (route: string, payload?: unknown) => request('PUT', route, payload),
    patch: (route: string, payload?: unknown) => request('PATCH', route, payload),
  };
}

function buildTaskGraph(workflowId: string) {
  return {
    workflowId,
    version: 1,
    createdBy: 'claude-code',
    risks: ['Real HTTP serialization must match Fastify route contracts.'],
    globalAcceptanceCriteria: ['The coordination contract works through a bound HTTP port.'],
    finalValidationCommands: ['pnpm --filter @tik/kernel test'],
    subtasks: [
      {
        id: 'st-api',
        title: 'Verify API contract',
        goal: 'Exercise workflow coordination routes through real HTTP.',
        dependsOn: [],
        allowedPaths: ['packages/kernel/src/**'],
        acceptanceCriteria: ['Workflow, evidence, decisions, subtasks, and timeline are reachable over HTTP.'],
        validationCommands: ['pnpm --filter @tik/kernel exec vitest run tests/multi-agent-real-http-api.test.ts'],
        reviewFocus: ['route contracts', 'state transitions'],
        assignedExecutor: 'codex',
        assignedReviewer: 'claude-code',
      },
      {
        id: 'st-validation',
        title: 'Record validation follow-up',
        goal: 'Track a dependent validation lane.',
        dependsOn: ['st-api'],
        allowedPaths: ['packages/kernel/tests/**'],
        acceptanceCriteria: ['Dependent subtask starts pending.'],
        validationCommands: ['pnpm test'],
        reviewFocus: ['timeline ordering'],
        assignedExecutor: 'codex',
        assignedReviewer: 'claude-code',
      },
    ],
  };
}
