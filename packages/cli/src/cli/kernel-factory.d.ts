import * as TikKernel from '@tik/kernel';
import { ACEEngine } from '@tik/ace';
import { SIGHTRuntime } from '@tik/sight';
import type { ProviderOption } from '../types.js';
import { ClaudeLLMProvider } from '../commands/claude-llm.js';
import { CodexCliProvider } from '../commands/codex-cli.js';
import { MockLLMProvider } from '../commands/mock-llm.js';
import { OpenAILLMProvider } from '../commands/openai-llm.js';
export declare function createKernel(projectPath: string, options?: {
    provider?: ProviderOption;
    model?: string;
    stream?: boolean;
}): {
    kernel: TikKernel.ExecutionKernel;
    sight: SIGHTRuntime;
    ace: ACEEngine;
    llmName: string;
    provider: ProviderOption;
    llm: ClaudeLLMProvider | CodexCliProvider | MockLLMProvider | OpenAILLMProvider;
};
//# sourceMappingURL=kernel-factory.d.ts.map