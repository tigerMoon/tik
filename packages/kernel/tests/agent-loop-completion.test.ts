import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/agent-loop.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';
import type {
  AgentSession,
  ChatResponse,
  EvaluationSnapshot,
  IContextBuilder,
  ILLMProvider,
  Task,
} from '@tik/shared';
import { generateId } from '@tik/shared';

describe('AgentLoop completion semantics', () => {
  it('marks implementation tasks completed when assistant explicitly concludes no code change is needed', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);

    const llm: ILLMProvider = {
      name: 'mock',
      async chatWithContext(): Promise<ChatResponse> {
        return {
          content: '无需改代码。当前仅用于验证实现类任务在明确说明无需变更时可以正常完成。',
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
          bootstrap: { cwd: '/tmp', date: '2026-04-03', os: 'darwin' },
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
      toolScheduler,
      contextBuilder,
      llm,
      aceEngine as any,
    );

    const task: Task = {
      id: generateId(),
      description: '我想针对票务业务的查询接口做缓存，one-api目录',
      status: 'pending',
      iterations: [],
      maxIterations: 1,
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
          llm,
        },
      },
      currentAgent: 'coder',
      step: 0,
    };

    const result = await loop.run(task, session);
    expect(result.status).toBe('completed');
  });

  it('forces implementation tasks out of repeated read-only exploration before completing', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'read_file',
      description: 'Read a file',
      type: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async ({ path }: { path: string }) => ({
        content: `contents of ${path}`,
      }),
    } as any);

    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);

    let call = 0;
    const llm: ILLMProvider = {
      name: 'mock',
      async chatWithContext(): Promise<ChatResponse> {
        call += 1;
        if (call === 1) {
          return {
            content: '先读取关键缓存实现文件。',
            toolCalls: [
              {
                id: 'call-1',
                name: 'read_file',
                arguments: { path: 'catalog-suite-one-api/src/main/java/com/example/CacheService.java' },
              },
            ],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        }

        if (call === 2) {
          return {
            content: '再读取同一个文件确认一下。',
            toolCalls: [
              {
                id: 'call-2',
                name: 'read_file',
                arguments: { path: 'catalog-suite-one-api/src/main/java/com/example/CacheService.java' },
              },
            ],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        }

        return {
          content: '无需改代码。目标缓存逻辑已经存在，当前没有待处理改动。',
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
          bootstrap: { cwd: '/tmp', date: '2026-04-03', os: 'darwin' },
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
      llm,
      aceEngine as any,
    );

    const task: Task = {
      id: generateId(),
      description: '我想针对票务业务的查询接口做缓存，one-api目录',
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
          llm,
        },
      },
      currentAgent: 'coder',
      step: 0,
    };

    const result = await loop.run(task, session);
    expect(result.status).toBe('completed');
    expect(result.totalIterations).toBe(1);
  });

  it('stops after one delegated codex iteration instead of opening another outer loop iteration', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);

    let calls = 0;
    const llm: ILLMProvider = {
      name: 'codex-delegate',
      async chatWithContext(): Promise<ChatResponse> {
        calls += 1;
        return {
          content: '已完成代码修改，并完成委托执行。',
          executedActions: [
            {
              tool: 'write_file',
              input: { path: 'catalog-suite-application/src/main/java/com/example/TicketCacheService.java' },
              success: true,
            },
          ],
          usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
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
          bootstrap: { cwd: '/tmp', date: '2026-04-03', os: 'darwin' },
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
          fitness: 0.3,
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
      llm,
      aceEngine as any,
    );

    const task: Task = {
      id: generateId(),
      description: '我想针对票务业务的查询接口做缓存，one-api目录',
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
          llm,
        },
      },
      currentAgent: 'coder',
      step: 0,
    };

    const result = await loop.run(task, session);
    expect(result.status).toBe('completed');
    expect(result.totalIterations).toBe(1);
    expect(calls).toBe(1);
  });
});
