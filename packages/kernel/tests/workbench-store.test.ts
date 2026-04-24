import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkbenchTaskList } from '../src/workbench/workbench-projection.js';
import { WorkbenchStore } from '../src/workbench/workbench-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('WorkbenchStore', () => {
  it('persists tasks, sessions, timeline records, and decisions under .tik/workbench', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-store-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);

    await store.upsertTask({
      id: 'wb-task-1',
      title: 'Workbench',
      goal: 'Build the workbench',
      status: 'running',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
    });

    await store.upsertSession({
      id: 'wb-session-1',
      taskId: 'wb-task-1',
      status: 'running',
      owner: 'supervisor',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
    });

    await store.appendTimelineItem({
      id: 'msg-1',
      taskId: 'wb-task-1',
      kind: 'summary',
      actor: 'supervisor',
      body: 'Started work.',
      createdAt: '2026-04-09T00:00:01.000Z',
    });

    await store.appendDecision({
      id: 'decision-1',
      taskId: 'wb-task-1',
      title: 'Approve commit',
      summary: 'A commit is about to run.',
      risk: 'high',
      status: 'pending',
      options: [
        { id: 'approve', label: 'Approve', description: 'Allow the commit.', recommended: true },
        { id: 'reject', label: 'Reject', description: 'Keep the task paused.' },
      ],
      createdAt: '2026-04-09T00:00:02.000Z',
      updatedAt: '2026-04-09T00:00:02.000Z',
    });

    const snapshot = await store.readTaskBundle('wb-task-1');

    expect(snapshot.task?.title).toBe('Workbench');
    expect(snapshot.session?.owner).toBe('supervisor');
    expect(snapshot.timeline).toHaveLength(1);
    expect(await store.readPendingDecisions('wb-task-1')).toHaveLength(1);
    await expect(fs.readFile(path.join(root, '.tik', 'workbench', 'index.json'), 'utf-8')).resolves.toContain('"wb-task-1"');
    await expect(fs.readFile(path.join(root, '.tik', 'workbench', 'sessions', 'wb-session-1.json'), 'utf-8'))
      .resolves.toContain('"owner": "supervisor"');
    await expect(fs.readFile(path.join(root, '.tik', 'workbench', 'timelines', 'wb-task-1.jsonl'), 'utf-8'))
      .resolves.toContain('"msg-1"');
  });

  it('preserves both task and decision updates across concurrent index writes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-store-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);

    await runWithDelayedFirstIndexWrite(store, async () => Promise.all([
      store.upsertTask({
        id: 'wb-task-1',
        title: 'First task',
        goal: 'Keep first task',
        status: 'running',
        createdAt: '2026-04-09T00:00:00.000Z',
        updatedAt: '2026-04-09T00:00:00.000Z',
      }),
      store.upsertTask({
        id: 'wb-task-2',
        title: 'Second task',
        goal: 'Keep second task',
        status: 'running',
        createdAt: '2026-04-09T00:00:01.000Z',
        updatedAt: '2026-04-09T00:00:01.000Z',
      }),
    ]));

    expect((await store.listTasks()).map((task) => task.id).sort()).toEqual(['wb-task-1', 'wb-task-2']);

    await runWithDelayedFirstIndexWrite(store, async () => Promise.all([
      store.appendDecision({
        id: 'decision-1',
        taskId: 'wb-task-1',
        title: 'Approve task 1',
        summary: 'Keep the first decision.',
        risk: 'high',
        status: 'pending',
        options: [
          { id: 'approve', label: 'Approve', description: 'Approve task 1.', recommended: true },
        ],
        createdAt: '2026-04-09T00:00:02.000Z',
        updatedAt: '2026-04-09T00:00:02.000Z',
      }),
      store.appendDecision({
        id: 'decision-2',
        taskId: 'wb-task-1',
        title: 'Approve task 1 again',
        summary: 'Keep the second decision.',
        risk: 'high',
        status: 'pending',
        options: [
          { id: 'reject', label: 'Reject', description: 'Reject task 1.' },
        ],
        createdAt: '2026-04-09T00:00:03.000Z',
        updatedAt: '2026-04-09T00:00:03.000Z',
      }),
    ]));

    expect((await store.readPendingDecisions('wb-task-1')).map((decision) => decision.id).sort()).toEqual([
      'decision-1',
      'decision-2',
    ]);
  });

  it('tolerates malformed session snapshots and trailing partial timeline lines', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-workbench-store-'));
    tempDirs.push(root);
    const store = new WorkbenchStore(root);

    await store.upsertTask({
      id: 'wb-task-robust',
      title: 'Robust task',
      goal: 'Survive partial persistence',
      status: 'running',
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:00:00.000Z',
      activeSessionId: 'broken-session',
    });

    await fs.mkdir(path.join(root, '.tik', 'workbench', 'sessions'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'workbench', 'sessions', 'broken-session.json'), '{', 'utf-8');

    const goodTimelineItem = {
      id: 'msg-good',
      taskId: 'wb-task-robust',
      kind: 'summary',
      actor: 'supervisor',
      body: 'Still readable.',
      createdAt: '2026-04-09T00:00:01.000Z',
    };

    await fs.mkdir(path.join(root, '.tik', 'workbench', 'timelines'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.tik', 'workbench', 'timelines', 'wb-task-robust.jsonl'),
      `${JSON.stringify(goodTimelineItem)}\n{"id":"msg-partial"`,
      'utf-8',
    );

    const snapshot = await store.readTaskBundle('wb-task-robust');

    expect(snapshot.task?.id).toBe('wb-task-robust');
    expect(snapshot.session).toBeNull();
    expect(snapshot.timeline).toEqual([goodTimelineItem]);
  });
});

