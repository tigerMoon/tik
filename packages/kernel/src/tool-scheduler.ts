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
      ...buildToolCallAuditPayload(toolName, input, context),
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
        ...buildToolResultAuditPayload(toolName, result),
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

      await this.executeReadyActions(ready, actions, results, completed, context);
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

  private async executeReadyActions(
    ready: number[],
    actions: Array<{ toolName: string; input: unknown; dependsOn?: number[] }>,
    results: ToolResult[],
    completed: Set<number>,
    context: ToolContext,
  ): Promise<void> {
    let cursor = 0;
    let readParallelAllowed = true;

    while (cursor < ready.length) {
      const actionIndex = ready[cursor];
      const tool = this.registry.get(actions[actionIndex].toolName);

      if (readParallelAllowed && tool?.type === 'read') {
        const readBatch: number[] = [];
        while (cursor < ready.length) {
          const readIndex = ready[cursor];
          const readTool = this.registry.get(actions[readIndex].toolName);
          if (readTool?.type !== 'read') break;
          readBatch.push(readIndex);
          cursor += 1;
        }

        const readResults = await Promise.all(
          readBatch.map((i) => this.execute(actions[i].toolName, actions[i].input, context)),
        );
        readBatch.forEach((i, resultIndex) => {
          results[i] = readResults[resultIndex];
          completed.add(i);
        });
        continue;
      }

      readParallelAllowed = false;
      results[actionIndex] = await this.execute(actions[actionIndex].toolName, actions[actionIndex].input, context);
      completed.add(actionIndex);
      cursor += 1;
    }
  }

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

function buildToolCallAuditPayload(
  toolName: string,
  input: unknown,
  context: ToolContext,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cwd: context.cwd,
    envDiff: context.env || {},
  };

  if (toolName !== 'bash') {
    return payload;
  }

  const command = input && typeof input === 'object' && 'command' in input
    ? (input as { command?: unknown }).command
    : undefined;

  return {
    ...payload,
    command: typeof command === 'string' ? command : undefined,
  };
}

function buildToolResultAuditPayload(toolName: string, result: ToolResult): Record<string, unknown> {
  void toolName;
  if (!result.output || typeof result.output !== 'object') {
    return {};
  }

  const output = result.output as { stdout?: unknown; stderr?: unknown };
  return {
    stdoutSummary: summarizeStream(output.stdout),
    stderrSummary: summarizeStream(output.stderr),
  };
}

function summarizeStream(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  const LIMIT = 512;
  return normalized.length > LIMIT
    ? `${normalized.slice(0, LIMIT)}\n[... truncated, ${normalized.length} bytes total]`
    : normalized;
}
