import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@tik/shared';
import { AgentLoop } from '../src/agent-loop.js';
import { AgentRuntime } from '../src/agent/agent-runtime.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry, ToolScheduler } from '../src/tool-scheduler.js';
import { selectCoderAgentId } from '../src/agent/coder-routing.js';
import { frontendBrowserScreenshotTool, frontendProjectInfoTool, } from '../src/tools-frontend.js';
const tempDirs = [];
async function makeFrontendRepo() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tik-frontend-coder-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'pages'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'styles'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'frontend-app',
        scripts: {
            dev: 'vite',
            build: 'tsc -b && vite build',
            test: 'vitest run',
            lint: 'eslint .',
        },
        dependencies: {
            react: '^18.3.0',
            'react-dom': '^18.3.0',
        },
        devDependencies: {
            vite: '^6.0.0',
            vitest: '^2.0.0',
            tailwindcss: '^4.0.0',
        },
    }, null, 2), 'utf-8');
    await fs.writeFile(path.join(root, 'vite.config.ts'), 'export default {};\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export function App() { return <div>Hello</div>; }\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src', 'components', 'Hero.tsx'), 'export function Hero() { return <section />; }\n', 'utf-8');
    await fs.writeFile(path.join(root, 'src', 'styles', 'app.css'), '.app { display: grid; }\n', 'utf-8');
    return root;
}
function createNoopTool(name, type) {
    return {
        name,
        type,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            return {
                success: true,
                output: `${name}-ok`,
                durationMs: 1,
            };
        },
    };
}
afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
describe('frontend coder routing and tooling', () => {
    it('routes frontend implementation tasks to frontend-coder when the project has strong frontend signals', async () => {
        const root = await makeFrontendRepo();
        expect(selectCoderAgentId('实现首页 Hero 区块的响应式布局和样式修复', root)).toBe('frontend-coder');
        expect(selectCoderAgentId('给订单查询接口增加缓存', root)).toBe('coder');
    });
    it('frontend_project_info detects framework, scripts, entrypoints, and component roots', async () => {
        const root = await makeFrontendRepo();
        const result = await frontendProjectInfoTool.execute({}, {
            cwd: root,
            taskId: 'frontend-info-task',
        });
        expect(result.success).toBe(true);
        expect(result.output).toMatchObject({
            framework: 'react-vite',
            packageManager: 'unknown',
        });
        const output = result.output;
        expect(output.entrypoints).toContain(path.join(root, 'src', 'App.tsx'));
        expect(output.componentRoots).toContain(path.join(root, 'src', 'components'));
        expect(output.styleRoots).toContain(path.join(root, 'src', 'styles'));
        expect(output.scripts.dev).toBe('vite');
    });
    it('frontend-coder receives a frontend-focused tool set instead of the generic full tool registry', async () => {
        const root = await makeFrontendRepo();
        const eventBus = new EventBus();
        const toolRegistry = new ToolRegistry();
        for (const tool of [
            frontendProjectInfoTool,
            frontendBrowserScreenshotTool,
            createNoopTool('read_file', 'read'),
            createNoopTool('glob', 'read'),
            createNoopTool('grep', 'read'),
            createNoopTool('write_file', 'write'),
            createNoopTool('edit_file', 'write'),
            createNoopTool('bash', 'exec'),
            createNoopTool('git_status', 'read'),
            createNoopTool('git_diff', 'read'),
            createNoopTool('git_commit', 'exec'),
        ]) {
            toolRegistry.register(tool);
        }
        const toolScheduler = new ToolScheduler(toolRegistry, eventBus);
        let seenTools = [];
        const llm = {
            name: 'mock',
            async chatWithContext(_messages, _systemPrompt, _context, tools) {
                seenTools = (tools || []).map((tool) => tool.name);
                return {
                    content: '无需改代码。当前前端结构和样式边界已经满足需求。',
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
                    bootstrap: { cwd: root, date: '2026-04-07', os: 'darwin' },
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
        const frontendSpec = {
            id: 'frontend-coder',
            role: 'coder',
            instructions: 'frontend coder',
            allowedTools: [
                'frontend_project_info',
                'frontend_browser_screenshot',
                'read_file',
                'glob',
                'grep',
                'write_file',
                'edit_file',
                'bash',
                'git_status',
                'git_diff',
            ],
        };
        const task = {
            id: generateId(),
            description: '实现首页 Hero 区块的响应式布局和样式修复',
            status: 'pending',
            iterations: [],
            maxIterations: 1,
            strategy: 'incremental',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            projectPath: root,
        };
        const session = {
            sessionId: generateId(),
            taskId: task.id,
            messages: [{ role: 'user', content: `Task: ${task.description}` }],
            loopState: 'running',
            mode: 'single',
            agents: {
                coder: new AgentRuntime(frontendSpec, llm),
            },
            currentAgent: 'coder',
            step: 0,
        };
        const result = await loop.run(task, session);
        expect(result.status).toBe('completed');
        expect(seenTools).toContain('frontend_project_info');
        expect(seenTools).toContain('frontend_browser_screenshot');
        expect(seenTools).not.toContain('git_commit');
    });
});
//# sourceMappingURL=frontend-coder.test.js.map