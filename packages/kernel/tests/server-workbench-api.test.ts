import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { EventBus } from '../src/event-bus.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('workbench API routes', () => {
  it('creates tasks and serves timeline and decision data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    let runTaskCalls = 0;
    let createdTaskInput: Record<string, unknown> | null = null;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => ({
          kind: 'EnvironmentPack',
          id: 'commerce-ops',
          name: 'Commerce Ops',
          version: '0.2.0',
          description: 'Service delivery pack',
          tools: [],
          skills: ['release-review', 'delivery-qa'],
          knowledge: [
            { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
            { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }),
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdTaskInput = input;
          return { id: 'legacy-task-1' };
        },
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks',
      payload: { title: 'Inspect auth', goal: 'Review auth flow and patch issues' },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().task.id).toBe('legacy-task-1');
    expect(createResponse.json().task.environmentPackSnapshot.id).toBe('commerce-ops');
    expect(createResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['release-review', 'delivery-qa'],
      selectedKnowledgeIds: ['operations-runbook', 'operations-wiki'],
    });
    expect(createdTaskInput?.environmentPackSnapshot).toEqual({
      id: 'commerce-ops',
      name: 'Commerce Ops',
      version: '0.2.0',
    });
    expect(createdTaskInput?.environmentPackSelection).toEqual({
      selectedSkills: ['release-review', 'delivery-qa'],
      selectedKnowledgeIds: ['operations-runbook', 'operations-wiki'],
    });
    expect(runTaskCalls).toBe(1);

    const taskId = createResponse.json().task.id;

    const listResponse = await server.inject({ method: 'GET', url: '/api/workbench/tasks' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().tasks[0].id).toBe(taskId);

    const timelineResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${taskId}/timeline`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(Array.isArray(timelineResponse.json().timeline)).toBe(true);

    const decisionsResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${taskId}/decisions`,
    });
    expect(decisionsResponse.statusCode).toBe(200);
    expect(decisionsResponse.json().decisions).toEqual([]);
  });

  it('creates tasks with an explicit environment binding instead of relying on the active pack', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    let createdTaskInput: Record<string, unknown> | null = null;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => ({
          kind: 'EnvironmentPack',
          id: 'commerce-ops',
          name: 'Commerce Ops',
          version: '0.2.0',
          description: 'Service delivery pack',
          tools: [],
          skills: ['release-review', 'delivery-qa'],
          knowledge: [
            { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
            { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }),
        listPacks: async () => [
          {
            kind: 'EnvironmentPack',
            id: 'commerce-ops',
            name: 'Commerce Ops',
            version: '0.2.0',
            description: 'Service delivery pack',
            tools: [],
            skills: ['release-review', 'delivery-qa'],
            knowledge: [
              { id: 'operations-runbook', kind: 'runbook', label: 'Operations Runbook' },
              { id: 'operations-wiki', kind: 'docs', label: 'Operations Wiki' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
          {
            kind: 'EnvironmentPack',
            id: 'base-engineering',
            name: 'Base Engineering',
            version: '0.1.0',
            description: 'Base pack',
            tools: ['shell'],
            skills: ['coder', 'pr-review', 'test-runner'],
            knowledge: [
              { id: 'repo-index', kind: 'repo-index', label: 'Repository Index' },
              { id: 'runbooks', kind: 'runbook', label: 'Runbooks' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
        ],
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdTaskInput = input;
          return { id: 'legacy-task-explicit-pack' };
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/workbench/tasks',
      payload: {
        title: 'Ship preview build',
        goal: 'Prepare a reviewable preview before launch',
        environmentPackId: 'base-engineering',
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
    });
    expect(createResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['coder', 'test-runner'],
      selectedKnowledgeIds: ['repo-index'],
    });
    expect(createdTaskInput?.environmentPackSnapshot).toEqual({
      id: 'base-engineering',
      name: 'Base Engineering',
      version: '0.1.0',
    });
    expect(createdTaskInput?.environmentPackSelection).toEqual({
      selectedSkills: ['coder', 'test-runner'],
      selectedKnowledgeIds: ['repo-index'],
    });
  });

  it('retries an inactive task by cloning it into a new running task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const createdInputs: Record<string, unknown>[] = [];
    let nextTaskId = 0;
    let runTaskCalls = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdInputs.push(input);
          nextTaskId += 1;
          return { id: `legacy-task-${nextTaskId}` };
        },
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const original = await workbench.createTask({
      title: 'Snake game',
      goal: 'Build an H5 playable snake game',
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react'],
        selectedKnowledgeIds: ['design-system'],
      },
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        effectiveProjectPath: path.join(root, 'apps', 'snake'),
        projectName: 'snake',
        sourceProjectPath: path.join(root, 'apps', 'snake'),
        worktreeKind: 'source',
      },
    }, 'legacy-task-original');
    await store.upsertTask({
      ...original,
      status: 'failed',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Supervisor observed event task.failed.',
      lastAdjustment: {
        previousTitle: 'Snake game',
        previousGoal: 'Build an H5 playable snake game',
        nextTitle: 'Snake game',
        nextGoal: 'Build an H5 playable snake game',
        note: 'Add more playful motion.',
        appliedAt: '2026-04-09T00:00:02.000Z',
      },
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${original.id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(200);
    expect(retryResponse.json().task.id).toBe('legacy-task-1');
    expect(retryResponse.json().task.title).toBe('Snake game');
    expect(retryResponse.json().task.goal).toBe('Build an H5 playable snake game');
    expect(retryResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
    expect(retryResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['figma-to-react'],
      selectedKnowledgeIds: ['design-system'],
    });
    expect(retryResponse.json().task.lastAdjustment.note).toBe('Add more playful motion.');
    expect(retryResponse.json().task.workspaceBinding).toEqual({
      workspaceRoot: root,
      workspaceName: 'tik',
      effectiveProjectPath: path.join(root, 'apps', 'snake'),
      projectName: 'snake',
      sourceProjectPath: path.join(root, 'apps', 'snake'),
      worktreeKind: 'source',
    });
    expect(createdInputs[0]).toMatchObject({
      description: [
        'Snake game: Build an H5 playable snake game',
        'Adjustment note: Add more playful motion.',
      ].join('\n\n'),
      projectPath: path.join(root, 'apps', 'snake'),
      workspaceBinding: {
        workspaceRoot: root,
        workspaceName: 'tik',
        effectiveProjectPath: path.join(root, 'apps', 'snake'),
        projectName: 'snake',
        sourceProjectPath: path.join(root, 'apps', 'snake'),
        worktreeKind: 'source',
      },
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react'],
        selectedKnowledgeIds: ['design-system'],
      },
    });
    expect(runTaskCalls).toBe(1);
  });

  it('updates task-level skill and knowledge configuration through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [{
          kind: 'EnvironmentPack',
          id: 'design-to-code',
          name: 'Design To Code',
          version: '0.1.0',
          description: 'Design delivery pack',
          tools: ['frontend-preview'],
          skills: ['figma-to-react', 'ui-review'],
          knowledge: [
            { id: 'design-system', kind: 'design-system', label: 'Design System' },
            { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
          ],
          policies: [],
          workflowBindings: [],
          evaluators: [],
        }],
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateEnvironmentPackSelection: (
          taskId: string,
          selection: Record<string, unknown>,
          snapshot?: Record<string, unknown>,
        ) => {
          const task = taskState.get(taskId);
          if (task) {
            task.environmentPackSelection = selection;
            if (snapshot) {
              task.environmentPackSnapshot = snapshot;
            }
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Configure task',
      goal: 'Narrow runtime capabilities',
      environmentPackSnapshot: {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['figma-to-react', 'ui-review'],
        selectedKnowledgeIds: ['design-system', 'ui-guidelines'],
      },
    }, 'task-config');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
      environmentPackSnapshot: task.environmentPackSnapshot,
      environmentPackSelection: task.environmentPackSelection,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const updateResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/configuration`,
      payload: {
        selectedSkills: ['ui-review'],
        selectedKnowledgeIds: ['ui-guidelines'],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });
    expect(taskState.get(task.id)?.environmentPackSelection).toEqual({
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });
  });

  it('rebinds the task to another environment pack through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
        listPacks: async () => [
          {
            kind: 'EnvironmentPack',
            id: 'base-engineering',
            name: 'Base Engineering',
            version: '0.1.0',
            description: 'Base pack',
            tools: ['shell'],
            skills: ['coder', 'pr-review'],
            knowledge: [
              { id: 'repo-index', kind: 'repo-index', label: 'Repository Index' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
          {
            kind: 'EnvironmentPack',
            id: 'design-to-code',
            name: 'Design To Code',
            version: '0.1.0',
            description: 'Design delivery pack',
            tools: ['frontend-preview'],
            skills: ['figma-to-react', 'ui-review'],
            knowledge: [
              { id: 'design-system', kind: 'design-system', label: 'Design System' },
              { id: 'ui-guidelines', kind: 'docs', label: 'UI Guidelines' },
            ],
            policies: [],
            workflowBindings: [],
            evaluators: [],
          },
        ],
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateEnvironmentPackSelection: (
          taskId: string,
          selection: Record<string, unknown>,
          snapshot?: Record<string, unknown>,
        ) => {
          const task = taskState.get(taskId);
          if (task) {
            task.environmentPackSelection = selection;
            if (snapshot) {
              task.environmentPackSnapshot = snapshot;
            }
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Retarget task',
      goal: 'Move this task into the design flow',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'pr-review'],
        selectedKnowledgeIds: ['repo-index'],
      },
    }, 'task-rebind');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
      environmentPackSnapshot: task.environmentPackSnapshot,
      environmentPackSelection: task.environmentPackSelection,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const updateResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/configuration`,
      payload: {
        environmentPackId: 'design-to-code',
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().task.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
    expect(updateResponse.json().task.environmentPackSelection).toEqual({
      selectedSkills: ['figma-to-react', 'ui-review'],
      selectedKnowledgeIds: ['design-system', 'ui-guidelines'],
    });
    expect(taskState.get(task.id)?.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
  });

  it('updates the task brief through the workbench API and syncs the kernel task description', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Console polish',
      goal: 'Ship the control-console shell',
    }, 'task-brief');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Console control shell',
        goal: 'Ship the control-console shell with explicit task steering',
        adjustment: 'Make the center panel behave like task adjustment, not chat.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.title).toBe('Console control shell');
    expect(response.json().task.goal).toContain('explicit task steering');
    expect(taskState.get(task.id)?.description).toContain('Adjustment note: Make the center panel behave like task adjustment, not chat.');

    const timelineResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${task.id}/timeline`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(
      timelineResponse.json().timeline.some((item: { actor: string; body: string }) => (
        item.actor === 'user' && item.body.includes('Adjusted task brief')
      )),
    ).toBe(true);
  });

  it('uses an operator note to resume a waiting task instead of leaving it stuck in review', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const controlCalls: Array<Record<string, unknown>> = [];
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: (taskId: string, command: Record<string, unknown>) => {
        controlCalls.push({ taskId, ...command });
      },
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Preview release validation',
      goal: 'Validate the console preview before approval',
    }, 'task-note-resume');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });
    await workbench.requestToolApproval(task.id, 'bash');

    const waitingTask = await workbench.readTask(task.id);
    expect(waitingTask?.status).toBe('waiting_for_user');
    expect(waitingTask?.waitingDecisionId).toBeTruthy();
    await store.upsertTask({
      ...(await store.readTaskBundle(task.id)).task!,
      status: 'running',
      updatedAt: '2026-04-13T12:44:30.000Z',
      latestSummary: 'Supervisor resumed task execution.',
      waitingReason: undefined,
      waitingDecisionId: undefined,
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Preview release validation',
        goal: 'Validate the console preview before approval',
        adjustment: 'Avoid the risky shell path and continue with a safer review pass.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.status).toBe('running');
    expect(response.json().task.waitingDecisionId).toBeUndefined();
    expect(response.json().task.lastAdjustment.note).toBe('Avoid the risky shell path and continue with a safer review pass.');
    expect(response.json().task.latestSummary).toContain('Operator rejected');
    expect(controlCalls).toContainEqual({
      taskId: task.id,
      type: 'inject_constraint',
      constraint: 'Avoid the risky shell path and continue with a safer review pass.',
    });

    const decisionsResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/tasks/${task.id}/decisions`,
    });
    expect(decisionsResponse.statusCode).toBe(200);
    expect(decisionsResponse.json().decisions).toEqual([]);
  });

  it('launches a follow-up pass when a brief update requests the next run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const createdInputs: Record<string, unknown>[] = [];
    let runTaskCalls = 0;
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: (input: Record<string, unknown>) => {
          createdInputs.push(input);
          return { id: `legacy-follow-up-${createdInputs.length}` };
        },
        get: () => null,
        updateDescription: () => undefined,
      },
      runTask: async () => {
        runTaskCalls += 1;
        return { status: 'pending' };
      },
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const workspaceBinding = {
      workspaceRoot: root,
      workspaceName: 'tik',
      effectiveProjectPath: path.join(root, 'apps', 'console'),
      projectName: 'console',
      sourceProjectPath: path.join(root, 'apps', 'console'),
      worktreeKind: 'source' as const,
    };
    const task = await workbench.createTask({
      title: 'Snake polish',
      goal: 'Ship a more expressive snake game pass',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
      workspaceBinding,
    }, 'task-follow-up-source');
    await store.upsertTask({
      ...task,
      status: 'completed',
      workspaceBinding,
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Task completed and the latest outputs are ready for review.',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief`,
      payload: {
        title: 'Snake polish',
        goal: 'Ship a more expressive snake game pass',
        adjustment: 'Add more cartoon motion and acceptance evidence.',
        launchFollowUp: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.lastAdjustment.note).toBe('Add more cartoon motion and acceptance evidence.');
    expect(response.json().followUpTask.id).toBe('legacy-follow-up-1');
    expect(response.json().followUpTask.lastAdjustment.note).toBe('Add more cartoon motion and acceptance evidence.');
    expect(response.json().followUpTask.workspaceBinding).toEqual(workspaceBinding);
    expect(createdInputs[0]).toMatchObject({
      description: [
        'Snake polish: Ship a more expressive snake game pass',
        'Adjustment note: Add more cartoon motion and acceptance evidence.',
      ].join('\n\n'),
      projectPath: workspaceBinding.effectiveProjectPath,
      workspaceBinding,
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder', 'test-runner'],
        selectedKnowledgeIds: ['repo-index'],
      },
    });
    expect(runTaskCalls).toBe(1);
  });

  it('reverts the latest task brief adjustment through the workbench API', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const taskState = new Map<string, Record<string, unknown>>();
    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'unused' }),
        get: (taskId: string) => taskState.get(taskId),
        updateDescription: (taskId: string, description: string) => {
          const task = taskState.get(taskId);
          if (task) {
            task.description = description;
          }
          return task;
        },
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Original brief',
      goal: 'Ship the original scope',
    }, 'task-revert');
    taskState.set(task.id, {
      id: task.id,
      description: `${task.title}: ${task.goal}`,
    });
    await workbench.updateTaskBrief(task.id, {
      title: 'Adjusted brief',
      goal: 'Ship the adjusted scope',
      adjustment: 'Prioritize previewable output.',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/brief/revert`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().task.title).toBe('Original brief');
    expect(response.json().task.goal).toBe('Ship the original scope');
    expect(response.json().task.lastAdjustment).toBeUndefined();
    expect(taskState.get(task.id)?.description).toBe('Original brief: Ship the original scope');
  });

  it('rejects retry while a task is still active', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: {
        getActivePack: async () => null,
      },
      taskManager: {
        create: () => ({ id: 'legacy-task-1' }),
      },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const original = await workbench.createTask({
      title: 'Still running',
      goal: 'Do active work',
    }, 'legacy-task-original');
    await store.upsertTask({
      ...original,
      status: 'running',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
    });

    const server = await createServer(
      mockKernel as any,
      { port: 0, host: '127.0.0.1' },
      { workspaceRoot: root },
    );
    servers.push(server);

    const retryResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${original.id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(409);
    expect(retryResponse.json().error).toContain('cannot be retried');
  });

  it('archives inactive tasks and hides them from active workflows without deleting history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Archive me',
      goal: 'Keep the list clean',
    }, 'task-archive');
    await store.upsertTask({
      ...task,
      status: 'failed',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
    });

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/archive`,
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().task.status).toBe('archived');

    const taskListResponse = await server.inject({ method: 'GET', url: '/api/workbench/tasks' });
    expect(taskListResponse.statusCode).toBe(200);
    expect(taskListResponse.json().tasks.find((item: { id: string }) => item.id === task.id)?.status).toBe('archived');
  });

  it('archives stale running tasks when the workbench record exists but the kernel task is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Orphaned runtime',
      goal: 'Keep the queue clean even when runtime state is missing',
    }, 'task-stale-archive');
    await store.upsertTask({
      ...task,
      status: 'running',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Supervisor observed event iteration.completed.',
    });

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const archiveResponse = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/archive`,
    });

    expect(archiveResponse.statusCode).toBe(200);
    expect(archiveResponse.json().task.status).toBe('archived');
    expect(archiveResponse.json().task.latestSummary).toContain('runtime record went missing');
  });

  it('resolves a workbench decision through the API and clears the waiting state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => ({ id: 'task-decision' }),
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const task = await workbench.createTask({
      title: 'Publish dry-run',
      goal: 'Validate decision resolution',
    }, 'task-decision');
    const decision = await workbench.requestToolApproval(task.id, 'bash');

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: `/api/workbench/tasks/${task.id}/decisions/${decision!.id}/resolve`,
      payload: {
        optionId: 'reject',
        message: 'Use a safer publish path.',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().decision.status).toBe('dismissed');
    expect(response.json().task.waitingDecisionId).toBeUndefined();
    expect(response.json().task.waitingReason).toBeUndefined();
    expect(response.json().task.latestSummary).toContain('rejected');
  });

  it('serves previewable artifact files from the project root and blocks paths outside it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-api-'));
    tempDirs.push(root);

    const previewPath = path.join(root, 'src', 'mock-app.html');
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, '<!doctype html><title>Preview</title><h1>Snake</h1>', 'utf-8');

    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const workbench = new WorkbenchService({ rootPath: root, eventBus, store });

    const mockKernel = {
      projectPath: root,
      environmentPacks: { getActivePack: async () => null },
      taskManager: { create: () => ({ id: 'legacy-task-1' }) },
      runTask: async () => ({ status: 'pending' }),
      listTasks: () => [],
      getTask: () => null,
      control: () => undefined,
      getEvents: () => [],
      streamEvents: async function* streamEvents() {},
      workbench,
    };

    const server = await createServer(mockKernel as any, { port: 0, host: '127.0.0.1' }, { workspaceRoot: root });
    servers.push(server);

    const previewResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent(previewPath)}`,
    });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.headers['content-type']).toContain('text/html');
    expect(previewResponse.body).toContain('<h1>Snake</h1>');

    const blockedResponse = await server.inject({
      method: 'GET',
      url: `/api/workbench/artifacts/preview?path=${encodeURIComponent('/etc/hosts')}`,
    });
    expect(blockedResponse.statusCode).toBe(403);
  });
});
