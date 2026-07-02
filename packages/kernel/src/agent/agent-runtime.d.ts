/**
 * Agent Runtime (Phase 2.7)
 *
 * Wraps ILLMProvider with AgentSpec to create an executable agent.
 * Implements the AgentRuntime interface from @tik/shared for compatibility.
 */
import type { ChatMessage, ChatResponse, ILLMProvider, LLMToolDef, LLMCallOptions, AgentRuntime as IAgentRuntime } from '@tik/shared';
import type { AgentSpec } from './agent-spec.js';
import { type AgentInstalledSkillPromptSource } from './agent-skill-prompt-source.js';
/**
 * AgentRuntime binds an AgentSpec with an LLM provider.
 * Implements the legacy AgentRuntime interface for session compatibility.
 */
export declare class AgentRuntime implements IAgentRuntime {
    readonly spec: AgentSpec;
    private readonly options;
    /** Role identifier (from interface) */
    readonly role: IAgentRuntime['role'];
    /** LLM provider (from interface) */
    readonly llm: ILLMProvider;
    private effectiveInstructions?;
    constructor(spec: AgentSpec, llm: ILLMProvider, options?: {
        skillPromptSource?: AgentInstalledSkillPromptSource;
    });
    /** System prompt (from interface) */
    get systemPrompt(): string;
    /**
     * Run a single turn of agent execution.
     * Handles both chatWithContext and fallback to chat.
     */
    runTurn(input: {
        messages: ChatMessage[];
        context: string;
        tools?: LLMToolDef[];
        options?: LLMCallOptions;
    }): Promise<ChatResponse>;
    /**
     * Get the agent's ID.
     */
    get id(): string;
    private getEffectiveInstructions;
}
//# sourceMappingURL=agent-runtime.d.ts.map