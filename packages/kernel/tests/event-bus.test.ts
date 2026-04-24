import { describe, expect, it } from 'vitest';
import { EventType } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';

describe('EventBus', () => {
  it('streams events for a single task through the task-specific stream', async () => {
    const bus = new EventBus();
    const iterator = bus.stream('task-1');

    const nextEvent = iterator.next();
    queueMicrotask(() => {
      bus.emit({
        id: 'evt-task-1',
        type: EventType.TASK_STARTED,
        taskId: 'task-1',
        payload: { status: 'executing', previousStatus: 'planning' },
        timestamp: Date.now(),
      });
    });

    const result = await nextEvent;
    expect(result.done).toBe(false);
    expect(result.value.taskId).toBe('task-1');

    await iterator.return?.(undefined);
  });

  it('streams events across all tasks through the global stream', async () => {
    const bus = new EventBus();
    const iterator = bus.streamAll();

    const nextEvent = iterator.next();
    queueMicrotask(() => {
      bus.emit({
        id: 'evt-global-1',
        type: EventType.TASK_STARTED,
        taskId: 'task-global-1',
        payload: { status: 'executing', previousStatus: 'planning' },
        timestamp: Date.now(),
      });
    });

    const result = await nextEvent;
    expect(result.done).toBe(false);
    expect(result.value.taskId).toBe('task-global-1');
    expect(result.value.type).toBe(EventType.TASK_STARTED);

    await iterator.return?.(undefined);
  });
});
