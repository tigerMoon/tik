/**
 * EventBus Implementation
 *
 * Central event system for Tik.
 * All state changes flow through this bus for observability.
 */
import type { AgentEvent, EventType, EventHandler, UnsubscribeFn, IEventBus } from '@tik/shared';
export interface EventBusOptions {
    maxHistoryPerTask?: number;
}
export declare class EventBus implements IEventBus {
    private emitter;
    private eventHistory;
    private streams;
    private globalStreams;
    private maxHistoryPerTask;
    constructor(options?: EventBusOptions);
    emit(event: AgentEvent): void;
    on(type: EventType, handler: EventHandler): UnsubscribeFn;
    onAny(handler: EventHandler): UnsubscribeFn;
    stream(taskId: string): AsyncIterableIterator<AgentEvent>;
    streamAll(): AsyncIterableIterator<AgentEvent>;
    history(taskId: string): AgentEvent[];
    dispose(): void;
}
//# sourceMappingURL=event-bus.d.ts.map