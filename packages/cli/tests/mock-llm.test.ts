import { describe, expect, it } from 'vitest';
import { generateId } from '@tik/shared';
import type {
  AgentSession,
  EvaluationSnapshot,
  IContextBuilder,
  Task,
} from '@tik/shared';
import { AgentLoop } from '@tik/kernel';
import { EventBus, ToolRegistry, ToolScheduler } from '@tik/kernel';
import { MockLLMProvider } from '../src/commands/mock-llm.js';

describe('MockLLMProvider.complete', () => {
  it('emits a high-risk bash plan action for publish-style tasks so approval flows can be exercised in the main runtime path', async () => {
    const provider = new MockLLMProvider();
    const response = await provider.plan(
      [
        'Task: 发布一个版本: 执行 publish dry run',
        'Iteration: 1/5',
        'Strategy: incremental',
        '',
        'Generate a plan with specific tool actions.',
      ].join('\n'),
      '{}',
    );

    expect(response.actions[0]).toMatchObject({
      tool: 'bash',
      input: {
        command: 'echo publish dry-run',
      },
    });
  });

  it('emits a task-shaped write plan for design-style implementation prompts', async () => {
    const provider = new MockLLMProvider();
    const response = await provider.plan(
      [
        'Task: 设计一个贪吃蛇的游戏: H5 页面，可以玩耍',
        'Iteration: 1/5',
        'Strategy: incremental',
        '',
        'Generate a plan with specific tool actions.',
      ].join('\n'),
      '{}',
    );

    expect(response.actions[1]).toMatchObject({
      tool: 'write_file',
      input: {
        path: 'src/mock-app.html',
      },
    });
  });

  it('returns a valid workspace spec markdown body for document materialization prompts', async () => {
    const provider = new MockLLMProvider();
    const content = await provider.complete([
      'Return ONLY the final markdown body for the target spec document.',
      'Target spec path: /tmp/demo/.specify/specs/feature-a/spec.md',
      'Demand: 让 greet(name) 对空字符串回退为 Guest',
    ].join('\n'));

    expect(content).toContain('# Goal');
    expect(content).toContain('# Acceptance Criteria');
    expect(content).toContain('Demand: 让 greet(name) 对空字符串回退为 Guest');
    expect(content.length).toBeGreaterThan(160);
  });

  it('returns a valid workspace plan markdown body for document materialization prompts', async () => {
    const provider = new MockLLMProvider();
    const content = await provider.complete([
      'Return ONLY the final markdown body for the target plan document.',
      'Resolved spec path: /tmp/demo/.specify/specs/feature-a/spec.md',
      'Target plan path: /tmp/demo/.specify/specs/feature-a/plan.md',
      'Demand: 让 greet(name) 对空字符串回退为 Guest',
    ].join('\n'));

    expect(content).toContain('# Architecture Changes');
    expect(content).toContain('# Rollout Notes');
    expect(content).toContain('/tmp/demo/.specify/specs/feature-a/spec.md');
    expect(content.length).toBeGreaterThan(160);
    expect(content).not.toContain('{feature}');
  });

  it('drives session-based implementation tasks to completed instead of failed', async () => {
    const provider = new MockLLMProvider();
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();

    toolRegistry.register({
      name: 'read_file',
      description: 'Read a file',
      type: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } } as any,
      async execute({ path }: { path: string }) {
        return {
          success: true,
          output: { path, content: '{"name":"tik"}' },
          durationMs: 1,
        };
      },
    } as any);

    toolRegistry.register({
      name: 'write_file',
      description: 'Write a file',
      type: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      } as any,
      async execute({ path, content }: { path: string; content: string }) {
        return {
          success: true,
          output: { path, bytes: content.length },
          durationMs: 1,
        };
      },
    } as any);

    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
    const contextBuilder: IContextBuilder = {
      async buildContext() {
        return {} as any;
      },
      async buildFromSession() {
        return {
          bootstrap: { cwd: '/tmp', date: '2026-04-09', os: 'darwin' },
          execution: {
            repo: {},
            spec: {},
            run: {},
            memory: {},
          },
          conversation: {
            messages: [],
            summary: '',
          },
        } as any;
      },
    };

    const aceEngine = {
      async evaluateIteration(): Promise<EvaluationSnapshot> {
        return {
          fitness: 0.2,
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
      toolScheduler,
      contextBuilder,
      provider,
      aceEngine as any,
    );

    const task: Task = {
      id: generateId(),
      description: '实现一个简单的 hello world 页面',
      status: 'pending',
      iterations: [],
      maxIterations: 3,
      strategy: 'incremental',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const session: AgentSession = {
      sessionId: generateId(),
      taskId: task.id,
      messages: [{ role: 'user', content: `Task: ${task.description}` }],
      loopState: 'running',
      mode: 'single',
      agents: {
        coder: {
          role: 'coder',
          systemPrompt: 'coder',
          llm: provider,
        },
      },
      currentAgent: 'coder',
      step: 0,
    };

    const result = await loop.run(task, session);
    expect(result.status).toBe('completed');
  });

  it('treats design-a-game phrasing as implementation in session mode', async () => {
    const provider = new MockLLMProvider();
    const response = await provider.chatWithContext?.(
      [
        { role: 'user', content: 'Task: 设计一个贪吃蛇的游戏: H5 页面，可以玩耍' },
        { role: 'tool', name: 'read_file', toolCallId: 'call-1', content: '{"name":"tik"}' },
      ],
      'coder',
      '{}',
      [
        { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
        { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
      ],
    );

    expect(response?.toolCalls?.[0]?.name).toBe('write_file');
  });

  it('emits a high-risk bash tool call for publish-style requests so approval flows can be exercised', async () => {
    const provider = new MockLLMProvider();
    const response = await provider.chatWithContext?.(
      [
        { role: 'user', content: 'Task: 发布一个版本，先做 publish dry run' },
      ],
      'coder',
      '{}',
      [
        { name: 'bash', description: 'bash', inputSchema: { type: 'object' } },
      ],
    );

    expect(response?.toolCalls?.[0]?.name).toBe('bash');
    expect(response?.toolCalls?.[0]?.arguments).toMatchObject({
      command: 'echo publish dry-run',
    });
  });
});