async function runWithDelayedFirstIndexWrite(
  store: WorkbenchStore,
  action: () => Promise<void>,
): Promise<void> {
  const storeWithPrivateMethods = store as unknown as {
    writeIndex: (index: unknown) => Promise<void>;
  };
  const originalWriteIndex = storeWithPrivateMethods.writeIndex.bind(store);
  let shouldDelayNextWrite = true;

  storeWithPrivateMethods.writeIndex = async (index) => {
    if (shouldDelayNextWrite) {
      shouldDelayNextWrite = false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await originalWriteIndex(index);
  };

  try {
    await action();
  } finally {
    storeWithPrivateMethods.writeIndex = originalWriteIndex;
  }
}

describe('buildWorkbenchTaskList', () => {
  it('sorts tasks by recent progress and attaches timeline counts', () => {
    const list = buildWorkbenchTaskList(
      [
        {
          id: 'older',
          title: 'Older task',
          goal: 'One',
          status: 'running',
          createdAt: '2026-04-09T00:00:00.000Z',
          updatedAt: '2026-04-09T00:00:10.000Z',
        },
        {
          id: 'newer',
          title: 'Newer task',
          goal: 'Two',
          status: 'verifying',
          createdAt: '2026-04-09T00:00:00.000Z',
          updatedAt: '2026-04-09T00:00:05.000Z',
          lastProgressAt: '2026-04-09T00:00:30.000Z',
        },
      ],
      new Map([
        ['older', [{ id: 'msg-1', taskId: 'older', kind: 'raw', actor: 'system', body: 'older', createdAt: '2026-04-09T00:00:11.000Z' }]],
        ['newer', [
          { id: 'msg-2', taskId: 'newer', kind: 'summary', actor: 'supervisor', body: 'a', createdAt: '2026-04-09T00:00:31.000Z' },
          { id: 'msg-3', taskId: 'newer', kind: 'raw', actor: 'system', body: 'b', createdAt: '2026-04-09T00:00:32.000Z' },
        ]],
      ]),
    );

    expect(list.map((task) => task.id)).toEqual(['newer', 'older']);
    expect(list[0]?.timelineCount).toBe(2);
    expect(list[1]?.timelineCount).toBe(1);
  });
});
