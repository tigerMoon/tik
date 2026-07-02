/**
 * Agent Factory (Phase 2.7)
 *
 * Binds AgentSpec with ILLMProvider to create AgentRuntime instances.
 * Separates spec management (Registry) from runtime creation (Factory).
 */
import type { ILLMProvider } from '@tik/shared';
import type { AgentRegistry } from './agent-registry.js';
import { AgentRuntime } from './agent-runtime.js';
import type { AgentInstalledSkillPromptSource } from './agent-skill-prompt-source.js';
/**
 * Factory for creating AgentRuntime instances.
 * Takes specs from registry and binds them with LLM providers.
 */
export declare class AgentFactory {
    private registry;
    private llmFactory;
    private readonly options;
    constructor(registry: AgentRegistry, llmFactory: () => ILLMProvider, options?: {
        skillPromptSource?: AgentInstalledSkillPromptSource;
    });
    /**
     * Create an AgentRuntime for the specified agent ID.
     * Throws if the agent is not registered.
     */
    create(id: string): AgentRuntime;
    /**
     * Check if an agent can be created.
     */
    canCreate(id: string): boolean;
}
//# sourceMappingURL=agent-factory.d.ts.map