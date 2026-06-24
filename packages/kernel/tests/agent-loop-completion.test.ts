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
  LLMCallOptions,
  Task,
} from '@tik/shared';
import { generateId } from '@tik/shared';

describe('AgentLoop completion semantics', () => {
  it('passes the task project path to provider calls as cwd', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
    let observedOptions: LLMCallOptions | undefined;

    const llm: ILLMProvider = {
      name: 'mock',
      async chatWithContext(_messages, _systemPrompt, _context, _tools, options): Promise<ChatResponse> {
        observedOptions = options;
        return {
          content: '无需改代码。当前任务只验证 provider cwd 透传。',
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
    const contextBuilder = buildEmptyContextBuilder('/tmp/workspace/packages/api');
    const aceEngine = buildNoopAceEngine();
    const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine as any);
    const task = buildTask('/tmp/workspace/packages/api', 'Review API module');
    const session = buildSession(task, llm);

    await loop.run(task, session);

    expect(observedOptions?.cwd).toBe('/tmp/workspace/packages/api');
  });

  it('surfaces task restart context in the provider prompt even when a context renderer is used', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
    let observedContext = '';

    const llm: ILLMProvider = {
      name: 'mock',
      async chatWithContext(_messages, _systemPrompt, context): Promise<ChatResponse> {
        observedContext = context;
        return {
          content: '无需改代码。当前任务只验证重启上下文透传。',
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
    const contextBuilder = buildEmptyContextBuilder('/tmp/workspace/packages/api');
    const aceEngine = buildNoopAceEngine();
    const loop = new AgentLoop(
      eventBus,
      toolScheduler,
      contextBuilder,
      llm,
      aceEngine as any,
      undefined,
      { render: () => '# Rendered Context' },
    );
    const task = {
      ...buildTask('/tmp/workspace/packages/api', 'Handle TIK-85 follow-up'),
      taskContextSnapshot: {
        taskId: 'task-mqhs9xfq-42ci',
        identifier: 'TIK-85',
        status: 'completed',
        title: 'Follow up after comment',
        goal: 'Handle the new operator comment',
        latestSummary: 'Previous run completed but had a tool warning.',
        lastAttempt: {
          attemptNumber: 2,
          startedAt: '2026-06-18T01:00:00.000Z',
          finishedAt: '2026-06-18T01:03:00.000Z',
          outcome: 'completed',
          error: 'tool unavailable',
          kernelTaskId: 'kernel-task-old',
        },
        recentComments: [{
          authorKind: 'human' as const,
          authorId: 'op',
          body: 'Please verify this comment was handled.',
          createdAt: '2026-06-18T01:04:00.000Z',
        }],
        timelineSummary: [
          '[2026-06-18T01:02:00.000Z] system/raw: Tool: bash\nError:\ntool unavailable',
        ],
        evidenceSummary: {
          rawEventCount: 2,
          modifiedFileCount: 1,
          previewableArtifactCount: 0,
          latestToolName: 'bash',
          hasErrorEvidence: true,
        },
      },
    };
    const session = buildSession(task, llm);

    await loop.run(task, session);

    expect(observedContext).toContain('# Rendered Context');
    expect(observedContext).toContain('# Task Restart Context');
    expect(observedContext).toContain('TIK-85');
    expect(observedContext).toContain('tool unavailable');
    expect(observedContext).toContain('Please verify this comment was handled.');
  });

  it('serializes tool calls after the first write in an LLM round', async () => {
    const eventBus = new EventBus();
    const toolRegistry = new ToolRegistry();
    const executionOrder: string[] = [];
    let readStartedBeforeWriteFinished = false;
    let writeHasFinished = false;
    let finishWrite!: () => void;
    const writeFinished = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });

    toolRegistry.register({
      name: 'read_file',
      description: 'Read a file',
      type: 'read',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(input: { path: string }) {
        executionOrder.push(`start:${input.path}`);
        readStartedBeforeWriteFinished = !writeHasFinished;
        executionOrder.push(`finish:${input.path}`);
        return {
          success: true,
          output: `read ${input.path}`,
          durationMs: 1,
        };
      },
    } as any);

    toolRegistry.register({
      name: 'write_file',
      description: 'Write a file',
      type: 'write',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      async execute(input: { path: string }) {
        executionOrder.push(`start:${input.path}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        executionOrder.push(`finish:${input.path}`);
        writeHasFinished = true;
        finishWrite();
        return {
          success: true,
          output: `wrote ${input.path}`,
          durationMs: 1,
          filesModified: [input.path],
        };
      },
    } as any);

    const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
    let calls = 0;
    const llm: ILLMProvider = {
      name: 'mock',
      async chatWithContext(): Promise<ChatResponse> {
        calls += 1;
        if (calls === 1) {
          return {
            content: 'Patch then inspect the patched file.',
            toolCalls: [
              { id: 'write-1', name: 'write_file', arguments: { path: 'src/app.ts', content: 'patched' } },
              { id: 'read-1', name: 'read_file', arguments: { path: 'src/app.test.ts' } },
            ],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          };
        }
        return {
          content: '已完成代码修改。',
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

    const task = buildTask('/tmp/workspace/packages/api', 'Implement API module patch');
    const session = buildSession(task, llm);
    const loop = new AgentLoop(
      eventBus,
      toolScheduler,
      buildEmptyContextBuilder(task.projectPath!),
      llm,
      buildNoopAceEngine() as any,
    );

    await loop.run(task, session);
    await writeFinished;

    expect(executionOrder).toEqual([
      'start:src/app.ts',
      'finish:src/app.ts',
      'start:src/app.test.ts',
      'finish:src/app.test.ts',
    ]);
    expect(readStartedBeforeWriteFinished).toBe(false);
  });

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

function buildEmptyContextBuilder(cwd: string): IContextBuilder {
  return {
    async buildContext() {
      return {} as any;
    },
    async buildFromSession() {
      return {
        bootstrap: { cwd, date: '2026-04-03', os: 'darwin' },
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
}

function buildNoopAceEngine() {
  return {
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
}

function buildTask(projectPath: string, description: string): Task {
  return {
    id: generateId(),
    description,
    status: 'pending',
    projectPath,
    iterations: [],
    maxIterations: 1,
    strategy: 'incremental',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function buildSession(task: Task, llm: ILLMProvider): AgentSession {
  return {
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
}
