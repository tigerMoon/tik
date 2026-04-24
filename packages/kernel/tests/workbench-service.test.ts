import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventType } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { WorkbenchService } from '../src/workbench/workbench-service.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function readDecisionStatuses(root: string, taskId: string): Promise<string[]> {
  const indexPath = path.join(root, '.tik', 'workbench', 'index.json');
  const raw = await fs.readFile(indexPath, 'utf-8');
  const index = JSON.parse(raw) as {
    decisions: Array<{ taskId: string; status: string }>;
  };
  return index.decisions
    .filter((decision) => decision.taskId === taskId)
    .map((decision) => decision.status);
}

describe('WorkbenchService', () => {
  it('creates a summary timeline item from raw kernel events and requests decisions only for high-risk actions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const eventBus = new EventBus();
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({ title: 'Audit auth flow', goal: 'Inspect and update auth behavior' });
    const task = (await service.listTasks())[0]!;

    eventBus.emit({
      id: 'evt-1',
      type: EventType.TASK_STARTED,
      taskId: task.id,
      payload: { status: 'executing', previousStatus: 'planning' },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-2',
      type: EventType.TOOL_RESULT,
      taskId: task.id,
      payload: { toolName: 'read_file', output: 'auth.ts', durationMs: 12, success: true },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-3',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-4',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'read_file', toolType: 'read', input: { path: 'src/auth.ts' } },
      timestamp: Date.now(),
    });

    const timeline = await service.readTimeline(task.id);
    const decisions = await service.readPendingDecisions(task.id);

    expect(timeline.some((item) => item.kind === 'summary')).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.title).toContain('High-risk action');
    expect(decisions[0]?.title).not.toContain('read_file');
  });

  it('records raw evidence entries for tool results so the task pane has inspectable output', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const eventBus = new EventBus();
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({ title: 'Snake game', goal: 'Build an H5 playable snake game' }, 'task-raw');

    eventBus.emit({
      id: 'evt-raw-1',
      type: EventType.TOOL_RESULT,
      taskId: 'task-raw',
      payload: {
        toolName: 'write_file',
        output: 'Written 319 bytes',
        durationMs: 8,
        success: true,
        filesModified: ['/tmp/mock-app.html'],
      },
      timestamp: Date.now(),
    });

    const timeline = await service.readTimeline('task-raw');
    const rawItem = timeline.find((item) => item.kind === 'raw');
    const [task] = await service.listTasks();

    expect(rawItem?.body).toContain('write_file');
    expect(rawItem?.body).toContain('/tmp/mock-app.html');
    expect(rawItem?.body).toContain('Written 319 bytes');
    expect(task?.evidenceSummary).toEqual({
      rawEventCount: 1,
      modifiedFileCount: 1,
      previewableArtifactCount: 1,
      latestPreviewableArtifactPath: '/tmp/mock-app.html',
      latestPreviewableArtifactCreatedAt: expect.any(String),
      latestToolName: 'write_file',
      hasErrorEvidence: false,
    });
  });

  it('projects task evidence summaries for completed tasks so the queue can show acceptance signals', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const eventBus = new EventBus();
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({ title: 'Console polish', goal: 'Ship a previewable dashboard mock' }, 'task-summary');

    eventBus.emit({
      id: 'evt-summary-1',
      type: EventType.TOOL_RESULT,
      taskId: 'task-summary',
      payload: {
        toolName: 'write_file',
        output: 'Written 9012 bytes',
        durationMs: 14,
        success: true,
        filesModified: [
          '/Users/huyuehui/ace/tik/src/console.html',
          '/Users/huyuehui/ace/tik/src/styles.css',
        ],
      },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-summary-2',
      type: EventType.TASK_COMPLETED,
      taskId: 'task-summary',
      payload: { summary: 'Task completed' },
      timestamp: Date.now() + 1,
    });

    const task = await service.readTask('task-summary');

    expect(task?.status).toBe('completed');
    expect(task?.evidenceSummary).toEqual({
      rawEventCount: 1,
      modifiedFileCount: 2,
      previewableArtifactCount: 1,
      latestPreviewableArtifactPath: '/Users/huyuehui/ace/tik/src/console.html',
      latestPreviewableArtifactCreatedAt: expect.any(String),
      latestToolName: 'write_file',
      hasErrorEvidence: false,
    });
  });

  it('suppresses low-signal runtime noise and keeps operator-facing summaries concise', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const eventBus = new EventBus();
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({ title: 'Console audit', goal: 'Keep the task history readable' }, 'task-noise');

    eventBus.emit({
      id: 'evt-noise-1',
      type: EventType.SESSION_MESSAGE,
      taskId: 'task-noise',
      payload: { role: 'assistant', content: 'thinking' },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-noise-2',
      type: EventType.PLAN_GENERATED,
      taskId: 'task-noise',
      payload: {
        goals: ['Produce a reviewable artifact'],
        actionCount: 2,
      },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-noise-3',
      type: EventType.EVALUATION_STARTED,
      taskId: 'task-noise',
      payload: { iteration: 1 },
      timestamp: Date.now(),
    });

    const timeline = await service.readTimeline('task-noise');
    const summaryBodies = timeline
      .filter((item) => item.kind === 'summary')
      .map((item) => item.body);

    expect(summaryBodies).toEqual([
      'Supervisor drafted the next pass: Produce a reviewable artifact (2 planned actions).',
    ]);
  });

  it('updates the active session to the runtime session when the kernel opens one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);
    const eventBus = new EventBus();
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    const primedTask = await service.createTask({ title: 'Audit auth flow', goal: 'Inspect and update auth behavior' }, 'task-1');

    eventBus.emit({
      id: 'evt-session',
      type: EventType.SESSION_STARTED,
      taskId: primedTask.id,
      payload: { sessionId: 'session-real', mode: 'single', agents: ['planner'], currentAgent: 'planner' },
      timestamp: Date.now(),
    });

    const tasks = await service.listTasks();
    expect(tasks[0]?.activeSessionId).toBe('session-real');
  });

  it('persists the task-bound environment pack snapshot on create and task-created hydration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });
    const taskManager = new TaskManager(eventBus);

    await service.createTask({
      title: 'Implement checkout flow',
      goal: 'Ship the checkout flow',
      environmentPackSnapshot: {
        id: 'commerce-ops',
        name: 'Commerce Ops',
        version: '0.2.0',
      },
      environmentPackSelection: {
        selectedSkills: ['release-review'],
        selectedKnowledgeIds: ['operations-runbook'],
      },
    }, 'task-manual');

    taskManager.create({
      description: 'Hydrate imported task',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder'],
        selectedKnowledgeIds: ['repo-index'],
      },
    });

    const tasks = await service.listTasks();
    expect(tasks.find((task) => task.id === 'task-manual')?.environmentPackSnapshot?.id).toBe('commerce-ops');
    expect(tasks.find((task) => task.id === 'task-manual')?.environmentPackSelection).toEqual({
      selectedSkills: ['release-review'],
      selectedKnowledgeIds: ['operations-runbook'],
    });
    expect(tasks.find((task) => task.title === 'Hydrate imported task')?.environmentPackSnapshot?.id).toBe('base-engineering');
    expect(tasks.find((task) => task.title === 'Hydrate imported task')?.environmentPackSelection).toEqual({
      selectedSkills: ['coder'],
      selectedKnowledgeIds: ['repo-index'],
    });
  });

  it('updates task-level environment pack skill and knowledge selections', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Configure runtime',
      goal: 'Narrow the task capabilities',
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

    const updated = await service.updateTaskConfiguration('task-config', {
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });

    expect(updated?.environmentPackSelection).toEqual({
      selectedSkills: ['ui-review'],
      selectedKnowledgeIds: ['ui-guidelines'],
    });

    const timeline = await service.readTimeline('task-config');
    expect(timeline.some((item) => item.body.includes('Updated task configuration'))).toBe(true);
  });

  it('rebinds a task to a different environment pack when configuration changes packs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Retarget runtime',
      goal: 'Switch this task into another execution pack',
      environmentPackSnapshot: {
        id: 'base-engineering',
        name: 'Base Engineering',
        version: '0.1.0',
      },
      environmentPackSelection: {
        selectedSkills: ['coder'],
        selectedKnowledgeIds: ['repo-index'],
      },
    }, 'task-rebind');

    const updated = await service.updateTaskConfiguration(
      'task-rebind',
      {
        selectedSkills: ['figma-to-react'],
        selectedKnowledgeIds: ['design-system'],
      },
      {
        id: 'design-to-code',
        name: 'Design To Code',
        version: '0.1.0',
      },
    );

    expect(updated?.environmentPackSnapshot).toEqual({
      id: 'design-to-code',
      name: 'Design To Code',
      version: '0.1.0',
    });
    expect(updated?.environmentPackSelection).toEqual({
      selectedSkills: ['figma-to-react'],
      selectedKnowledgeIds: ['design-system'],
    });
    expect(updated?.latestSummary).toContain('Rebound task to design-to-code');
  });

  it('updates the task brief and records the operator adjustment in the timeline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Snake game',
      goal: 'Build a playable snake game',
    }, 'task-brief');

    const updated = await service.updateTaskBrief('task-brief', {
      title: 'Snake game console',
      goal: 'Build a playable snake game with a clear score panel',
      adjustment: 'Focus on keyboard play and a visible restart action.',
    });

    expect(updated?.title).toBe('Snake game console');
    expect(updated?.goal).toContain('clear score panel');
    expect(updated?.latestSummary).toContain('Operator adjusted');

    const timeline = await service.readTimeline('task-brief');
    const operatorEntry = timeline.find((item) => item.actor === 'user');
    expect(operatorEntry?.body).toContain('Adjusted task brief');
    expect(operatorEntry?.body).toContain('Focus on keyboard play');
  });

  it('reverts the last task adjustment and restores the prior title and brief', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Original brief',
      goal: 'Ship the original scope',
    }, 'task-revert');

    await service.updateTaskBrief('task-revert', {
      title: 'Adjusted brief',
      goal: 'Ship the adjusted scope',
      adjustment: 'Tighten the work around a previewable artifact.',
    });

    const reverted = await service.revertLastTaskAdjustment('task-revert');
    expect(reverted?.title).toBe('Original brief');
    expect(reverted?.goal).toBe('Ship the original scope');
    expect(reverted?.lastAdjustment).toBeUndefined();

    const timeline = await service.readTimeline('task-revert');
    expect(timeline.some((item) => item.body.includes('Reverted latest task adjustment.'))).toBe(true);
  });

  it('can force-archive a stale running task when the runtime record is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    const task = await service.createTask({
      title: 'Stale running task',
      goal: 'Clean up an orphaned runtime record',
    }, 'task-stale');

    await store.upsertTask({
      ...task,
      status: 'running',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
      latestSummary: 'Supervisor observed event iteration.completed.',
    });

    await expect(service.archiveTask('task-stale')).rejects.toThrow('cannot be archived');

    const archived = await service.archiveTask('task-stale', { force: true });
    expect(archived?.status).toBe('archived');
    expect(archived?.latestSummary).toContain('runtime record went missing');

    const timeline = await service.readTimeline('task-stale');
    expect(timeline.some((item) => item.body.includes('runtime record went missing'))).toBe(true);
  });

  it('requests and resolves a high-risk tool approval through the workbench service', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Publish dry-run',
      goal: 'Validate the operator approval loop',
    }, 'task-decision');

    const decision = await service.requestToolApproval('task-decision', 'bash');
    expect(decision?.status).toBe('pending');

    const pendingTask = await service.readTask('task-decision');
    expect(pendingTask?.status).toBe('waiting_for_user');
    expect(pendingTask?.waitingDecisionId).toBe(decision?.id);

    const waitPromise = service.waitForDecisionResolution(decision!.id, { pollMs: 10, timeoutMs: 1000 });
    await service.resolveDecision('task-decision', decision!.id, {
      optionId: 'approve',
      message: 'Proceed with the publish dry-run.',
    });
    const resolution = await waitPromise;

    expect(resolution.approved).toBe(true);

    const resolvedTask = await service.readTask('task-decision');
    expect(resolvedTask?.status).toBe('running');
    expect(resolvedTask?.waitingDecisionId).toBeUndefined();

    const timeline = await service.readTimeline('task-decision');
    expect(timeline.some((item) => item.body.includes('Approved decision: High-risk action: bash'))).toBe(true);
  });

  it('projects tasks with pending decisions back into waiting_for_user even if a later runtime event stored them as running', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Publish dry-run',
      goal: 'Validate projected waiting state',
    }, 'task-projected-wait');

    const decision = await service.requestToolApproval('task-projected-wait', 'bash');
    expect(decision?.status).toBe('pending');

    await store.upsertTask({
      ...(await service.readTask('task-projected-wait'))!,
      status: 'running',
      waitingReason: undefined,
      waitingDecisionId: undefined,
      latestSummary: 'Supervisor resumed task execution.',
      updatedAt: '2026-04-09T00:00:01.000Z',
      lastProgressAt: '2026-04-09T00:00:01.000Z',
    });

    const projected = await service.readTask('task-projected-wait');
    expect(projected?.status).toBe('waiting_for_user');
    expect(projected?.waitingDecisionId).toBe(decision?.id);
    expect(projected?.waitingReason).toContain('bash');
    expect(projected?.latestSummary).toContain('Waiting for operator approval');
  });

  it('hydrates workbench tasks from the kernel task event path and records timeline summaries and decisions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });
    const taskManager = new TaskManager(eventBus);

    const task = taskManager.create({ description: 'Audit auth flow' });

    eventBus.emit({
      id: 'evt-5',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
      timestamp: Date.now(),
    });

    const tasks = await service.listTasks();
    const timeline = await service.readTimeline(task.id);
    const decisions = await service.readPendingDecisions(task.id);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
    expect(tasks[0]?.title).toBe('Audit auth flow');
    expect(timeline.some((item) => item.kind === 'summary')).toBe(true);
    expect(decisions).toHaveLength(1);
  });

  it('keeps waiting metadata while a pending decision receives non-terminal runtime events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });
    const taskManager = new TaskManager(eventBus);

    const task = taskManager.create({ description: 'Audit auth flow' });

    eventBus.emit({
      id: 'evt-6',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
      timestamp: Date.now(),
    });

    let tasks = await service.listTasks();
    expect(tasks[0]?.status).toBe('waiting_for_user');
    expect(tasks[0]?.waitingReason).toContain('git_commit');
    expect(tasks[0]?.waitingDecisionId).toBeTruthy();

    eventBus.emit({
      id: 'evt-7',
      type: EventType.TASK_STARTED,
      taskId: task.id,
      payload: { status: 'executing', previousStatus: 'planning' },
      timestamp: Date.now(),
    });

    tasks = await service.listTasks();
    const decisions = await service.readPendingDecisions(task.id);
    const decisionStatuses = await readDecisionStatuses(root, task.id);
    expect(tasks[0]?.status).toBe('waiting_for_user');
    expect(tasks[0]?.waitingReason).toContain('git_commit');
    expect(tasks[0]?.waitingDecisionId).toBeTruthy();
    expect(decisions).toHaveLength(1);
    expect(decisionStatuses).toContain('pending');
    expect(decisionStatuses).not.toContain('dismissed');
    expect(decisionStatuses).not.toContain('resolved');
  });

  it('dismisses the waiting decision when a waiting task is cancelled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });
    const taskManager = new TaskManager(eventBus);

    const task = taskManager.create({ description: 'Audit auth flow' });

    eventBus.emit({
      id: 'evt-8',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-9',
      type: EventType.TASK_CANCELLED,
      taskId: task.id,
      payload: { status: 'cancelled', previousStatus: 'planning' },
      timestamp: Date.now(),
    });

    const tasks = await service.listTasks();
    const decisions = await service.readPendingDecisions(task.id);
    const decisionStatuses = await readDecisionStatuses(root, task.id);

    expect(tasks[0]?.status).toBe('cancelled');
    expect(tasks[0]?.waitingReason).toBeUndefined();
    expect(tasks[0]?.waitingDecisionId).toBeUndefined();
    expect(decisions).toHaveLength(0);
    expect(decisionStatuses).toContain('dismissed');
    expect(decisionStatuses).not.toContain('resolved');
  });

  it('dismisses the waiting decision when a high-risk tool errors after requesting approval', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });
    const taskManager = new TaskManager(eventBus);

    const task = taskManager.create({ description: 'Audit auth flow' });

    eventBus.emit({
      id: 'evt-10',
      type: EventType.TOOL_CALLED,
      taskId: task.id,
      payload: { toolName: 'git_commit', toolType: 'exec', input: { message: 'ship it' } },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-11',
      type: EventType.TOOL_ERROR,
      taskId: task.id,
      payload: { toolName: 'git_commit', error: 'commit failed', success: false },
      timestamp: Date.now(),
    });

    const tasks = await service.listTasks();
    const decisions = await service.readPendingDecisions(task.id);
    const decisionStatuses = await readDecisionStatuses(root, task.id);

    expect(tasks[0]?.status).not.toBe('waiting_for_user');
    expect(tasks[0]?.waitingReason).toBeUndefined();
    expect(tasks[0]?.waitingDecisionId).toBeUndefined();
    expect(decisions).toHaveLength(0);
    expect(decisionStatuses).toContain('dismissed');
    expect(decisionStatuses).not.toContain('resolved');
  });

  it('keeps workbench status paused until an explicit resume or terminal event arrives', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({ title: 'Pause drift', goal: 'Ensure paused state is sticky' }, 'task-pause');

    eventBus.emit({
      id: 'evt-pause-1',
      type: EventType.TASK_PAUSED,
      taskId: 'task-pause',
      payload: { status: 'paused', previousStatus: 'executing' },
      timestamp: Date.now(),
    });

    eventBus.emit({
      id: 'evt-pause-2',
      type: EventType.EVALUATION_STARTED,
      taskId: 'task-pause',
      payload: { iteration: 1 },
      timestamp: Date.now(),
    });

    let task = await service.readTask('task-pause');
    expect(task?.status).toBe('paused');

    eventBus.emit({
      id: 'evt-pause-3',
      type: EventType.TASK_RESUMED,
      taskId: 'task-pause',
      payload: { status: 'executing', previousStatus: 'paused' },
      timestamp: Date.now(),
    });

    task = await service.readTask('task-pause');
    expect(task?.status).toBe('running');
  });

  it('ignores late runtime events after a task has been archived so terminal tasks stay frozen', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-service-'));
    tempDirs.push(root);
    const eventBus = new EventBus();
    const store = new WorkbenchStore(root);
    const service = new WorkbenchService({ rootPath: root, eventBus, store });

    await service.createTask({
      title: 'Frozen archive',
      goal: 'Do not let late runtime events revive an archived task',
    }, 'task-frozen');

    await service.archiveTask('task-frozen');

    eventBus.emit({
      id: 'evt-late-tool-error',
      type: EventType.TOOL_ERROR,
      taskId: 'task-frozen',
      payload: {
        toolName: 'bash',
        error: 'late error from stale runtime',
        success: false,
      },
      timestamp: Date.now(),
    });

    const task = await service.readTask('task-frozen');
    const timeline = await service.readTimeline('task-frozen');

    expect(task?.status).toBe('archived');
    expect(task?.latestSummary).toBe('Task archived from the active work queue.');
    expect(timeline.some((item) => item.body.includes('late error from stale runtime'))).toBe(false);
  });
});
