/**
 * Tool Registry & Scheduler
 *
 * Manages tool registration and execution scheduling.
 * - READ tools: parallel execution
 * - WRITE tools: serial execution
 * - EXEC tools: blocking execution
 *
 * Batch execution preserves action order around side effects: leading reads in
 * a dependency level may run in parallel, then the first write/exec and every
 * following action in that level runs serially.
 */
import type { Tool, ToolResult, ToolContext, IToolRegistry, IToolScheduler, IEventBus } from '@tik/shared';
interface ToolApprovalResolution {
    decisionId: string;
    approved: boolean;
    optionId?: string;
    message?: string;
}
interface ToolSchedulerOptions {
    awaitToolApproval?: (input: {
        taskId: string;
        toolName: string;
        input: unknown;
    }) => Promise<ToolApprovalResolution | null>;
}
export declare class ToolRegistry implements IToolRegistry {
    private tools;
    register(tool: Tool): void;
    get(name: string): Tool | undefined;
    list(): Tool[];
    has(name: string): boolean;
}
export declare class ToolScheduler implements IToolScheduler {
    private registry;
    private eventBus;
    private writeQueue;
    private activeExec;
    private awaitToolApproval?;
    constructor(registry: ToolRegistry, eventBus: IEventBus, options?: ToolSchedulerOptions);
    execute(toolName: string, input: unknown, context: ToolContext): Promise<ToolResult>;
    executeBatch(actions: Array<{
        toolName: string;
        input: unknown;
        dependsOn?: number[];
    }>, context: ToolContext): Promise<ToolResult[]>;
    cancelAll(): Promise<void>;
    private executeReadyActions;
    private executeSerial;
    private executeBlocking;
    private emitEvent;
}
export {};
//# sourceMappingURL=tool-scheduler.d.ts.map