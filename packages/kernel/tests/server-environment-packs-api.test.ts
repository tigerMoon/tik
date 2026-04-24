import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { EnvironmentPackRegistry } from '../src/environment-pack-registry.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createPack(root: string, id: string, name: string): Promise<void> {
  const packDir = path.join(root, 'env-packs', id);
  await fs.mkdir(packDir, { recursive: true });
  await fs.writeFile(path.join(packDir, 'pack.json'), JSON.stringify({
    kind: 'EnvironmentPack',
    id,
    name,
    version: '0.1.0',
    description: `${name} description`,
    tools: ['shell'],
    skills: ['coder'],
    knowledge: [],
    policies: [],
    workflowBindings: [],
    evaluators: [],
  }, null, 2), 'utf-8');
}

describe('environment pack API routes', () => {
  it('lists packs and switches the active pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-env-pack-api-'));
    tempDirs.push(root);
    await createPack(root, 'base-engineering', 'Base Engineering');
    await createPack(root, 'design-to-code', 'Design To Code');

    const mockKernel = {
      taskManager: { create: () => ({ id: 'task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      environmentPacks: new EnvironmentPackRegistry(root),
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const listResponse = await server.inject({ method: 'GET', url: '/api/environment-packs' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().packs).toHaveLength(2);
    expect(listResponse.json().activePackId).toBe('base-engineering');

    const switchResponse = await server.inject({
      method: 'POST',
      url: '/api/environment-packs/active',
      payload: { packId: 'design-to-code' },
    });
    expect(switchResponse.statusCode).toBe(200);
    expect(switchResponse.json().activePack.id).toBe('design-to-code');

    const activeResponse = await server.inject({ method: 'GET', url: '/api/environment-packs/active' });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json().activePack.id).toBe('design-to-code');
  });

  it('returns environment dashboard summaries with task counts and promotion queue', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-env-pack-dashboard-'));
    tempDirs.push(root);

    const baseDir = path.join(root, 'env-packs', 'base-engineering');
    const packDir = path.join(root, 'env-packs', 'commerce-ops');
    await fs.mkdir(baseDir, { recursive: true });
    await fs.mkdir(packDir, { recursive: true });

    await fs.writeFile(path.join(baseDir, 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
      description: 'Base pack',
      tools: ['shell'],
      skills: ['coder'],
      knowledge: [],
      policies: [],
      workflowBindings: [],
      evaluators: [],
    }, null, 2), 'utf-8');

    await fs.writeFile(path.join(packDir, 'pack.json'), JSON.stringify({
      kind: 'EnvironmentPack',
      id: 'commerce-ops',
      name: 'Commerce Ops',
      version: '0.1.0',
      description: 'Operations pack',
      tools: ['github'],
      skills: ['pr-review'],
      knowledge: [],
      policies: ['prod-change-requires-approval'],
      workflowBindings: [
        {
          workflow: 'feature-delivery',
          phases: {
            plan: ['solution-proposal'],
            review: ['pr-review'],
            verify: ['risk-evaluator'],
          },
        },
      ],
      evaluators: ['risk-evaluator'],
    }, null, 2), 'utf-8');

    const mockKernel = {
      taskManager: { create: () => ({ id: 'task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      environmentPacks: new EnvironmentPackRegistry(root),
      workbench: {
        listTasks: async () => [
          {
            id: 'wb-1',
            title: 'Review API compatibility',
            goal: 'Review API compatibility',
            status: 'waiting_for_user',
            createdAt: '2026-04-13T02:00:00.000Z',
            updatedAt: '2026-04-13T02:05:00.000Z',
            lastProgressAt: '2026-04-13T02:05:00.000Z',
            environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '0.1.0' },
          },
          {
            id: 'wb-2',
            title: 'Draft rollout notes',
            goal: 'Draft rollout notes',
            status: 'running',
            createdAt: '2026-04-13T01:00:00.000Z',
            updatedAt: '2026-04-13T01:10:00.000Z',
            lastProgressAt: '2026-04-13T01:10:00.000Z',
            environmentPackSnapshot: { id: 'commerce-ops', name: 'Commerce Ops', version: '0.1.0' },
          },
        ],
      },
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/api/environment-packs/dashboard' });
    expect(response.statusCode).toBe(200);

    const json = response.json();
    expect(json.activePackId).toBe('base-engineering');
    const opsSummary = json.summaries.find((summary: any) => summary.packId === 'commerce-ops');
    expect(opsSummary.boundTaskCount).toBe(2);
    expect(opsSummary.activeTaskCount).toBe(2);
    expect(opsSummary.waitingTaskCount).toBe(1);
    expect(opsSummary.latestBoundTasks.map((task: any) => task.id)).toEqual(['wb-1', 'wb-2']);
    expect(opsSummary.promotionQueue).toEqual([
      {
        id: 'missing-capability:feature-delivery:plan:solution-proposal',
        kind: 'capability proposal',
        detail: 'Promote "solution-proposal" into feature-delivery / plan so this pack can satisfy its declared workflow binding.',
      },
    ]);
  });
});
