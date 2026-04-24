/**
 * Tool Registry & Scheduler
 *
 * Manages tool registration and execution scheduling.
 * - READ tools: parallel execution
 * - WRITE tools: serial execution
 * - EXEC tools: blocking execution
 */

import type {
  Tool,
  ToolType,
  ToolResult,
  ToolContext,
  IToolRegistry,
  IToolScheduler,
  IEventBus,
  AgentEvent,
} from '@tik/shared';
import { EventType, generateId, now } from '@tik/shared';

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

// ─── Tool Registry ───────────────────────────────────────────

export class ToolRegistry implements IToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

// ─── Tool Scheduler ──────────────────────────────────────────

export class ToolScheduler implements IToolScheduler {
  private registry: ToolRegistry;
  private eventBus: IEventBus;
  private writeQueue: Promise<void> = Promise.resolve();
  private activeExec: AbortController | null = null;
  private awaitToolApproval?: ToolSchedulerOptions['awaitToolApproval'];

  constructor(registry: ToolRegistry, eventBus: IEventBus, options: ToolSchedulerOptions = {}) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.awaitToolApproval = options.awaitToolApproval;
  }

  async execute(toolName: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: null,
        error: `Tool "${toolName}" not found`,
        durationMs: 0,
      };
    }

    const start = Date.now();
    let result: ToolResult;
    let approval: ToolApprovalResolution | null = null;

    if (this.awaitToolApproval) {
      try {
        approval = await this.awaitToolApproval({
          taskId: context.taskId,
          toolName,
          input,
        });
      } catch (err) {
        approval = {
          decisionId: generateId(),
          approved: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Emit tool called event
    this.emitEvent(EventType.TOOL_CALLED, context.taskId, {
      toolName,
      toolType: tool.type,
      input,
      approvalDecisionId: approval?.decisionId,
    });

    if (approval && !approval.approved) {
      result = {
        success: false,
        output: null,
        error: approval.message?.trim() || `High-risk action rejected by operator for ${toolName}.`,
        durationMs: Date.now() - start,
      };
    } else {
      try {
        switch (tool.type) {
          case 'read':
            result = await tool.execute(input, context);
            break;
          case 'write':
            result = await this.executeSerial(tool, input, context);
            break;
          case 'exec':
            result = await this.executeBlocking(tool, input, context);
            break;
          default:
            result = await tool.execute(input, context);
        }
      } catch (err) {
        result = {
          success: false,
          output: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        };
      }
    }

    // Emit tool result event (truncate large output for event stream)
    const outputStr = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const EVENT_OUTPUT_LIMIT = 2048;
    const eventOutput = outputStr && outputStr.length > EVENT_OUTPUT_LIMIT
      ? outputStr.slice(0, EVENT_OUTPUT_LIMIT) + `\n[... truncated, ${outputStr.length} bytes total]`
      : result.output;

    this.emitEvent(
      result.success ? EventType.TOOL_RESULT : EventType.TOOL_ERROR,
      context.taskId,
      {
        toolName,
        output: eventOutput,
        durationMs: result.durationMs,
        success: result.success,
        error: result.error,
        filesModified: result.filesModified,
        truncated: outputStr ? outputStr.length > EVENT_OUTPUT_LIMIT : false,
        originalSize: outputStr ? outputStr.length : 0,
      },
    );

    return result;
  }

  async executeBatch(
    actions: Array<{ toolName: string; input: unknown; dependsOn?: number[] }>,
    context: ToolContext,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(actions.length);
    const completed = new Set<number>();

    // Group actions by dependency level
    while (completed.size < actions.length) {
      const ready: number[] = [];

      for (let i = 0; i < actions.length; i++) {
        if (completed.has(i)) continue;
        const deps = actions[i].dependsOn || [];
        if (deps.every(d => completed.has(d))) {
          ready.push(i);
        }
      }

      if (ready.length === 0) {
        // Deadlock - remaining actions have unresolvable dependencies
        for (let i = 0; i < actions.length; i++) {
          if (!completed.has(i)) {
            results[i] = {
              success: false,
              output: null,
              error: 'Deadlock: unresolvable dependency',
              durationMs: 0,
            };
          }
        }
        break;
      }

      // Execute ready actions (parallel for reads, serial for writes)
      const readActions = ready.filter(i => {
        const tool = this.registry.get(actions[i].toolName);
        return tool?.type === 'read';
      });
      const otherActions = ready.filter(i => !readActions.includes(i));

      // Run reads in parallel
      if (readActions.length > 0) {
        const readResults = await Promise.all(
          readActions.map(i =>
            this.execute(actions[i].toolName, actions[i].input, context),
          ),
        );
        readActions.forEach((actionIdx, resultIdx) => {
          results[actionIdx] = readResults[resultIdx];
          completed.add(actionIdx);
        });
      }

      // Run writes/execs serially
      for (const i of otherActions) {
        results[i] = await this.execute(actions[i].toolName, actions[i].input, context);
        completed.add(i);
      }
    }

    return results;
  }

  async cancelAll(): Promise<void> {
    if (this.activeExec) {
      this.activeExec.abort();
      this.activeExec = null;
    }
  }

  // ─── Private Methods ──────────────────────────────────────

  private executeSerial(tool: Tool, input: unknown, context: ToolContext): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      this.writeQueue = this.writeQueue.then(async () => {
        const result = await tool.execute(input, context);
        resolve(result);
      });
    });
  }

  private async executeBlocking(tool: Tool, input: unknown, context: ToolContext): Promise<ToolResult> {
    this.activeExec = new AbortController();
    const execContext = { ...context, signal: this.activeExec.signal };
    try {
      return await tool.execute(input, execContext);
    } finally {
      this.activeExec = null;
    }
  }

  private emitEvent(type: EventType, taskId: string, payload: unknown): void {
    this.eventBus.emit({
      id: generateId(),
      type,
      taskId,
      payload,
      timestamp: now(),
    });
  }
}
