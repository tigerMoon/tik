import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ChatResponse, IContextBuilder, ILLMProvider, Task, Tool } from '@tik/shared';
import { generateId } from '@tik/shared';
import { AgentLoop } from '../src/agent-loop.js';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import type { AgentSpec } from '../src/agent/agent-spec.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';

describe('provider tool schema conversion', () => {
  it('preserves enum, union, array, and object details in provider tool schemas', async () => {
    const eventBus = new EventBus();
    const registry = new ToolRegistry();
    const complexTool: Tool = {
      name: 'complex_tool',
      type: 'read',
      description: 'Tool with nested schema',
      inputSchema: z.object({
        mode: z.enum(['fast', 'safe']),
        target: z.union([z.string(), z.object({ path: z.string(), line: z.number().optional() })]),
        patches: z.array(z.object({
          file: z.string(),
          hunks: z.array(z.object({
            oldText: z.string(),
            newText: z.string(),
          })),
        })),
      }),
      async execute() {
        return { success: true, output: 'ok', durationMs: 1 };
      },
    };
    registry.register(complexTool);

    let observedSchema: Record<string, unknown> | undefined;
    const llm: ILLMProvider = {
      name: 'test',
      async chatWithContext(_messages, _systemPrompt, _context, tools): Promise<ChatResponse> {
        observedSchema = tools?.find((tool) => tool.name === 'complex_tool')?.inputSchema;
        return {
          content: 'No changes needed.',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('not used');
      },
      async plan() {
        throw new Error('not used');
      },
      async complete() {
        throw new Error('not used');
      },
    };

    const contextBuilder: IContextBuilder = {
      async buildContext() {
        return {} as any;
      },
      async buildFromSession() {
        return {
          bootstrap: { cwd: '/tmp', date: '2026-06-23', os: 'darwin' },
          execution: { repo: {}, spec: {}, run: {}, memory: {} },
          conversation: { messages: [], summary: '' },
        } as any;
      },
    };
    const aceEngine = {
      async evaluateIteration() {
        return {
          fitness: 0.1,
          drift: 0,
          entropy: 0,
          converged: false,
          stableCount: 0,
          breakdown: [],
        } as any;
      },
      checkConvergence() {
        return false;
      },
    };
    const loop = new AgentLoop(
      eventBus,
      new ToolScheduler(registry, eventBus),
      contextBuilder,
      llm,
      aceEngine as any,
    );
    const agentSpec: AgentSpec = {
      id: 'schema-coder',
      role: 'coder',
      instructions: 'Inspect schemas.',
      allowedTools: ['complex_tool'],
    };
    const task: Task = {
      id: generateId(),
      description: 'Review provider schema fidelity',
      status: 'pending',
      iterations: [],
      maxIterations: 1,
      strategy: 'incremental',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectPath: '/tmp',
    };

    await loop.run(task, {
      sessionId: generateId(),
      taskId: task.id,
      messages: [{ role: 'user', content: `Task: ${task.description}` }],
      loopState: 'running',
      mode: 'single',
      agents: {
        coder: new AgentRuntime(agentSpec, llm),
      },
      currentAgent: 'coder',
      step: 0,
    });

    expect(observedSchema).toMatchObject({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'] },
        target: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                path: { type: 'string' },
                line: { type: 'number' },
              },
              required: ['path'],
            },
          ],
        },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              hunks: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    oldText: { type: 'string' },
                    newText: { type: 'string' },
                  },
                  required: ['oldText', 'newText'],
                },
              },
            },
            required: ['file', 'hunks'],
          },
        },
      },
      required: ['mode', 'target', 'patches'],
    });
  });
});
