import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../src/agent-loop.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';
import { generateId } from '@tik/shared';
describe('AgentLoop completion semantics', () => {
    it('passes the task project path to provider calls as cwd', async () => {
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        let observedOptions;
        const llm = {
            name: 'mock',
            async chatWithContext(_messages, _systemPrompt, _context, _tools, options) {
                observedOptions = options;
                return {
                    content: '无需改代码。当前任务只验证 provider cwd 透传。',
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                };
            },
            async chat() {
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
        const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine);
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
        const llm = {
            name: 'mock',
            async chatWithContext(_messages, _systemPrompt, context) {
                observedContext = context;
                return {
                    content: '无需改代码。当前任务只验证重启上下文透传。',
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                };
            },
            async chat() {
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
        const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine, undefined, { render: () => '# Rendered Context' });
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
                        authorKind: 'human',
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
        const executionOrder = [];
        let readStartedBeforeWriteFinished = false;
        let writeHasFinished = false;
        let finishWrite;
        const writeFinished = new Promise((resolve) => {
            finishWrite = resolve;
        });
        toolRegistry.register({
            name: 'read_file',
            description: 'Read a file',
            type: 'read',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            async execute(input) {
                executionOrder.push(`start:${input.path}`);
                readStartedBeforeWriteFinished = !writeHasFinished;
                executionOrder.push(`finish:${input.path}`);
                return {
                    success: true,
                    output: `read ${input.path}`,
                    durationMs: 1,
                };
            },
        });
        toolRegistry.register({
            name: 'write_file',
            description: 'Write a file',
            type: 'write',
            inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
            async execute(input) {
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
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        let calls = 0;
        const llm = {
            name: 'mock',
            async chatWithContext() {
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
            async chat() {
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
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(task.projectPath), llm, buildNoopAceEngine());
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
        const llm = {
            name: 'mock',
            async chatWithContext() {
                return {
                    content: '无需改代码。当前仅用于验证实现类任务在明确说明无需变更时可以正常完成。',
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                };
            },
            async chat() {
                throw new Error('not used');
            },
            async plan() {
                throw new Error('not used');
            },
            async complete() {
                throw new Error('not used');
            },
        };
        const contextBuilder = {
            async buildContext() {
                return {};
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
                };
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
                };
            },
            checkConvergence() {
                return false;
            },
        };
        const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine);
        const task = {
            id: generateId(),
            description: '我想针对票务业务的查询接口做缓存，one-api目录',
            status: 'pending',
            iterations: [],
            maxIterations: 1,
            strategy: 'incremental',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const session = {
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
    it('runs the project harness before completing implementation changes', async () => {
        const projectPath = await makeProjectWithHarness(['pnpm test -- changed.spec.ts']);
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: true, output: { stdout: 'ok', stderr: '' }, durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
                {
                    tool: 'bash',
                    input: { command: 'rg "cache" src/service.ts' },
                    output: 'matches',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['pnpm test -- changed.spec.ts']);
        expect(result.status).toBe('completed');
    });
    it('runs configured project harness even after agent-supplied validation passes', async () => {
        const projectPath = await makeProjectWithHarness(['pnpm test -- full-suite']);
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: true, output: { stdout: 'ok', stderr: '' }, durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改，并运行了相关测试。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
                {
                    tool: 'bash',
                    input: { command: 'pnpm test -- changed.spec.ts' },
                    output: 'passed',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['pnpm test -- full-suite']);
        expect(result.status).toBe('completed');
    });
    it('runs every configured project harness command before completing implementation changes', async () => {
        const projectPath = await makeProjectWithHarness(['pnpm typecheck', 'pnpm test -- changed.spec.ts']);
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: true, output: { stdout: 'ok', stderr: '' }, durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['pnpm typecheck', 'pnpm test -- changed.spec.ts']);
        expect(result.status).toBe('completed');
    });
    it('uses the package manager declared by the project for default harness commands', async () => {
        const projectPath = await makeProjectWithPackageJson({
            packageManager: 'pnpm@8.15.0',
            scripts: { test: 'vitest run' },
        });
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: true, output: { stdout: 'ok', stderr: '' }, durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['corepack pnpm test']);
        expect(result.status).toBe('completed');
    });
    it('runs default npm package scripts through npm run', async () => {
        const projectPath = await makeProjectWithPackageJson({
            packageManager: 'npm@10.5.0',
            scripts: { typecheck: 'tsc --noEmit' },
        });
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: true, output: { stdout: 'ok', stderr: '' }, durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['npm run typecheck']);
        expect(result.status).toBe('completed');
    });
    it('does not complete implementation changes when the project harness fails', async () => {
        const projectPath = await makeProjectWithHarness(['pnpm test -- changed.spec.ts']);
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        const harnessCommands = [];
        toolRegistry.register({
            name: 'bash',
            description: 'Execute a shell command',
            type: 'exec',
            inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
            async execute(input) {
                harnessCommands.push(input.command);
                return { success: false, output: { stdout: '', stderr: 'failed' }, error: 'failed', durationMs: 1 };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        const llm = buildSingleTurnLlm({
            content: '我已经完成代码修改。',
            executedActions: [
                {
                    tool: 'edit_file',
                    input: { path: 'src/service.ts' },
                    output: 'patched',
                    success: true,
                },
            ],
        });
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(harnessCommands).toEqual(['pnpm test -- changed.spec.ts']);
        expect(result.status).not.toBe('completed');
    });
    it('does not require inferred harness validation when the runtime has no exec tool', async () => {
        const projectPath = await makeProjectWithPackageJson({
            packageManager: 'pnpm@8.15.0',
            scripts: { test: 'vitest run' },
        });
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        toolRegistry.register({
            name: 'write_file',
            description: 'Write a file',
            type: 'write',
            inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
            async execute(input) {
                return {
                    success: true,
                    output: { path: input.path, bytes: input.content.length },
                    durationMs: 1,
                };
            },
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        let calls = 0;
        const llm = {
            name: 'mock',
            async chatWithContext() {
                calls += 1;
                if (calls === 1) {
                    return {
                        content: '我会先写入代码修改。',
                        toolCalls: [
                            {
                                id: 'write-1',
                                name: 'write_file',
                                arguments: { path: 'src/service.ts', content: 'patched' },
                            },
                        ],
                        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    };
                }
                return {
                    content: '我已经完成代码修改。',
                    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                };
            },
            async chat() {
                throw new Error('not used');
            },
            async plan() {
                throw new Error('not used');
            },
            async complete() {
                throw new Error('not used');
            },
        };
        const task = buildTask(projectPath, '实现服务缓存');
        const session = buildSession(task, llm);
        const loop = new AgentLoop(eventBus, toolScheduler, buildEmptyContextBuilder(projectPath), llm, buildNoopAceEngine());
        const result = await loop.run(task, session);
        expect(result.status).toBe('completed');
        expect(task.iterations[0]?.executedActions.map((action) => action.tool)).toEqual(['write_file']);
    });
    it('forces implementation tasks out of repeated read-only exploration before completing', async () => {
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        toolRegistry.register({
            name: 'read_file',
            description: 'Read a file',
            type: 'read',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            execute: async ({ path }) => ({
                content: `contents of ${path}`,
            }),
        });
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        let call = 0;
        const llm = {
            name: 'mock',
            async chatWithContext() {
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
            async chat() {
                throw new Error('not used');
            },
            async plan() {
                throw new Error('not used');
            },
            async complete() {
                throw new Error('not used');
            },
        };
        const contextBuilder = {
            async buildContext() {
                return {};
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
                };
            },
        };
        const aceEngine = {
            async evaluateIteration() {
                return {
                    fitness: 0.2,
                    drift: 0,
                    entropy: 0,
                    converged: false,
                    stableCount: 0,
                    breakdown: [],
                };
            },
            checkConvergence() {
                return false;
            },
        };
        const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine);
        const task = {
            id: generateId(),
            description: '我想针对票务业务的查询接口做缓存，one-api目录',
            status: 'pending',
            iterations: [],
            maxIterations: 3,
            strategy: 'incremental',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const session = {
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
        const llm = {
            name: 'codex-delegate',
            async chatWithContext() {
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
            async chat() {
                throw new Error('not used');
            },
            async plan() {
                throw new Error('not used');
            },
            async complete() {
                throw new Error('not used');
            },
        };
        const contextBuilder = {
            async buildContext() {
                return {};
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
                };
            },
        };
        const aceEngine = {
            async evaluateIteration() {
                return {
                    fitness: 0.3,
                    drift: 0,
                    entropy: 0,
                    converged: false,
                    stableCount: 0,
                    breakdown: [],
                };
            },
            checkConvergence() {
                return false;
            },
        };
        const loop = new AgentLoop(eventBus, toolScheduler, contextBuilder, llm, aceEngine);
        const task = {
            id: generateId(),
            description: '我想针对票务业务的查询接口做缓存，one-api目录',
            status: 'pending',
            iterations: [],
            maxIterations: 3,
            strategy: 'incremental',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        const session = {
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
function buildEmptyContextBuilder(cwd) {
    return {
        async buildContext() {
            return {};
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
            };
        },
    };
}
function buildNoopAceEngine() {
    return {
        async evaluateIteration() {
            return {
                fitness: 0.1,
                drift: 0,
                entropy: 0,
                converged: false,
                stableCount: 0,
                breakdown: [],
            };
        },
        checkConvergence() {
            return false;
        },
    };
}
async function makeProjectWithHarness(commands) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-harness-'));
    await fs.mkdir(path.join(root, '.tik'), { recursive: true });
    await fs.writeFile(path.join(root, '.tik', 'harness.json'), JSON.stringify({ commands }, null, 2), 'utf-8');
    return root;
}
async function makeProjectWithPackageJson(packageJson) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-package-harness-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');
    return root;
}
function buildSingleTurnLlm(response) {
    return {
        name: 'mock',
        async chatWithContext() {
            return {
                ...response,
                usage: response.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            };
        },
        async chat() {
            throw new Error('not used');
        },
        async plan() {
            throw new Error('not used');
        },
        async complete() {
            throw new Error('not used');
        },
    };
}
function buildTask(projectPath, description) {
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
function buildSession(task, llm) {
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
//# sourceMappingURL=agent-loop-completion.test.js.map