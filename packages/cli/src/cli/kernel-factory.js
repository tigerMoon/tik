import * as TikKernel from '@tik/kernel';
import { ACEEngine } from '@tik/ace';
import { ContextRenderer, SIGHTRuntime, ToolResultStore } from '@tik/sight';
import { ClaudeLLMProvider } from '../commands/claude-llm.js';
import { CodexCliProvider } from '../commands/codex-cli.js';
import { MockLLMProvider } from '../commands/mock-llm.js';
import { OpenAILLMProvider } from '../commands/openai-llm.js';
import { resolveProvider } from './provider-resolution.js';
const { ExecutionKernel, builtinTools, frontendTools, gitTools, searchEditTools, } = TikKernel;
export function createKernel(projectPath, options) {
    const sight = new SIGHTRuntime({ projectPath });
    const renderer = new ContextRenderer();
    const toolStore = new ToolResultStore(projectPath);
    const provider = resolveProvider(options?.provider);
    const llm = provider === 'claude'
        ? new ClaudeLLMProvider(options?.model)
        : provider === 'openai'
            ? new OpenAILLMProvider(options?.model)
            : provider === 'codex'
                ? new CodexCliProvider(projectPath, options?.model, 'governed')
                : provider === 'codex-delegate'
                    ? new CodexCliProvider(projectPath, options?.model, 'delegate')
                    : new MockLLMProvider();
    const onStreamChunk = options?.stream
        ? (chunk, _meta) => {
            process.stdout.write(chunk);
        }
        : undefined;
    const kernel = new ExecutionKernel({
        llm,
        contextBuilder: sight.contextEngine,
        sight,
        projectPath,
        contextRenderer: renderer,
        toolResultStore: toolStore,
        onStreamChunk,
        ace: new ACEEngine('incremental'),
    });
    const ace = new ACEEngine('incremental', kernel.eventBus);
    kernel.ace = ace;
    for (const tool of [...builtinTools, ...frontendTools, ...gitTools, ...searchEditTools]) {
        kernel.toolRegistry.register(tool);
    }
    return { kernel, sight, ace, llmName: llm.name, provider, llm };
}
//# sourceMappingURL=kernel-factory.js.map