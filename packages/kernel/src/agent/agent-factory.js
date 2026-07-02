/**
 * Agent Factory (Phase 2.7)
 *
 * Binds AgentSpec with ILLMProvider to create AgentRuntime instances.
 * Separates spec management (Registry) from runtime creation (Factory).
 */
import { AgentRuntime } from './agent-runtime.js';
/**
 * Factory for creating AgentRuntime instances.
 * Takes specs from registry and binds them with LLM providers.
 */
export class AgentFactory {
    registry;
    llmFactory;
    options;
    constructor(registry, llmFactory, options = {}) {
        this.registry = registry;
        this.llmFactory = llmFactory;
        this.options = options;
    }
    /**
     * Create an AgentRuntime for the specified agent ID.
     * Throws if the agent is not registered.
     */
    create(id) {
        const spec = this.registry.get(id);
        const llm = this.llmFactory();
        return new AgentRuntime(spec, llm, {
            skillPromptSource: this.options.skillPromptSource,
        });
    }
    /**
     * Check if an agent can be created.
     */
    canCreate(id) {
        return this.registry.has(id);
    }
}
//# sourceMappingURL=agent-factory.js.map