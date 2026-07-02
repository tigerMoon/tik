import type { ProviderOption } from '../types.js';
export declare const interactiveProviderHelp = "LLM provider (default: codex): auto, claude, openai, codex (governed implementation), codex-delegate (delegated subtask execution), mock";
export declare const planningProviderHelp = "LLM provider (default: codex): auto, claude, openai, codex, mock";
export declare const serverProviderHelp = "LLM provider (default: codex): auto, claude, openai, codex, mock";
export declare function resolveProvider(provider?: ProviderOption): ProviderOption;
//# sourceMappingURL=provider-resolution.d.ts.map