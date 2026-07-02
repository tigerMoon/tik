import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { generateId } from '@tik/shared';
import { AgentLoop } from '../src/agent-loop.js';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';
describe('provider tool schema conversion', () => {
    it('preserves enum, union, array, and object details in provider tool schemas', async () => {
        const eventBus = new EventBus();
        const registry = new ToolRegistry();
        const complexTool = {
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
        let observedSchema;
        const llm = {
            name: 'test',
            async chatWithContext(_messages, _systemPrompt, _context, tools) {
                observedSchema = tools?.find((tool) => tool.name === 'complex_tool')?.inputSchema;
                return {
                    content: 'No changes needed.',
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
                    bootstrap: { cwd: '/tmp', date: '2026-06-23', os: 'darwin' },
                    execution: { repo: {}, spec: {}, run: {}, memory: {} },
                    conversation: { messages: [], summary: '' },
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
        const loop = new AgentLoop(eventBus, new ToolScheduler(registry, eventBus), contextBuilder, llm, aceEngine);
        const agentSpec = {
            id: 'schema-coder',
            role: 'coder',
            instructions: 'Inspect schemas.',
            allowedTools: ['complex_tool'],
        };
        const task = {
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
//# sourceMappingURL=provider-tool-schema.test.js.map