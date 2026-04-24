import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('skills API routes', () => {
  it('saves drafts and publishes skill manifests through the registry API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-skill-api-'));
    tempDirs.push(root);

    const mockKernel = {
      projectPath: root,
      taskManager: { create: () => ({ id: 'task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      environmentPacks: {
        listPacks: async () => [],
        getActivePack: async () => null,
      },
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const initialResponse = await server.inject({ method: 'GET', url: '/api/skills/registry' });
    expect(initialResponse.statusCode).toBe(200);
    expect(initialResponse.json().skills).toEqual([]);

    const payload = {
      notes: 'Review portability before publish.',
      snapshot: {
        skillId: 'api-compat-check',
        label: 'API Compat Check',
        scope: 'environment',
        version: '1.1.0',
        ownerPackId: 'commerce-ops',
        ownerPackName: 'Commerce Ops',
        packIds: ['commerce-ops'],
        packNames: ['Commerce Ops'],
        requiredTools: ['github'],
        requiredKnowledge: [
          { id: 'operations-runbook', label: 'Operations Runbook', kind: 'runbook' },
        ],
        policyHooks: ['pii-redaction'],
        evaluators: ['risk-evaluator'],
        bindings: [
          { workflow: 'feature-delivery', phase: 'verify', packId: 'commerce-ops' },
        ],
        taskCount: 2,
        activeTaskCount: 1,
        selectedTaskCount: 2,
      },
    };

    const draftResponse = await server.inject({
      method: 'POST',
      url: '/api/skills/api-compat-check/draft',
      payload,
    });
    expect(draftResponse.statusCode).toBe(200);
    expect(draftResponse.json().skill.draft.notes).toBe('Review portability before publish.');
    expect(draftResponse.json().skill.published).toBeNull();
    expect(draftResponse.json().skill.revisions).toHaveLength(1);

    const publishResponse = await server.inject({
      method: 'POST',
      url: '/api/skills/api-compat-check/publish',
      payload: {
        ...payload,
        notes: 'Ready for rollout.',
      },
    });
    expect(publishResponse.statusCode).toBe(200);
    expect(publishResponse.json().skill.published.notes).toBe('Ready for rollout.');
    expect(publishResponse.json().skill.revisions).toHaveLength(2);

    const listResponse = await server.inject({ method: 'GET', url: '/api/skills/registry' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().skills).toHaveLength(1);
    expect(listResponse.json().skills[0].published.snapshot.skillId).toBe('api-compat-check');
  });
});
