/**
 * EventBus Implementation
 *
 * Central event system for Tik.
 * All state changes flow through this bus for observability.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  EventType,
  EventHandler,
  UnsubscribeFn,
  IEventBus,
} from '@tik/shared';
import { generateId } from '@tik/shared';

export interface EventBusOptions {
  maxHistoryPerTask?: number;
}

export class EventBus implements IEventBus {
  private emitter: EventEmitter;
  private eventHistory: Map<string, AgentEvent[]>;
  private streams: Map<string, Set<(event: AgentEvent) => void>>;
  private globalStreams: Set<(event: AgentEvent) => void>;
  private maxHistoryPerTask: number;

  constructor(options: EventBusOptions = {}) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100); // Allow many subscribers
    this.eventHistory = new Map();
    this.streams = new Map();
    this.globalStreams = new Set();
    this.maxHistoryPerTask = options.maxHistoryPerTask ?? 1000;
  }

  emit(event: AgentEvent): void {
    // Store in history
    if (!this.eventHistory.has(event.taskId)) {
      this.eventHistory.set(event.taskId, []);
    }
    const history = this.eventHistory.get(event.taskId)!;
    history.push(event);
    if (history.length > this.maxHistoryPerTask) {
      history.splice(0, history.length - this.maxHistoryPerTask);
    }

    // Emit to type-specific subscribers
    this.emitter.emit(event.type, event);

    // Emit to wildcard subscribers
    this.emitter.emit('*', event);

    // Emit to task-specific streams
    const taskStreams = this.streams.get(event.taskId);
    if (taskStreams) {
      for (const callback of taskStreams) {
        callback(event);
      }
    }

    for (const callback of this.globalStreams) {
      callback(event);
    }
  }

  on(type: EventType, handler: EventHandler): UnsubscribeFn {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  onAny(handler: EventHandler): UnsubscribeFn {
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }

  async *stream(taskId: string): AsyncIterableIterator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    // Create stream callback
    const callback = (event: AgentEvent) => {
      if (done) return;
      queue.push(event);
      notify?.();
      notify = null;
    };

    // Register stream
    if (!this.streams.has(taskId)) {
      this.streams.set(taskId, new Set());
    }
    this.streams.get(taskId)!.add(callback);

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((res) => {
            notify = res;
          });
        }

        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      // Cleanup
      done = true;
      this.streams.get(taskId)?.delete(callback);
      if (this.streams.get(taskId)?.size === 0) {
        this.streams.delete(taskId);
      }
    }
  }

  async *streamAll(): AsyncIterableIterator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let notify: (() => void) | null = null;
    let done = false;

    const callback = (event: AgentEvent) => {
      if (done) return;
      queue.push(event);
      notify?.();
      notify = null;
    };

    this.globalStreams.add(callback);

    try {
      while (!done) {
        if (queue.length === 0) {
          await new Promise<void>((res) => {
            notify = res;
          });
        }

        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      done = true;
      this.globalStreams.delete(callback);
    }
  }

  history(taskId: string): AgentEvent[] {
    return this.eventHistory.get(taskId) || [];
  }

  dispose(): void {
    this.emitter.removeAllListeners();
    this.eventHistory.clear();
    this.streams.clear();
    this.globalStreams.clear();
  }
}
