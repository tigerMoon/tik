import { describe, expect, it } from 'vitest';
import { EventType } from '@tik/shared';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';

describe('ToolScheduler approval gating', () => {
  it('waits for approval before executing a gated tool and annotates the tool-called event', async () => {
    const eventBus = new EventBus();
    const registry = new ToolRegistry();
    let executed = false;

    registry.register({
      name: 'bash',
      description: 'execute shell command',
      type: 'exec',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } } as any,
      async execute() {
        executed = true;
        return {
          success: true,
          output: 'publish dry-run',
          durationMs: 1,
        };
      },
    } as any);

    const scheduler = new ToolScheduler(registry, eventBus, {
      awaitToolApproval: async ({ toolName }) => {
        if (toolName !== 'bash') {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          decisionId: 'decision-approve',
          approved: true,
        };
      },
    });

    const result = await scheduler.execute('bash', { command: 'echo publish dry-run' }, {
      cwd: '/tmp',
      taskId: 'task-approval',
    });

    expect(result.success).toBe(true);
    expect(executed).toBe(true);

    const history = eventBus.history('task-approval');
    const toolCalled = history.find((event) => event.type === EventType.TOOL_CALLED);
    expect(toolCalled?.payload).toMatchObject({
      toolName: 'bash',
      approvalDecisionId: 'decision-approve',
    });
  });

  it('returns a rejected tool result when the operator denies a gated action', async () => {
    const eventBus = new EventBus();
    const registry = new ToolRegistry();
    let executed = false;

    registry.register({
      name: 'bash',
      description: 'execute shell command',
      type: 'exec',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } } as any,
      async execute() {
        executed = true;
        return {
          success: true,
          output: 'should not run',
          durationMs: 1,
        };
      },
    } as any);

    const scheduler = new ToolScheduler(registry, eventBus, {
      awaitToolApproval: async ({ toolName }) => {
        if (toolName !== 'bash') {
          return null;
        }
        return {
          decisionId: 'decision-reject',
          approved: false,
          message: 'Operator rejected the publish step.',
        };
      },
    });

    const result = await scheduler.execute('bash', { command: 'echo publish dry-run' }, {
      cwd: '/tmp',
      taskId: 'task-rejection',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Operator rejected');
    expect(executed).toBe(false);

    const history = eventBus.history('task-rejection');
    expect(history.some((event) => event.type === EventType.TOOL_ERROR)).toBe(true);
  });
});
