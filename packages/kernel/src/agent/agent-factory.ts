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
export class AgentFactory {
  constructor(
    private registry: AgentRegistry,
    private llmFactory: () => ILLMProvider,
    private readonly options: {
      skillPromptSource?: AgentInstalledSkillPromptSource;
    } = {},
  ) {}

  /**
   * Create an AgentRuntime for the specified agent ID.
   * Throws if the agent is not registered.
   */
  create(id: string): AgentRuntime {
    const spec = this.registry.get(id);
    const llm = this.llmFactory();
    return new AgentRuntime(spec, llm, {
      skillPromptSource: this.options.skillPromptSource,
    });
  }

  /**
   * Check if an agent can be created.
   */
  canCreate(id: string): boolean {
    return this.registry.has(id);
  }
}
