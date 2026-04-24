import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { EventType } from '@tik/shared';

describe('TaskManager', () => {
  function createManager() {
    const eventBus = new EventBus();
    const manager = new TaskManager(eventBus);
    return { manager, eventBus };
  }

  it('creates a task with pending status', () => {
    const { manager } = createManager();
    const task = manager.create({ description: 'test task' });
    expect(task.status).toBe('pending');
    expect(task.description).toBe('test task');
    expect(task.id).toBeTruthy();
  });

  it('follows valid state transitions', () => {
    const { manager } = createManager();
    const task = manager.create({ description: 'test' });

    manager.updateStatus(task.id, 'planning');
    expect(manager.get(task.id)!.status).toBe('planning');

    manager.updateStatus(task.id, 'executing');
    expect(manager.get(task.id)!.status).toBe('executing');

    manager.updateStatus(task.id, 'evaluating');
    expect(manager.get(task.id)!.status).toBe('evaluating');

    manager.updateStatus(task.id, 'converged');
    expect(manager.get(task.id)!.status).toBe('converged');
  });

  it('rejects invalid transitions', () => {
    const { manager } = createManager();
    const task = manager.create({ description: 'test' });

    expect(() => manager.updateStatus(task.id, 'converged')).toThrow('Invalid transition');
    expect(() => manager.updateStatus(task.id, 'executing')).toThrow('Invalid transition');
  });

  it('supports paused state', () => {
    const { manager } = createManager();
    const task = manager.create({ description: 'test' });

    manager.updateStatus(task.id, 'planning');
    manager.updateStatus(task.id, 'paused');
    expect(manager.get(task.id)!.status).toBe('paused');

    manager.updateStatus(task.id, 'executing');
    expect(manager.get(task.id)!.status).toBe('executing');
  });

  it('emits correct previousStatus in events', () => {
    const { manager, eventBus } = createManager();
    const events: Array<{ status: string; previousStatus: string }> = [];

    eventBus.onAny((e) => {
      const p = e.payload as { status?: string; previousStatus?: string };
      if (p?.previousStatus !== undefined) {
        events.push({ status: p.status!, previousStatus: p.previousStatus });
      }
    });

    const task = manager.create({ description: 'test' });
    manager.updateStatus(task.id, 'planning');
    manager.updateStatus(task.id, 'executing');

    expect(events[0]).toEqual({ status: 'planning', previousStatus: 'pending' });
    expect(events[1]).toEqual({ status: 'executing', previousStatus: 'planning' });
  });

  it('emits TASK_RESUMED when going from paused to executing', () => {
    const { manager, eventBus } = createManager();
    const types: string[] = [];
    eventBus.onAny((e) => types.push(e.type));

    const task = manager.create({ description: 'test' });
    manager.updateStatus(task.id, 'planning');
    manager.updateStatus(task.id, 'paused');
    types.length = 0; // clear

    manager.updateStatus(task.id, 'executing');
    expect(types).toContain(EventType.TASK_RESUMED);
  });

  it('terminal states reject all transitions', () => {
    const { manager } = createManager();

    // converged is terminal
    const t1 = manager.create({ description: 'test' });
    manager.updateStatus(t1.id, 'planning');
    manager.updateStatus(t1.id, 'executing');
    manager.updateStatus(t1.id, 'evaluating');
    manager.updateStatus(t1.id, 'converged');
    expect(() => manager.updateStatus(t1.id, 'executing')).toThrow();

    // failed is terminal
    const t2 = manager.create({ description: 'test' });
    manager.updateStatus(t2.id, 'planning');
    manager.updateStatus(t2.id, 'failed');
    expect(() => manager.updateStatus(t2.id, 'planning')).toThrow();
  });
});

describe('EventBus', () => {
  it('emits and receives events', () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on(EventType.TASK_CREATED, (e) => received.push(e.type));

    bus.emit({
      id: '1', type: EventType.TASK_CREATED, taskId: 't1',
      payload: {}, timestamp: Date.now(),
    });

    expect(received).toEqual([EventType.TASK_CREATED]);
  });

  it('stores event history by taskId', () => {
    const bus = new EventBus();
    bus.emit({ id: '1', type: EventType.TASK_CREATED, taskId: 't1', payload: {}, timestamp: 1 });
    bus.emit({ id: '2', type: EventType.TASK_CREATED, taskId: 't2', payload: {}, timestamp: 2 });
    bus.emit({ id: '3', type: EventType.TOOL_CALLED, taskId: 't1', payload: {}, timestamp: 3 });

    expect(bus.history('t1')).toHaveLength(2);
    expect(bus.history('t2')).toHaveLength(1);
    expect(bus.history('t3')).toHaveLength(0);
  });

  it('onAny receives all events', () => {
    const bus = new EventBus();
    const all: string[] = [];
    bus.onAny((e) => all.push(e.type));

    bus.emit({ id: '1', type: EventType.TASK_CREATED, taskId: 't1', payload: {}, timestamp: 1 });
    bus.emit({ id: '2', type: EventType.TOOL_CALLED, taskId: 't1', payload: {}, timestamp: 2 });

    expect(all).toEqual([EventType.TASK_CREATED, EventType.TOOL_CALLED]);
  });

  it('unsubscribe works', () => {
    const bus = new EventBus();
    const received: string[] = [];
    const unsub = bus.on(EventType.TASK_CREATED, (e) => received.push(e.type));

    bus.emit({ id: '1', type: EventType.TASK_CREATED, taskId: 't1', payload: {}, timestamp: 1 });
    unsub();
    bus.emit({ id: '2', type: EventType.TASK_CREATED, taskId: 't1', payload: {}, timestamp: 2 });

    expect(received).toHaveLength(1);
  });
});
